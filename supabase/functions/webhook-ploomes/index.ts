// /webhook-ploomes : negócio criado ou atualizado no Ploomes.
//  1. liga o negócio ao lead (por telefone, e-mail, CNPJ ou ID do negócio)
//  2. grava a etapa atingida, com data
//  3. escreve a origem de volta no Ploomes, em campos próprios
import {
  checkSecret, db, env, json, markRaw, normalizeCnpj, normalizeEmail, normalizePhone,
  readBody, resolveLead, saveRaw, str, toIso,
} from "../_shared/util.ts";
import { getDeal, patchDealFields, type PloomesDeal } from "../_shared/ploomes.ts";

const PIPELINES = env("PLOOMES_PIPELINE_IDS").split(",").map((s) => s.trim()).filter(Boolean);

const FIELDS = {
  canal: env("PLOOMES_FIELD_CANAL"),
  campanha: env("PLOOMES_FIELD_CAMPANHA"),
  criativo: env("PLOOMES_FIELD_CRIATIVO"),
  data: env("PLOOMES_FIELD_DATA_TOQUE"),
  canalPago: env("PLOOMES_FIELD_CANAL_PAGO"),
};

async function etapaDoEstagio(stageId: number | undefined, stageName: string | undefined): Promise<string | null> {
  if (!stageId) return null;
  const { data } = await db.from("stage_map").select("etapa").eq("ploomes_stage_id", stageId).maybeSingle();
  if (data?.etapa) return data.etapa;
  // Estágio ainda não mapeado: usa o nome do Ploomes e cria a etapa automaticamente
  const nome = stageName ? stageName.trim() : `Estágio ${stageId}`;
  await db.from("etapas").upsert({ nome, ordem: 100 }, { onConflict: "nome", ignoreDuplicates: true });
  await db.from("stage_map").upsert({ ploomes_stage_id: stageId, etapa: nome }, { onConflict: "ploomes_stage_id", ignoreDuplicates: true });
  return nome;
}

function fmtData(iso: string | null) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Fortaleza", dateStyle: "short", timeStyle: "short",
  }).format(new Date(iso));
}

async function writeBack(leadId: string, dealId: number) {
  if (!Object.values(FIELDS).some(Boolean)) return;
  const { data: l } = await db.from("v_leads").select("*").eq("id", leadId).maybeSingle();
  const { data: lead } = await db.from("leads").select("ploomes_sync_sig").eq("id", leadId).maybeSingle();
  if (!l) return;
  const valores: Record<string, string | null> = {};
  if (FIELDS.canal) valores[FIELDS.canal] = l.ft_canal ?? "";
  if (FIELDS.campanha) valores[FIELDS.campanha] = l.ft_campanha ?? "";
  if (FIELDS.criativo) valores[FIELDS.criativo] = l.ft_criativo ?? "";
  if (FIELDS.data) valores[FIELDS.data] = fmtData(l.ft_at);
  if (FIELDS.canalPago) valores[FIELDS.canalPago] = [l.lp_canal, l.lp_campanha, l.lp_criativo].filter(Boolean).join(" | ");
  const sig = `${dealId}:${JSON.stringify(valores)}`;
  if (lead?.ploomes_sync_sig === sig) return; // nada mudou: evita loop de webhook
  await patchDealFields(dealId, valores);
  await db.from("leads").update({ ploomes_sync_sig: sig }).eq("id", leadId);
}

Deno.serve(async (req) => {
  if (!checkSecret(req)) return json({ error: "não autorizado" }, 401);
  const body = await readBody(req) as Record<string, any>;

  const action = String(body.Action ?? body.action ?? "").toLowerCase();
  const novo = body.New ?? body.new ?? body.Entity ?? body;
  const dealId = Number(novo?.Id ?? body.Old?.Id ?? body.Id);
  if (!dealId) return json({ ok: true, ignorado: "sem Id" });
  if (action.includes("delet") || action === "3") return json({ ok: true, ignorado: "exclusão" });

  const extId = `${dealId}:${novo?.StageId ?? ""}:${novo?.StatusId ?? ""}:${novo?.LastUpdateDate ?? Date.now()}`;
  const rawId = await saveRaw("ploomes", extId, body);
  if (!rawId) return json({ ok: true, duplicado: true });

  try {
    // O payload do webhook nem sempre traz contato e dono; busca o negócio completo
    let deal: PloomesDeal | null = null;
    try { deal = await getDeal(dealId); } catch (e) { console.warn("getDeal falhou, usando payload", e); }
    deal = deal ?? (novo as PloomesDeal);

    if (PIPELINES.length && deal.PipelineId && !PIPELINES.includes(String(deal.PipelineId))) {
      await markRaw(rawId, "ignorado", `funil ${deal.PipelineId} fora do filtro`);
      return json({ ok: true, ignorado: "funil" });
    }

    const c = deal.Contact ?? {};
    const phones = (c.Phones ?? []).map((p) => normalizePhone(p.PhoneNumber)).filter(Boolean) as string[];
    const leadId = await resolveLead([
      { tipo: "ploomes_deal", valor: String(dealId) },
      ...phones.map((p) => ({ tipo: "telefone" as const, valor: p })),
      { tipo: "email", valor: normalizeEmail(c.Email) },
      { tipo: "cnpj", valor: normalizeCnpj(c.Register) },
    ], str(c.Name), str(c.Company?.Name ?? deal.Title));
    if (!leadId) throw new Error("não foi possível resolver o lead");

    // Toque "crm" marca quando o negócio nasceu. Só vira origem se não houver outra.
    await db.from("touchpoints").upsert({
      client_touch_id: `ploomes:${dealId}`,
      raw_event_id: rawId,
      lead_id: leadId,
      tipo: "crm",
      atribuivel: true,
      occurred_at: toIso(deal.CreateDate),
    }, { onConflict: "client_touch_id", ignoreDuplicates: true });

    // Etapa atual + ganho/perdido
    const quando = toIso(deal.LastUpdateDate);
    const executivo = str(deal.Owner?.Name);
    const etapas: { etapa: string; stage: number | null }[] = [];
    const etapa = await etapaDoEstagio(deal.StageId, deal.Stage?.Name);
    if (etapa) etapas.push({ etapa, stage: deal.StageId ?? null });
    if (deal.StatusId === 2) etapas.push({ etapa: "Ganho", stage: null });
    if (deal.StatusId === 3) etapas.push({ etapa: "Perdido", stage: null });
    for (const e of etapas) {
      await db.from("etapas").upsert({ nome: e.etapa, ordem: 100 }, { onConflict: "nome", ignoreDuplicates: true });
      await db.from("stage_events").upsert({
        lead_id: leadId, ploomes_deal_id: dealId, etapa: e.etapa,
        ploomes_stage_id: e.stage, executivo, occurred_at: quando,
      }, { onConflict: "ploomes_deal_id,etapa", ignoreDuplicates: true });
    }

    try { await writeBack(leadId, dealId); } catch (e) { console.warn("write-back falhou", e); }

    await markRaw(rawId, "processado");
    return json({ ok: true, lead: leadId, etapas: etapas.map((e) => e.etapa) });
  } catch (e) {
    console.error(e);
    await markRaw(rawId, "erro", e);
    return json({ ok: false, erro: String((e as Error).message) });
  }
});
