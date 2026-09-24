/*!
 * kedu-track.js : captura de origem de leads (first-party, sem GTM)
 *
 * Instalação (no <head> de todas as páginas):
 * <script src="https://SEU_DOMINIO/kedu-track.js"
 *         data-endpoint="https://SEU_PROJETO.supabase.co/functions/v1/collect"
 *         data-consent="auto" defer></script>
 *
 * data-consent="auto"     : rastreia direto (use se o aviso de cookies já cobre isso)
 * data-consent="required" : só começa depois de window.keduTrack.consent()
 *
 * O que faz:
 *  1. guarda primeiro e último toque (UTMs, gclid, fbclid, referrer, página) por 90 dias
 *  2. preenche campos ocultos kt_* em todos os formulários da página
 *  3. ao enviar um formulário, manda telefone/e-mail para ligar a visita ao lead
 *  4. em links de WhatsApp, coloca um código "ref" na mensagem para ligar a conversa à visita
 */
(function () {
  "use strict";
  if (window.keduTrack) return;

  var script = document.currentScript || document.querySelector("script[data-endpoint]");
  var ENDPOINT = script && script.getAttribute("data-endpoint");
  var CONSENT_MODE = (script && script.getAttribute("data-consent")) || "auto";
  var DAYS = 90;
  var PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
    "kt_ad", "gclid", "gbraid", "wbraid", "fbclid"];
  var WA_RE = /(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|^whatsapp:)/i;

  if (!ENDPOINT) { console.warn("[kedu-track] data-endpoint não definido"); return; }

  // ---------------------------------------------------------- utilidades
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  function rootDomain() {
    var h = location.hostname;
    if (/^[\d.]+$/.test(h) || h === "localhost") return h;
    var p = h.split(".");
    var n = /\.(com|net|org|gov|edu)\.br$/.test(h) ? 3 : 2;
    return "." + p.slice(-n).join(".");
  }
  function setCookie(k, v, days) {
    var d = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = k + "=" + encodeURIComponent(v) + "; expires=" + d +
      "; path=/; domain=" + rootDomain() + "; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : "");
  }
  function getCookie(k) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + k.replace(/[.$?*|{}()[\]\\/+^]/g, "\\$&") + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function getJSON(k) { try { return JSON.parse(getCookie(k) || "null"); } catch (e) { return null; } }
  function externalReferrer() {
    if (!document.referrer) return "";
    try {
      var r = new URL(document.referrer);
      var root = rootDomain().replace(/^\./, "");
      return r.hostname === location.hostname || r.hostname.endsWith(root) ? "" : r.origin + r.pathname;
    } catch (e) { return ""; }
  }

  // ------------------------------------------------------- identidade
  var started = false;
  var anonId, firstTouch, lastTouch;

  function readUrlParams() {
    var q = new URLSearchParams(location.search), out = {}, any = false;
    PARAMS.forEach(function (p) {
      var v = q.get(p);
      if (v) { out[p.replace("utm_", "")] = v.slice(0, 300); any = true; }
    });
    return any ? out : null;
  }

  function fbc() {
    var c = getCookie("_fbc");
    if (c) return c;
    var t = lastTouch && lastTouch.fbclid;
    return t ? "fb.1." + (lastTouch.ts || Date.now()) + "." + t : null;
  }

  function send(event, extra) {
    var body = {
      v: 1, event_id: uuid(), event: event, anon_id: anonId, ts: Date.now(),
      url: location.href.slice(0, 500), first: firstTouch, last: lastTouch,
      fbp: getCookie("_fbp"), fbc: fbc()
    };
    for (var k in extra) body[k] = extra[k];
    var data = JSON.stringify(body);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([data], { type: "text/plain" }))) return;
    } catch (e) { /* segue para o fetch */ }
    try { fetch(ENDPOINT, { method: "POST", body: data, keepalive: true, headers: { "Content-Type": "text/plain" } }); } catch (e) { }
  }

  // ------------------------------------------------ campos ocultos kt_*
  function hiddenValues() {
    var t = lastTouch || {};
    return {
      kt_anon_id: anonId, kt_touch_id: t.id, kt_touch_ts: t.ts,
      kt_source: t.source, kt_medium: t.medium, kt_campaign: t.campaign, kt_content: t.content,
      kt_term: t.term, kt_ad: t.kt_ad, kt_gclid: t.gclid, kt_fbclid: t.fbclid,
      kt_referrer: t.referrer, kt_landing: t.landing, kt_page: location.href.slice(0, 500),
      kt_fbp: getCookie("_fbp"), kt_fbc: fbc()
    };
  }
  function fillForm(form) {
    var vals = hiddenValues();
    Object.keys(vals).forEach(function (name) {
      var v = vals[name];
      if (v === undefined || v === null) v = "";
      var el = form.querySelector('[name="' + name + '"], [name="form_fields[' + name + ']"]');
      if (!el) {
        el = document.createElement("input");
        el.type = "hidden"; el.name = name;
        form.appendChild(el);
      }
      el.value = String(v);
    });
  }
  function fillAllForms() { Array.prototype.forEach.call(document.forms, fillForm); }

  // ----------------------------------------- identificação no envio
  function fieldValue(form, re, type) {
    var els = form.querySelectorAll("input, select, textarea");
    for (var i = 0; i < els.length; i++) {
      var el = els[i], key = ((el.name || "") + " " + (el.id || "") + " " + (el.getAttribute("placeholder") || "")).toLowerCase();
      if (/^kt_/.test(el.name || "") || el.type === "hidden" && !type) continue;
      if ((type && el.type === type) || re.test(key)) { if (el.value) return el.value.trim(); }
    }
    return null;
  }
  function onSubmit(e) {
    var form = e.target;
    if (!form || form.tagName !== "FORM") return;
    fillForm(form);
    var identity = {
      email: fieldValue(form, /e-?mail/, "email"),
      telefone: fieldValue(form, /(fone|phone|telefone|celular|whats)/, "tel"),
      nome: fieldValue(form, /(^|[\s_\-[])(nome|name|your-name|first_name)/),
      escola: fieldValue(form, /(escola|col[eé]gio|institui|empresa|company)/),
      cnpj: fieldValue(form, /cnpj/)
    };
    send("form_submit", { identity: identity });
  }

  // -------------------------------------------------------- WhatsApp
  function refCode() {
    var c = getCookie("kt_ref");
    if (!c) {
      var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; c = "";
      for (var i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
      setCookie("kt_ref", c, DAYS);
    }
    return c;
  }
  function onClick(e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || !WA_RE.test(a.getAttribute("href") || "")) return;
    var code = refCode();
    try {
      var href = a.getAttribute("href");
      var url = new URL(href, location.href);
      var text = url.searchParams.get("text") || "Olá! Quero saber mais sobre a Kedu.";
      if (!/\bref\s+[A-Z0-9]{4,8}\b/i.test(text)) {
        url.searchParams.set("text", text + " (ref " + code + ")");
        a.setAttribute("href", url.toString());
      }
    } catch (err) { /* link fora do padrão: segue sem ref */ }
    send("wa_click", { ref_code: code });
  }

  // ----------------------------------------------------------- início
  function start() {
    if (started) return;
    started = true;

    anonId = getCookie("kt_id") || uuid();
    setCookie("kt_id", anonId, 400);
    firstTouch = getJSON("kt_ft");
    lastTouch = getJSON("kt_lt");

    var params = readUrlParams();
    var ref = externalReferrer();
    var isNewTouch = !!params || !!ref || !firstTouch;

    if (isNewTouch) {
      var t = params || {};
      t.id = uuid();
      t.ts = Date.now();
      t.referrer = ref;
      t.landing = (location.origin + location.pathname).slice(0, 300);
      lastTouch = t;
      setCookie("kt_lt", JSON.stringify(t), DAYS);
      if (!firstTouch) { firstTouch = t; setCookie("kt_ft", JSON.stringify(t), DAYS); }
      send("visita", { touch: t });
    }

    fillAllForms();
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("click", onClick, true);
    // formulários que aparecem depois (popups, Elementor, Flowbiz embed)
    if (window.MutationObserver) {
      var pending = null;
      new MutationObserver(function () {
        clearTimeout(pending); pending = setTimeout(fillAllForms, 300);
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  window.keduTrack = {
    consent: start,
    getAnonId: function () { return anonId; },
    // para formulários que não disparam "submit" (ex: envio só por JavaScript)
    identify: function (identity) { if (started) send("form_submit", { identity: identity || {} }); }
  };

  if (CONSENT_MODE !== "required") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  }
})();
