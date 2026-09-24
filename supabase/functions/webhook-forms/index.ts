// /webhook-forms : leads de formulários (Flowbiz, WordPress: Elementor, Contact Form 7, WPForms...).
// Aceita qualquer JSON ou form-urlencoded. Descobre os campos pelo nome.
// Se o formulário tiver os campos ocultos kt_* preenchidos pelo kedu-track.js,
// a origem vem junto mesmo que o script do site tenha sido bloqueado.
import {
  buildAdId, checkSecret, db, json, markRaw, normalizeCnpj, normalizeEmail, normalizePhone,
  readBody, resolveLead, saveRaw, sha256, str, toIso,
} from "../_shared/util.ts";

/** Achata objetos aninhados: { fields: { email: { value: "x" } } } vira { "fields.email.value": "x" } */
function flatten(o: unknown, prefix = "", out: Record<string, string> = {}) {
  if (o === null || o === undefined) return out;
  if (typeof o !== "object") { out[prefix] = String(o); return out; }
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

function pick(f: Record<string, string>, re: RegExp, valid?: (v: string) => boolean): string | null {
  for (const [k, v] of Object.entries(f)) {
    const key = k.toLowerCase().replace(/\.(value|raw_value)$/, "");
    if (re.test(key) && v && (!valid || valid(v))) return v;
  }
  return null;
}

Deno.serve(async (req) => {
  if (!checkSecret(req)) return json({ error: "não autorizado" }, 401);
  const body = await readBody(req);
  const f = flatten(body);

  const extId = str(f.id ?? f.lead_id ?? f.entry_id) ?? await sha256(JSON.stringify(body));
  const rawId = await saveRaw("forms", extId, body);
  if (!rawId) return json({ ok: true, duplicado: true });

  try {
    const email = normalizeEmail(pick(f, /(^|[._-])(e-?mail|your-email)$|email/, (v) => v.includes("@")));
    const telefone = normalizePhone(pick(f, /(fone|phone|telefone|celular|whats|tel)/, (v) => v.replace(/\D/g, "").length >= 10));
    const cnpj = normalizeCnpj(pick(f, /cnpj/));
    const nome = pick(f, /(^|[._-])(nome|name|your-name|first_name|nome_completo)$/);
    const escola = pick(f, /(escola|colegio|col[eé]gio|institui|empresa|company)/);
    const anon = str(f.kt_anon_id);

    if (!email && !telefone && !cnpj) {
      await markRaw(rawId, "ignorado", "sem telefone, e-mail ou CNPJ");
      return json({ ok: true, ignorado: "sem identificação" });
    }

    // Toque de origem vindo dos campos ocultos (fallback se o script foi bloqueado)
    if (f.kt_source || f.kt_gclid || f.kt_fbclid || f.kt_ad || f.kt_referrer) {
      await db.from("touchpoints").upsert({
        client_touch_id: str(f.kt_touch_id) ?? `form:${extId}`,
        raw_event_id: rawId,
        anon_id: anon,
        tipo: "visita",
        atribuivel: true,
        ad_id: buildAdId({
          source: f.kt_source, gclid: f.kt_gclid, fbclid: f.kt_fbclid, kt_ad: f.kt_ad, utm_campaign: f.kt_campaign,
        }),
        utm_source: str(f.kt_source), utm_medium: str(f.kt_medium), utm_campaign: str(f.kt_campaign),
        utm_content: str(f.kt_content), utm_term: str(f.kt_term),
        gclid: str(f.kt_gclid), fbclid: str(f.kt_fbclid), fbp: str(f.kt_fbp), fbc: str(f.kt_fbc),
        referrer: str(f.kt_referrer), landing_page: str(f.kt_landing),
        occurred_at: toIso(f.kt_touch_ts),
      }, { onConflict: "client_touch_id", ignoreDuplicates: true });
    }

    // Origem vinda da própria ferramenta (ex: Flowbiz manda utm_source nos dados do lead)
    else if (f.utm_source || f.utm_campaign) {
      await db.from("touchpoints").insert({
        raw_event_id: rawId, anon_id: anon, tipo: "visita", atribuivel: true,
        utm_source: str(f.utm_source), utm_medium: str(f.utm_medium), utm_campaign: str(f.utm_campaign),
        utm_content: str(f.utm_content), utm_term: str(f.utm_term), occurred_at: new Date().toISOString(),
      });
    }

    const leadId = await resolveLead([
      { tipo: "anon", valor: anon },
      { tipo: "telefone", valor: telefone },
      { tipo: "email", valor: email },
      { tipo: "cnpj", valor: cnpj },
    ], nome, escola);

    // Marca o envio na linha do tempo
    await db.from("touchpoints").upsert({
      client_touch_id: `formsub:${extId}`, raw_event_id: rawId, lead_id: leadId, anon_id: anon,
      tipo: "form_submit", atribuivel: false, landing_page: str(f.kt_page ?? f.page_url ?? f.referer),
      occurred_at: new Date().toISOString(),
    }, { onConflict: "client_touch_id", ignoreDuplicates: true });

    // Se o toque de fallback foi criado sem anon_id, liga ele ao lead
    await db.from("touchpoints").update({ lead_id: leadId }).eq("raw_event_id", rawId).is("lead_id", null);

    await markRaw(rawId, "processado");
    return json({ ok: true, lead: leadId });
  } catch (e) {
    console.error(e);
    await markRaw(rawId, "erro", e);
    return json({ ok: false, erro: String((e as Error).message) });
  }
});
