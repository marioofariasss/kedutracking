// Clientes mínimos das APIs de anúncios.
import { env } from "./util.ts";

// ------------------------------------------------------------------ META
export const META_VER = env("META_API_VERSION", "v23.0");
const META = `https://graph.facebook.com/${META_VER}`;

export async function metaGet(path: string, params: Record<string, string>) {
  const qs = new URLSearchParams({ ...params, access_token: env("META_ACCESS_TOKEN") });
  const res = await fetch(`${META}${path}?${qs}`);
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(`Meta: ${JSON.stringify(j.error ?? j).slice(0, 500)}`);
  return j;
}

export async function metaGetUrl(url: string) {
  const res = await fetch(url);
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(`Meta: ${JSON.stringify(j.error ?? j).slice(0, 500)}`);
  return j;
}

export async function metaSendEvents(events: unknown[]) {
  const res = await fetch(`${META}/${env("META_DATASET_ID")}/events?access_token=${env("META_ACCESS_TOKEN")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: events, ...(env("META_TEST_EVENT_CODE") ? { test_event_code: env("META_TEST_EVENT_CODE") } : {}) }),
  });
  const j = await res.json();
  return { ok: res.ok && !j.error, body: j };
}

// ---------------------------------------------------------------- GOOGLE
export const GADS_VER = env("GOOGLE_ADS_API_VERSION", "v21");
export const GADS_CID = () => env("GOOGLE_ADS_CUSTOMER_ID").replace(/\D/g, "");
let cachedToken: { token: string; exp: number } | null = null;

async function googleToken(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("GOOGLE_ADS_CLIENT_ID"),
      client_secret: env("GOOGLE_ADS_CLIENT_SECRET"),
      refresh_token: env("GOOGLE_ADS_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Google OAuth: ${JSON.stringify(j).slice(0, 300)}`);
  cachedToken = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

export async function googleAds(path: string, body: unknown) {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${await googleToken()}`,
    "developer-token": env("GOOGLE_ADS_DEVELOPER_TOKEN"),
    "Content-Type": "application/json",
  };
  const mcc = env("GOOGLE_ADS_LOGIN_CUSTOMER_ID").replace(/\D/g, "");
  if (mcc) headers["login-customer-id"] = mcc;
  const res = await fetch(`https://googleads.googleapis.com/${GADS_VER}/customers/${GADS_CID()}${path}`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  const j = await res.json();
  return { ok: res.ok, body: j };
}

export const metaConfigured = () => !!(env("META_ACCESS_TOKEN") && env("META_AD_ACCOUNT_ID"));
export const googleConfigured = () =>
  !!(env("GOOGLE_ADS_DEVELOPER_TOKEN") && env("GOOGLE_ADS_REFRESH_TOKEN") && env("GOOGLE_ADS_CUSTOMER_ID"));
