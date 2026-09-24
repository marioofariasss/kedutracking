// Utilitários compartilhados por todas as funções do hub.
import { createClient } from "npm:@supabase/supabase-js@2";

export const env = (k: string, fallback = ""): string => Deno.env.get(k) ?? fallback;

export const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------- HTTP
export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Webhooks internos exigem o segredo no header x-kt-secret ou em ?secret= */
export function checkSecret(req: Request): boolean {
  const secret = env("WEBHOOK_SECRET");
  if (!secret) return false;
  const url = new URL(req.url);
  return req.headers.get("x-kt-secret") === secret || url.searchParams.get("secret") === secret;
}

/** Lê o corpo aceitando JSON, form-urlencoded, multipart e texto puro com JSON */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const fd = await req.formData();
    const out: Record<string, unknown> = {};
    for (const [k, v] of fd.entries()) out[k] = typeof v === "string" ? v : v.name;
    return out;
  }
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    // alguns sistemas mandam querystring no corpo sem o content-type correto
    return Object.fromEntries(new URLSearchParams(text));
  }
}

// ------------------------------------------------------- eventos brutos
/** Guarda o evento bruto. Retorna null se já tinha chegado antes (duplicado). */
export async function saveRaw(source: string, externalId: string | null, payload: unknown) {
  const { data, error } = await db
    .from("raw_events")
    .upsert({ source, external_id: externalId, payload }, {
      onConflict: "source,external_id",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) throw new Error(`raw_events: ${error.message}`);
  return data && data.length ? (data[0].id as string) : null;
}

export async function markRaw(id: string | null, status: string, err?: unknown) {
  if (!id) return;
  await db.from("raw_events").update({
    status,
    error: err ? String((err as Error)?.message ?? err).slice(0, 2000) : null,
  }).eq("id", id);
}

// ----------------------------------------------------------- telefone
/**
 * Normaliza telefone brasileiro para +55DDNNNNNNNNN.
 * Resolve o problema do nono dígito: o WhatsApp às vezes entrega o
 * número de celular sem o 9, e o formulário vem com ele.
 */
export function normalizePhone(raw?: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let d = String(raw).replace(/\D/g, "").replace(/^0+/, "");
  if (!d) return null;
  if (d.length === 10 || d.length === 11) d = "55" + d;
  if (!d.startsWith("55")) return d.length >= 8 ? "+" + d : null; // estrangeiro
  const ddd = d.slice(2, 4);
  let local = d.slice(4);
  if (local.length === 8 && /^[6-9]/.test(local)) local = "9" + local; // celular sem o 9
  if (local.length !== 8 && local.length !== 9) return null;
  return `+55${ddd}${local}`;
}

export function normalizeEmail(raw?: unknown): string | null {
  if (!raw) return null;
  const e = String(raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

export function normalizeCnpj(raw?: unknown): string | null {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, "");
  return d.length === 14 ? d : null;
}

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------ leads
export type Identity = { tipo: "ploomes_deal" | "telefone" | "cnpj" | "email" | "anon"; valor: string | null };

export async function resolveLead(ids: Identity[], nome?: string | null, escola?: string | null) {
  const clean = ids.filter((i) => i.valor);
  if (!clean.length) return null;
  const { data, error } = await db.rpc("resolve_lead", {
    p_ids: clean,
    p_nome: nome ?? null,
    p_escola: escola ?? null,
  });
  if (error) throw new Error(`resolve_lead: ${error.message}`);
  return data as string;
}

// -------------------------------------------------------- anúncios
/** Monta o ID interno do anúncio a partir da plataforma e dos parâmetros */
export function buildAdId(p: {
  source?: string | null; gclid?: string | null; gbraid?: string | null; wbraid?: string | null;
  fbclid?: string | null; kt_ad?: string | null; utm_campaign?: string | null;
}): string | null {
  const src = (p.source ?? "").toLowerCase();
  const isGoogle = !!(p.gclid || p.gbraid || p.wbraid) || ["google", "adwords", "google_ads", "youtube"].includes(src);
  const isMeta = ["meta", "facebook", "fb", "instagram", "ig"].includes(src);
  const ad = (p.kt_ad ?? "").trim();
  if (/^\d+$/.test(ad)) {
    if (isGoogle) return `google:${ad}`;
    if (isMeta || p.fbclid) return `meta:${ad}`;
  }
  // PMax e campanhas sem ID de anúncio: cai no ID da campanha
  if (isGoogle && /^\d+$/.test(p.utm_campaign ?? "")) return `google:c${p.utm_campaign}`;
  return null;
}

export function toIso(v: unknown): string {
  if (v === null || v === undefined || v === "") return new Date().toISOString();
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const n = Number(v);
    return new Date(n < 1e12 ? n * 1000 : n).toISOString(); // segundos ou ms
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export const str = (v: unknown): string | null =>
  v === null || v === undefined || v === "" ? null : String(v).slice(0, 1000);
