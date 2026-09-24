// /webhook-whatsapp : mensagens recebidas no WhatsApp da Kedu.
//
// Aceita dois formatos:
//  A) Formato oficial da Meta (Cloud API), repassado pela plataforma de atendimento
//     ou apontado direto para cá: { object: "whatsapp_business_account", entry: [...] }
//  B) Formato genérico, para plataformas que transformam o payload:
//     { id, phone, name, text, timestamp, referral: { source_type, source_id, source_url, headline, ctwa_clid } }
//     (também aceita uma lista desses objetos)
//
// O ouro aqui é o "referral": quando a conversa começa por um anúncio de
// clique para WhatsApp, a Meta manda o ID do anúncio e o ctwa_clid.
import {
  checkSecret, db, env, json, markRaw, normalizePhone, readBody, resolveLead, saveRaw, str, toIso,
} from "../_shared/util.ts";

type Referral = {
  source_type?: string; source_id?: string; source_url?: string;
  headline?: string; body?: string; ctwa_clid?: string;
};
type Msg = { id: string; phone: string | null; name: string | null; text: string; timestamp: unknown; referral: Referral | null; raw: unknown };

const NOVA_CONVERSA_DIAS = Number(env("WA_NOVA_CONVERSA_DIAS", "7"));

function parse(body: any): Msg[] {
  const out: Msg[] = [];
  if (body?.object === "whatsapp_business_account" || Array.isArray(body?.entry)) {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const v = change.value ?? {};
        const names = new Map<string, string>();
        for (const c of v.contacts ?? []) names.set(c.wa_id, c.profile?.name);
        for (const m of v.messages ?? []) {
          out.push({
            id: m.id,
            phone: m.from,
            name: names.get(m.from) ?? null,
            text: m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ??
              m.interactive?.list_reply?.title ?? m.image?.caption ?? "",
            timestamp: m.timestamp,
            referral: m.referral ?? null,
            raw: { message: m, contacts: v.contacts, metadata: v.metadata },
          });
        }
      }
    }
    return out;
  }
  const list = Array.isArray(body) ? body : [body];
  for (const m of list) {
    if (!m) continue;
    out.push({
      id: String(m.id ?? m.message_id ?? `${m.phone}:${m.timestamp}`),
      phone: m.phone ?? m.from ?? m.telefone ?? null,
      name: m.name ?? m.nome ?? null,
      text: m.text ?? m.message ?? m.mensagem ?? "",
      timestamp: m.timestamp ?? m.date ?? null,
      referral: m.referral ?? null,
      raw: m,
    });
  }
  return out;
}

async function handle(m: Msg): Promise<string> {
  const rawId = await saveRaw("whatsapp", m.id, m.raw);
  if (!rawId) return "duplicado";
  try {
    const telefone = normalizePhone(m.phone);
    if (!telefone) { await markRaw(rawId, "ignorado", "sem telefone"); return "ignorado"; }

    // código ref colocado pelo site na mensagem pré-preenchida
    const refMatch = m.text.match(/\bref[\s:#-]*([A-Z0-9]{4,8})\b/i);
    let anonId: string | null = null;
    if (refMatch) {
      const { data } = await db.from("ref_codes").select("anon_id").eq("code", refMatch[1].toUpperCase()).maybeSingle();
      anonId = data?.anon_id ?? null;
    }

    const { data: known } = await db.from("identities").select("lead_id").eq("tipo", "telefone").eq("valor", telefone).maybeSingle();

    const leadId = await resolveLead([
      { tipo: "telefone", valor: telefone },
      { tipo: "anon", valor: anonId },
    ], str(m.name));

    // Só vira toque o que traz informação: anúncio, ref do site, contato novo
    // ou conversa retomada depois de alguns dias. O resto é conversa normal.
    const ref = m.referral;
    let registrar = !!ref || !!anonId || !known;
    if (!registrar) {
      const { data: last } = await db.from("touchpoints").select("occurred_at")
        .eq("lead_id", leadId).eq("tipo", "wa_message").order("occurred_at", { ascending: false }).limit(1).maybeSingle();
      const limite = Date.now() - NOVA_CONVERSA_DIAS * 86400000;
      registrar = !last || new Date(last.occurred_at).getTime() < limite;
    }
    if (!registrar) { await markRaw(rawId, "ignorado", "conversa em andamento"); return "ignorado"; }

    const isAd = ref?.source_type === "ad" && ref?.source_id;
    const adId = isAd ? `meta:${ref!.source_id}` : null;
    if (adId) {
      // cria o anúncio se ainda não existir; o sync de custos completa os nomes depois
      await db.from("ads").upsert({ ad_id: adId, plataforma: "meta", criativo: str(ref!.headline) },
        { onConflict: "ad_id", ignoreDuplicates: true });
    }

    const { error } = await db.from("touchpoints").insert({
      raw_event_id: rawId,
      lead_id: leadId,
      tipo: "wa_message",
      atribuivel: true,
      ad_id: adId,
      ctwa_clid: str(ref?.ctwa_clid),
      wa_source_type: str(ref?.source_type),
      wa_headline: str(ref?.headline),
      landing_page: str(ref?.source_url),
      occurred_at: toIso(m.timestamp),
    });
    if (error) throw new Error(error.message);

    await markRaw(rawId, "processado");
    return "processado";
  } catch (e) {
    console.error(e);
    await markRaw(rawId, "erro", e);
    return "erro";
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Verificação do webhook da Meta (caso aponte a Cloud API direto para cá)
  if (req.method === "GET") {
    if (url.searchParams.get("hub.mode") === "subscribe" &&
        url.searchParams.get("hub.verify_token") === env("WA_VERIFY_TOKEN")) {
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }

  if (!checkSecret(req)) return json({ error: "não autorizado" }, 401);
  const body = await readBody(req);
  const msgs = parse(body);
  const results = [];
  for (const m of msgs) results.push(await handle(m));
  // Sempre 200 para a plataforma não ficar reenviando; erros ficam em raw_events
  return json({ ok: true, recebidas: msgs.length, results });
});
