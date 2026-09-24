// /sync-costs : puxa gasto por anúncio por dia do Meta e do Google Ads.
// Por padrão atualiza os últimos 3 dias (as plataformas ajustam números recentes).
// Para carga histórica: POST { "since": "2026-01-01", "until": "2026-09-24" }
import { checkSecret, db, env, json, readBody } from "../_shared/util.ts";
import { googleAds, googleConfigured, metaConfigured, metaGet, metaGetUrl } from "../_shared/ads.ts";

type Ad = { ad_id: string; plataforma: string; campanha: string | null; campanha_id: string | null; conjunto: string | null; criativo: string | null };
type Cost = { ad_id: string; dia: string; gasto: number; impressoes: number; cliques: number };

const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function syncMeta(since: string, until: string, ads: Map<string, Ad>, costs: Map<string, Cost>) {
  const acct = env("META_AD_ACCOUNT_ID").replace(/^act_/, "");
  let page = await metaGet(`/act_${acct}/insights`, {
    level: "ad",
    fields: "ad_id,ad_name,adset_name,campaign_id,campaign_name,spend,impressions,clicks",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    limit: "500",
  });
  while (page) {
    for (const r of page.data ?? []) {
      const ad_id = `meta:${r.ad_id}`;
      ads.set(ad_id, { ad_id, plataforma: "meta", campanha: r.campaign_name, campanha_id: r.campaign_id, conjunto: r.adset_name, criativo: r.ad_name });
      costs.set(`${ad_id}|${r.date_start}`, {
        ad_id, dia: r.date_start, gasto: Number(r.spend ?? 0),
        impressoes: Number(r.impressions ?? 0), cliques: Number(r.clicks ?? 0),
      });
    }
    page = page.paging?.next ? await metaGetUrl(page.paging.next) : null;
  }
}

async function gaql(query: string) {
  const r = await googleAds("/googleAds:searchStream", { query });
  if (!r.ok) throw new Error(`Google Ads: ${JSON.stringify(r.body).slice(0, 600)}`);
  return (r.body as any[]).flatMap((batch) => batch.results ?? []);
}

async function syncGoogle(since: string, until: string, ads: Map<string, Ad>, costs: Map<string, Cost>) {
  const add = (ad: Ad, dia: string, m: any) => {
    ads.set(ad.ad_id, ad);
    const k = `${ad.ad_id}|${dia}`;
    const prev = costs.get(k);
    const gasto = Number(m.costMicros ?? 0) / 1e6;
    costs.set(k, {
      ad_id: ad.ad_id, dia,
      gasto: (prev?.gasto ?? 0) + gasto,
      impressoes: (prev?.impressoes ?? 0) + Number(m.impressions ?? 0),
      cliques: (prev?.cliques ?? 0) + Number(m.clicks ?? 0),
    });
  };

  // Anúncios de Search, Display, Vídeo
  const rows = await gaql(`
    SELECT campaign.id, campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.name,
           segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks
      FROM ad_group_ad
     WHERE segments.date BETWEEN '${since}' AND '${until}' AND metrics.impressions > 0`);
  for (const r of rows) {
    const id = r.adGroupAd?.ad?.id;
    add({
      ad_id: `google:${id}`, plataforma: "google",
      campanha: r.campaign?.name, campanha_id: String(r.campaign?.id ?? ""),
      conjunto: r.adGroup?.name,
      criativo: r.adGroupAd?.ad?.name || `${r.adGroup?.name ?? "Anúncio"} #${id}`,
    }, r.segments.date, r.metrics ?? {});
  }

  // Performance Max não tem anúncio individual: custo fica no nível da campanha
  const pmax = await gaql(`
    SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks
      FROM campaign
     WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX'
       AND segments.date BETWEEN '${since}' AND '${until}' AND metrics.impressions > 0`);
  for (const r of pmax) {
    add({
      ad_id: `google:c${r.campaign.id}`, plataforma: "google",
      campanha: r.campaign.name, campanha_id: String(r.campaign.id),
      conjunto: "Performance Max", criativo: `PMax: ${r.campaign.name}`,
    }, r.segments.date, r.metrics ?? {});
  }
}

async function upsertChunks(table: string, rows: unknown[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + 500), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

Deno.serve(async (req) => {
  if (!checkSecret(req)) return json({ error: "não autorizado" }, 401);
  const b = await readBody(req) as Record<string, string>;
  const until = b.until ?? ymd(new Date());
  const since = b.since ?? ymd(new Date(Date.now() - 3 * 86400000));

  const ads = new Map<string, Ad>();
  const costs = new Map<string, Cost>();
  const resultado: Record<string, string> = {};

  if (metaConfigured()) {
    try { await syncMeta(since, until, ads, costs); resultado.meta = "ok"; }
    catch (e) { resultado.meta = String((e as Error).message); }
  } else resultado.meta = "não configurado";

  if (googleConfigured()) {
    try { await syncGoogle(since, until, ads, costs); resultado.google = "ok"; }
    catch (e) { resultado.google = String((e as Error).message); }
  } else resultado.google = "não configurado";

  const adRows = [...ads.values()].map((a) => ({ ...a, updated_at: new Date().toISOString() }));
  const costRows = [...costs.values()].map((c) => ({ ...c, gasto: Math.round(c.gasto * 100) / 100 }));
  await upsertChunks("ads", adRows, "ad_id");
  await upsertChunks("ad_costs", costRows, "ad_id,dia");

  return json({ since, until, anuncios: adRows.length, linhas_custo: costRows.length, resultado });
});
