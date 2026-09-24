// /send-conversions : devolve ao Meta e ao Google as etapas que importam
// (ex: Qualificado, Agendado, Ganho), para os algoritmos otimizarem por
// escola boa, e não só por formulário preenchido.
// Quais etapas são enviadas é definido na tabela "etapas":
//   meta_evento          -> nome do evento no Meta (ex: QualifiedLead)
//   google_conversao_id  -> ID da ação de conversão no Google Ads
import { checkSecret, db, env, json, sha256 } from "../_shared/util.ts";
import { GADS_CID, googleAds, googleConfigured, metaSendEvents } from "../_shared/ads.ts";

const META_JANELA_DIAS = 7;    // o Meta só aceita eventos com até 7 dias
const GOOGLE_JANELA_DIAS = 60;

function googleDate(iso: string) {
  // Fortaleza não tem horário de verão: UTC-3 fixo
  const d = new Date(new Date(iso).getTime() - 3 * 3600000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 19)}-03:00`;
}

async function registrar(se: any, plataforma: string, evento: string, status: string, resposta: unknown) {
  await db.from("conversions_sent").upsert({
    stage_event_id: se.id, lead_id: se.lead_id, plataforma, evento, status, resposta,
  }, { onConflict: "stage_event_id,plataforma" });
}

async function dadosDoLead(leadId: string) {
  const { data: ids } = await db.from("identities").select("tipo,valor").eq("lead_id", leadId);
  const { data: tps } = await db.from("touchpoints")
    .select("ctwa_clid,fbc,fbp,gclid,gbraid,wbraid,occurred_at")
    .eq("lead_id", leadId).order("occurred_at", { ascending: false });
  const lista = (tps ?? []) as Record<string, string | null>[];
  const first = (k: string) => lista.find((t) => t[k])?.[k] ?? null;
  return {
    telefones: (ids ?? []).filter((i) => i.tipo === "telefone").map((i) => i.valor as string),
    emails: (ids ?? []).filter((i) => i.tipo === "email").map((i) => i.valor as string),
    ctwa_clid: first("ctwa_clid"), fbc: first("fbc"), fbp: first("fbp"),
    gclid: first("gclid"), gbraid: first("gbraid"), wbraid: first("wbraid"),
  };
}

async function enviarMeta(se: any, evento: string) {
  const d = await dadosDoLead(se.lead_id);
  const base = {
    event_name: evento,
    event_time: Math.floor(new Date(se.occurred_at).getTime() / 1000),
    event_id: se.id,
    custom_data: { event_source: "crm", lead_event_source: "Ploomes", etapa: se.etapa },
  };
  let ev: Record<string, unknown>;
  if (d.ctwa_clid && env("META_PAGE_ID")) {
    ev = { ...base, action_source: "business_messaging", messaging_channel: "whatsapp",
           user_data: { ctwa_clid: d.ctwa_clid, page_id: env("META_PAGE_ID") } };
  } else {
    const user_data: Record<string, unknown> = {};
    if (d.telefones.length) user_data.ph = await Promise.all(d.telefones.map((p) => sha256(p.replace(/\D/g, ""))));
    if (d.emails.length) user_data.em = await Promise.all(d.emails.map((e) => sha256(e)));
    if (d.fbc) user_data.fbc = d.fbc;
    if (d.fbp) user_data.fbp = d.fbp;
    if (!Object.keys(user_data).length) return registrar(se, "meta", evento, "sem_dados", null);
    user_data.external_id = [await sha256(se.lead_id)];
    ev = { ...base, action_source: "system_generated", user_data };
  }
  const r = await metaSendEvents([ev]);
  await registrar(se, "meta", evento, r.ok ? "enviado" : "erro", r.body);
}

async function enviarGoogle(se: any, conversaoId: string) {
  const d = await dadosDoLead(se.lead_id);
  const conv: Record<string, unknown> = {
    conversionAction: `customers/${GADS_CID()}/conversionActions/${conversaoId}`,
    conversionDateTime: googleDate(se.occurred_at),
    orderId: se.id,
  };
  if (d.gclid) conv.gclid = d.gclid;
  else if (d.gbraid) conv.gbraid = d.gbraid;
  else if (d.wbraid) conv.wbraid = d.wbraid;
  else {
    // Conversões otimizadas para leads: identifica pelo telefone/e-mail com hash
    const ui = [
      ...(await Promise.all(d.telefones.map(async (p) => ({ hashedPhoneNumber: await sha256(p) })))),
      ...(await Promise.all(d.emails.map(async (e) => ({ hashedEmail: await sha256(e) })))),
    ];
    if (!ui.length) return registrar(se, "google", conversaoId, "sem_dados", null);
    conv.userIdentifiers = ui.slice(0, 5);
  }
  const r = await googleAds(":uploadClickConversions", { conversions: [conv], partialFailure: true });
  const falhou = !r.ok || (r.body as any)?.partialFailureError;
  await registrar(se, "google", conversaoId, falhou ? "erro" : "enviado", r.body);
}

Deno.serve(async (req) => {
  if (!checkSecret(req)) return json({ error: "não autorizado" }, 401);

  const { data: etapas } = await db.from("etapas").select("nome,meta_evento,google_conversao_id")
    .or("meta_evento.not.is.null,google_conversao_id.not.is.null");
  if (!etapas?.length) return json({ ok: true, info: "nenhuma etapa configurada para envio" });
  const cfg = new Map(etapas.map((e) => [e.nome, e]));

  const desde = new Date(Date.now() - GOOGLE_JANELA_DIAS * 86400000).toISOString();
  const { data: eventos } = await db.from("stage_events").select("id,lead_id,etapa,occurred_at")
    .in("etapa", [...cfg.keys()]).gte("occurred_at", desde).order("occurred_at").limit(500);
  if (!eventos?.length) return json({ ok: true, enviados: 0 });

  const { data: ja } = await db.from("conversions_sent").select("stage_event_id,plataforma")
    .in("stage_event_id", eventos.map((e) => e.id));
  const feito = new Set((ja ?? []).map((c) => `${c.stage_event_id}|${c.plataforma}`));

  const limiteMeta = Date.now() - META_JANELA_DIAS * 86400000;
  const metaOk = !!(env("META_ACCESS_TOKEN") && env("META_DATASET_ID"));
  let enviados = 0;
  const erros: string[] = [];

  for (const se of eventos) {
    const c = cfg.get(se.etapa)!;
    try {
      if (c.meta_evento && metaOk && !feito.has(`${se.id}|meta`) && new Date(se.occurred_at).getTime() >= limiteMeta) {
        await enviarMeta(se, c.meta_evento); enviados++;
      }
      if (c.google_conversao_id && googleConfigured() && !feito.has(`${se.id}|google`)) {
        await enviarGoogle(se, c.google_conversao_id); enviados++;
      }
    } catch (e) {
      erros.push(`${se.id}: ${(e as Error).message}`);
    }
  }
  return json({ ok: true, processados: enviados, erros });
});
