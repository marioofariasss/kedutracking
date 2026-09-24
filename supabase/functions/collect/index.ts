// /collect : recebe os eventos do script kedu-track.js instalado no site.
// Público (sem segredo), protegido por lista de origens permitidas.
import {
  buildAdId, db, env, json, markRaw, normalizeCnpj, normalizeEmail, normalizePhone,
  readBody, resolveLead, saveRaw, str, toIso,
} from "../_shared/util.ts";

type Touch = {
  id?: string; ts?: number; source?: string; medium?: string; campaign?: string; content?: string;
  term?: string; kt_ad?: string; gclid?: string; gbraid?: string; wbraid?: string; fbclid?: string;
  referrer?: string; landing?: string;
};

function cors(origin: string | null) {
  const allowed = env("ALLOWED_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = !allowed.length || (origin && allowed.some((a) => origin === a || origin.endsWith("." + a.replace(/^https?:\/\//, ""))));
  return {
    "Access-Control-Allow-Origin": ok && origin ? origin : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    ok: String(!!ok),
  };
}

function touchRow(t: Touch, anonId: string, rawId: string | null, extra: { fbp?: string; fbc?: string }) {
  return {
    client_touch_id: str(t.id),
    raw_event_id: rawId,
    anon_id: anonId,
    tipo: "visita",
    atribuivel: true,
    ad_id: buildAdId({
      source: t.source, gclid: t.gclid, gbraid: t.gbraid, wbraid: t.wbraid,
      fbclid: t.fbclid, kt_ad: t.kt_ad, utm_campaign: t.campaign,
    }),
    utm_source: str(t.source), utm_medium: str(t.medium), utm_campaign: str(t.campaign),
    utm_content: str(t.content), utm_term: str(t.term),
    gclid: str(t.gclid), gbraid: str(t.gbraid), wbraid: str(t.wbraid), fbclid: str(t.fbclid),
    fbp: str(extra.fbp), fbc: str(extra.fbc),
    referrer: str(t.referrer), landing_page: str(t.landing),
    occurred_at: toIso(t.ts),
  };
}

Deno.serve(async (req) => {
  const { ok, ...headers } = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ error: "use POST" }, 405, headers);
  if (ok !== "true") return json({ error: "origem não permitida" }, 403, headers);

  let rawId: string | null = null;
  try {
    const b = await readBody(req) as Record<string, any>;
    const anonId = str(b.anon_id);
    if (!anonId || !/^[a-zA-Z0-9-]{8,64}$/.test(anonId)) return json({ error: "anon_id inválido" }, 400, headers);

    rawId = await saveRaw("site", str(b.event_id), b);
    if (!rawId) return json({ ok: true, duplicado: true }, 200, headers);

    const extra = { fbp: b.fbp, fbc: b.fbc };

    // 1) toques de atribuição (novo, primeiro e último). Duplicados são ignorados pelo client_touch_id.
    const touches: Touch[] = [b.touch, b.first, b.last].filter((t) => t && t.id);
    const seen = new Set<string>();
    const rows = touches.filter((t) => !seen.has(t.id!) && seen.add(t.id!)).map((t) => touchRow(t, anonId, rawId, extra));
    if (rows.length) {
      const { error } = await db.from("touchpoints").upsert(rows, { onConflict: "client_touch_id", ignoreDuplicates: true });
      if (error) throw new Error(`touchpoints: ${error.message}`);
    }

    // 2) eventos que só aparecem na linha do tempo
    if (b.event === "form_submit" || b.event === "wa_click") {
      await db.from("touchpoints").insert({
        client_touch_id: str(b.event_id), raw_event_id: rawId, anon_id: anonId,
        tipo: b.event, atribuivel: false, landing_page: str(b.url), occurred_at: toIso(b.ts),
      });
    }

    // 3) código ref do WhatsApp
    if (b.event === "wa_click" && b.ref_code) {
      await db.from("ref_codes").upsert({ code: String(b.ref_code).toUpperCase(), anon_id: anonId });
    }

    // 4) identificação (formulário enviado no site)
    const id = b.identity ?? {};
    const telefone = normalizePhone(id.telefone);
    const email = normalizeEmail(id.email);
    const cnpj = normalizeCnpj(id.cnpj);
    let leadId: string | null = null;
    if (telefone || email || cnpj) {
      leadId = await resolveLead([
        { tipo: "anon", valor: anonId },
        { tipo: "telefone", valor: telefone },
        { tipo: "email", valor: email },
        { tipo: "cnpj", valor: cnpj },
      ], str(id.nome), str(id.escola));
    } else {
      // visitante que já é lead conhecido: liga o toque novo a ele
      const { data } = await db.from("identities").select("lead_id").eq("tipo", "anon").eq("valor", anonId).maybeSingle();
      if (data?.lead_id) {
        await db.from("touchpoints").update({ lead_id: data.lead_id }).is("lead_id", null).eq("anon_id", anonId);
        leadId = data.lead_id;
      }
    }

    await markRaw(rawId, "processado");
    return json({ ok: true, lead: !!leadId }, 200, headers);
  } catch (e) {
    console.error(e);
    await markRaw(rawId, "erro", e);
    return json({ error: "falha ao processar" }, 500, headers);
  }
});
