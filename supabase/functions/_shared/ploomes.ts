// Cliente mínimo da API pública do Ploomes.
import { env } from "./util.ts";

const BASE = env("PLOOMES_API_URL", "https://public-api2.ploomes.com");

async function call(path: string, init: RequestInit = {}) {
  const key = env("PLOOMES_USER_KEY");
  if (!key) throw new Error("PLOOMES_USER_KEY não configurada");
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "User-Key": key, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ploomes ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

export type PloomesDeal = {
  Id: number; Title?: string; StageId?: number; PipelineId?: number; StatusId?: number;
  CreateDate?: string; LastUpdateDate?: string;
  Owner?: { Name?: string }; Stage?: { Name?: string };
  Contact?: { Name?: string; Email?: string; Register?: string; Phones?: { PhoneNumber?: string }[]; Company?: { Name?: string } };
};

/** Busca o negócio já com dono, estágio e contato (telefones, e-mail, CNPJ) */
export async function getDeal(id: number): Promise<PloomesDeal | null> {
  const expand = [
    "Owner($select=Name)",
    "Stage($select=Name)",
    "Contact($select=Name,Email,Register;$expand=Phones($select=PhoneNumber),Company($select=Name))",
  ].join(",");
  const q = `/Deals?$filter=Id+eq+${id}&$select=Id,Title,StageId,PipelineId,StatusId,CreateDate,LastUpdateDate&$expand=${encodeURIComponent(expand)}`;
  const r = await call(q);
  return r?.value?.[0] ?? null;
}

/** Escreve campos personalizados (texto) no negócio */
export async function patchDealFields(id: number, fields: Record<string, string | null>) {
  const OtherProperties = Object.entries(fields)
    .filter(([k]) => !!k)
    .map(([FieldKey, v]) => ({ FieldKey, StringValue: v ?? "" }));
  if (!OtherProperties.length) return;
  await call(`/Deals(${id})`, { method: "PATCH", body: JSON.stringify({ OtherProperties }) });
}
