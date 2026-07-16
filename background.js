// OmniRoute Bridge — service worker.
// 1) Capture: read the real Cookie header (+ Bearer) from any XHR of a supported web provider
//    (webRequest sees HttpOnly cookies a content script cannot).
// 2) Add: POST /api/providers from INSIDE an OmniRoute dashboard tab (executeScript world:MAIN →
//    same-origin → the HttpOnly admin session cookie rides along; a direct SW fetch is 401 by SameSite).
// 3) Probe: a REAL /v1/chat/completions call (the gateway is open locally) — the honest "does it work"
//    signal, unlike OmniRoute's /test which reports valid on banned connections.
// 4) OAuth: device_code flow (code + poll) driven by chrome.alarms so it survives popup close / SW sleep.
// 5) Health sweep: a periodic alarm re-probes known connections and flags newly-dead ones on the badge.
// Secrets (cookies/tokens/API keys/OAuth device codes) live in chrome.storage.SESSION — in-memory,
// cleared when the browser closes. EXCEPTION: when the persistSessions setting is on (default), web-
// session captures (cap_<key>) are ALSO mirrored to .local so they survive a browser restart and get
// auto-re-pushed on the next launch (restartRecovery) — a deliberate secrets-on-disk tradeoff so the
// web providers don't sit red every morning; toggle persistSessions off to keep secrets memory-only.
// Non-secret state (probe verdicts, prefs, health snapshot) stays in .local so it survives a restart.
// Chrome (service worker): importScripts pulls the catalog + adapter. Firefox (background.scripts):
// they're already loaded as globals via the manifest, and importScripts doesn't exist — so guard it.
if (typeof OMNI_GEN === "undefined" && typeof importScripts === "function") importScripts("providers.gen.js", "providers.js");

// Chrome MV3 runs the background as a service worker (importScripts exists); Firefox runs it as a
// background page (background.scripts, no importScripts). We use that as the Chrome-vs-Firefox
// discriminator for ONE decision: whether a DIRECT fetch to the http loopback works. In Chrome's SW it
// does (no tab needed). In Firefox a direct http fetch from the extension's secure context to the http
// loopback does NOT reject — it HANGS (the old probeServer only surfaced it via a 5s abort), so a
// direct-first with no timeout never returns and the popup reads the server as down. Firefox therefore
// goes straight through the dashboard tab (http→http), the path the extension uses everywhere else.
const CAN_DIRECT_FETCH = typeof importScripts === "function";

const SEC = chrome.storage.session; // secrets: cap_<key>, apikey_aistudio, oauth_<slug>
const LOC = chrome.storage.local;   // non-secret: probe_<slug>, sel_apikey, health_dead, conn_slugs, settings, last_sweep

// i18n lookup. Falls back to the KEY itself, never "": chrome.i18n.getMessage returns an empty string
// for a missing key, and these strings end up in the popup as the error the user reads.
// NOTE: the *InPage functions below are serialised into the dashboard tab (executeScript) — they can't
// close over `t` and have no extension APIs, so any user-facing text they return is passed in as an arg.
const t = (k, subs) => chrome.i18n.getMessage(k, subs) || k;

// User settings (persisted, non-secret). Defaults chosen for "helpful but not costly".
// sweepSkip: provider slugs the unattended sweep must not touch. The sweep spends a REAL 1-token
// completion per provider every cycle, which costs money on paid tiers and trips rate-limits on some
// (kiro 429) — and for a web-session provider a robotic request every 15 min is also ban-surface.
// Opting one out keeps it usable via the popup's manual "Проверить все" without paying for it hourly.
const SETTINGS_DEFAULT = { sweep: true, sweepMin: 15, notify: true, theme: "auto", persistSessions: true, sweepSkip: [] };

// How long a mirrored capture may sit on disk. Session cookies live "hours to days", so one that hasn't
// been refreshed in a week is a corpse: re-pushing it can't authenticate anything, and keeping it is a
// secret stored for no upside. NOT the popup's 6h "possibly stale" hint — that's advice while you look;
// this is when we stop storing it at all (a night is 8-12h, so a 6h disk TTL would delete exactly what
// restartRecovery exists to restore).
const CAP_DISK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function getSettings() {
  const { settings } = await LOC.get("settings");
  return { ...SETTINGS_DEFAULT, ...(settings || {}) };
}

// ── capture ─────────────────────────────────────────────────────────────────
const captureOpts = ["requestHeaders"];
try {
  if (chrome.webRequest.OnBeforeSendHeadersOptions?.EXTRA_HEADERS) captureOpts.push("extraHeaders");
} catch (e) { /* Firefox exposes them without the flag */ }

const CAPTURE_URLS = OMNI_WEB.flatMap((p) => p.perms);

chrome.webRequest.onBeforeSendHeaders.addListener((d) => {
  const provider = OMNI_WEB.find((p) => p.hostRe.test(d.url));
  if (!provider) return;
  const h = {};
  for (const x of (d.requestHeaders || [])) h[x.name.toLowerCase()] = x.value;
  const cookie = h["cookie"] || "";
  if (!cookie) return; // wait for a request that actually carries the session
  const auth = h["authorization"] || "";
  const token = /^bearer\s+\S/i.test(auth) ? auth.replace(/^bearer\s+/i, "").trim() : "";
  const capKey = "cap_" + provider.key;
  // Dedup: a busy page fires many XHR/s carrying the SAME cookie — only write (and repaint the badge)
  // when the credential actually changed, else we storm session storage + a full scan on every request.
  SEC.get(capKey).then((cur) => {
    const prev = cur[capKey];
    if (prev && prev.cookie === cookie && prev.token === token) return;
    const cap = {
      provider: provider.key, slug: provider.slug, label: provider.label,
      cookie, token, cookieCount: cookie.split(";").filter(Boolean).length, at: Date.now(),
    };
    cap.accountId = omniAccountId(omniBuildCredential(provider, cap)); // compute once at capture, not per refresh
    SEC.set({ [capKey]: cap }, updateBadge);
    // Opt-in: mirror to disk so the capture survives a browser restart (restartRecovery re-pushes it).
    getSettings().then((st) => { if (st.persistSessions) LOC.set({ [capKey]: cap }); });
  });
}, { urls: CAPTURE_URLS, types: ["xmlhttprequest"] }, captureOpts);

// Toolbar badge: RED with the count of dead connections when the last health sweep found any
// (that's the state worth shouting about); else BLUE with the count of captured-but-unsent sessions.
async function updateBadge() {
  const [sec, loc] = await Promise.all([SEC.get(null), LOC.get("health_dead")]);
  const caps = Object.keys(sec).filter((k) => k.startsWith("cap_") && sec[k]).length;
  const dead = (loc.health_dead || []).length;
  if (dead) { chrome.action.setBadgeText({ text: String(dead) }); chrome.action.setBadgeBackgroundColor({ color: "#dc2626" }); }
  else if (caps) { chrome.action.setBadgeText({ text: String(caps) }); chrome.action.setBadgeBackgroundColor({ color: "#3b6ef5" }); }
  else chrome.action.setBadgeText({ text: "" });
}
updateBadge();

// ── messaging ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((req, sender, send) => {
  switch (req.action) {
    case "getAll":
      SEC.get(null).then((all) => {
        const caps = {};
        for (const p of OMNI_WEB) {
          const c = all["cap_" + p.key];
          // slim (no raw cookie/token leaves the SW) + the account id used to build the connection name,
          // so the popup can predict "update vs new" without seeing the credential.
          caps[p.key] = c ? { provider: c.provider, slug: c.slug, label: c.label, cookieCount: c.cookieCount, at: c.at, accountId: c.accountId || omniAccountId(omniBuildCredential(p, c)) } : null;
        }
        send({ caps });
      });
      return true;
    case "send": sendToOmni(req.providerKey, req.name).then(send); return true;
    case "addApiKey": sendApiKeyToOmni(req.slug, req.name, req.apiKey, req.psd).then(send); return true;
    case "bulkAddApiKey": bulkAddApiKeys(req.slug, req.keys).then(send); return true;
    case "probe": realProbe(req.slug).then(send); return true;
    case "probeAll": probeAll(req.slugs || []).then(send); return true;
    case "connections": readConnections().then(send); return true;
    // Reachability check via the dashboard tab (runInDash) — NOT a direct fetch: Firefox blocks a direct
    // http fetch from the extension's secure moz-extension context to the http loopback (mixed content).
    case "ping": pingGateway().then((ok) => send({ ok })).catch(() => send({ ok: false })); return true;
    case "deleteConn": deleteConn(req.id).then(send); return true;
    case "updateConn": updateConn(req.id, req.patch).then(send); return true;
    case "getProbes":
      LOC.get(null).then((all) => {
        const probes = {};
        for (const k in all) if (k.startsWith("probe_")) probes[k.slice(6)] = all[k];
        send({ probes });
      });
      return true;
    case "clear": Promise.all([SEC.remove("cap_" + req.providerKey), LOC.remove("cap_" + req.providerKey)]).then(() => { updateBadge(); send({ ok: true }); }); return true;
    case "aistudioKey":
      if (req.key) SEC.set({ apikey_aistudio: { key: req.key, at: Date.now() } });
      send?.({ ok: true }); return true;
    case "oauthStart": oauthStart(req.provider).then(send); return true;
    case "oauthConnect": oauthConnect(req.provider).then(send); return true;
    case "oauthImport": oauthImport(req.provider, req.token).then(send); return true;
    case "oauthAutoImport": oauthAutoImport(req.provider).then(send); return true;
    case "zipImport": zipImport(req.provider, req.b64).then(send); return true;
    case "oauthState": oauthStates().then(send); return true;
    case "oauthCancel": oauthCancel(req.provider).then(send); return true;
    case "getSettings": getSettings().then((s) => send({ settings: s })); return true;
    case "setSettings": applySettings(req.settings).then((s) => send({ settings: s })); return true;
    case "sweepNow": healthSweep(true).then((r) => send({ ok: r !== false, ran: r !== false })); return true;
    case "clearProbes": clearProbes().then(() => send({ ok: true })); return true;
    default: return false;
  }
});

// ── add via the dashboard tab's session ─────────────────────────────────────
const INJECT_TIMEOUT = 12000;
let dashCreating = null; // single-flight tab creation — two concurrent callers must not spawn two tabs

async function getDashboardTab() {
  // 127.0.0.1 only — we navigate/create on 127.0.0.1 (a "localhost" tab is unreachable in Firefox and
  // would be a dead tab runInDash could pick and fail on). Keep this in sync with OMNI_BASE / tabs.create.
  const tabs = await chrome.tabs.query({ url: ["http://127.0.0.1:20128/*"] });
  if (tabs.length) return tabs[0];
  if (!dashCreating) {
    dashCreating = (async () => {
      const tab = await chrome.tabs.create({ url: "http://127.0.0.1:20128/home", active: false });
      await new Promise((resolve) => {
        const done = () => { clearTimeout(to); chrome.tabs.onUpdated.removeListener(l); resolve(); };
        const l = (id, info) => { if (id === tab.id && info.status === "complete") done(); };
        const to = setTimeout(done, 8000);
        chrome.tabs.onUpdated.addListener(l);
      });
      return tab;
    })().finally(() => { dashCreating = null; });
  }
  return dashCreating;
  // ponytail: at most ONE self-created background tab is ever reused (query finds it next time);
  // not auto-closed to avoid reopen-thrash. Upgrade: track+close when no flow is active.
}

function withTimeout(promise, ms, onTimeout) {
  return Promise.race([promise, new Promise((res) => setTimeout(() => res(onTimeout), ms))]);
}

async function injectOnce(tab, func, args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func, args });
  return res && "result" in res ? res.result : { ok: false, error: t("bg_injectEmpty") };
}

// Run a function in the dashboard page (MAIN world → same-origin, carries the HttpOnly session).
// Bounded by a timeout (a wedged local server must not hang the popup forever) and, if injection
// fails against a dead/error dashboard tab, reloads it once and retries (a tab opened while the
// server was down otherwise stays a chrome-error page and every later injection keeps failing).
async function runInDash(func, args, timeout = INJECT_TIMEOUT) {
  let tab;
  try { tab = await getDashboardTab(); } catch (e) { return { ok: false, error: t("bg_tabOpenFail", [String(e).slice(0, 80)]) }; }
  if (!tab) return { ok: false, error: t("bg_tabOpenFail2") };
  const attempt = () => injectOnce(tab, func, args).catch((e) => ({ ok: false, __injectErr: true, error: t("bg_injectFail", [String(e).slice(0, 100)]) }));
  const timeoutVal = { ok: false, error: t("bg_timeout") };
  let r = await withTimeout(attempt(), timeout, timeoutVal);
  if (r && r.__injectErr) {
    try { await chrome.tabs.reload(tab.id); await new Promise((res) => setTimeout(res, 1500)); } catch { /* tab gone */ }
    r = await withTimeout(attempt(), timeout, timeoutVal);
  }
  if (r && r.__injectErr) delete r.__injectErr;
  return r;
}

// ── gateway identity guard (don't hand credentials to a rogue :20128) ────────
function gatewayProbeInPage() {
  return fetch("/api/providers", { credentials: "include" })
    .then((r) => ({ ok: true, status: r.status, ct: r.headers.get("content-type") || "" }))
    .catch((e) => ({ ok: false, error: String(e).slice(0, 80) }));
}
let gatewayOk = false; // cache only a POSITIVE result — a transient failure must not block sends
// for the rest of the SW lifetime; re-probe until it verifies once.
async function ensureGateway() {
  if (gatewayOk) return true;
  const r = await runInDash(gatewayProbeInPage);
  // 401/403 = it IS OmniRoute, just not logged in (the POST then returns the proper "нужен логин").
  // A json 200 with the providers endpoint present is the positive identity signal.
  gatewayOk = !!(r && r.ok === true && (r.status === 401 || r.status === 403 || (r.status === 200 && String(r.ct).includes("application/json"))));
  return gatewayOk;
}
// Guard for every credential-writing path: returns an error object to bail with, or null if OK.
async function requireGateway() {
  return (await ensureGateway()) ? null : { ok: false, error: t("bg_notOmni") };
}
// Reachability for the popup status dot: direct fetch first (Chrome — no tab), fall back to the dashboard
// tab (Firefox blocks a direct http fetch from the extension's secure context to the http loopback).
async function pingGateway() {
  if (CAN_DIRECT_FETCH) {
    // Chrome: a direct fetch is fine and needs no tab. On any error, fall through to the tab path.
    try { return !!(await fetch(OMNI_BASE + "/api/providers", { method: "GET" })); } catch {}
  }
  const r = await runInDash(gatewayProbeInPage); // Firefox (and Chrome-fallback): via the dashboard tab
  return !!(r && r.ok === true);
}

// POST /api/providers (create only — NO lying auto-test; the popup probes for real separately).
// psd = optional providerSpecificData (e.g. { cx } for google-pse-search, { baseUrl } to override endpoint).
function postProviderInPage(slug, name, apiKey, authType, psd, loginErr) {
  const body = { provider: slug, authType, name, apiKey };
  if (psd && Object.keys(psd).length) body.providerSpecificData = psd;
  return fetch("/api/providers", {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const text = await r.text();
    if (r.status === 401 || r.status === 403) return { ok: false, error: loginErr };
    let p = {}; try { p = JSON.parse(text); } catch (x) {}
    if (r.status !== 201 && r.status !== 200) return { ok: false, error: typeof p.error === "string" ? p.error : "HTTP " + r.status };
    return { ok: true, id: p.connection && p.connection.id };
  }).catch((e) => ({ ok: false, error: String(e).slice(0, 120) }));
}

// Shared add tail: name = "<base> · <stable per-credential id>" so OmniRoute's UPSERT-by-name treats
// "same key re-added" as an update, but two DIFFERENT keys under one custom name stay separate.
async function postApiKey(slug, base, apiKey, psd) {
  const r = await runInDash(postProviderInPage, [slug, base + " · " + omniAccountId(apiKey), apiKey, "apikey", psd || null, t("bg_needLogin")]);
  return { ...r, slug };
}

async function sendToOmni(providerKey, name) {
  const provider = OMNI_WEB_MAP[providerKey];
  if (!provider) return { ok: false, error: t("bg_unknownProvider") };
  const gw = await requireGateway(); if (gw) return gw;
  const stored = await SEC.get("cap_" + providerKey);
  const cap = stored["cap_" + providerKey];
  if (!cap) return { ok: false, error: t("bg_noCapture") };
  const apiKey = omniBuildCredential(provider, cap);
  if (!apiKey) return { ok: false, error: t("bg_noCreds") };
  return postApiKey(provider.slug, (name && name.trim()) ? name.trim() : provider.label, apiKey);
}

async function sendApiKeyToOmni(slug, name, apiKey, psd) {
  if (!slug) return { ok: false, error: t("bg_noProvider") };
  apiKey = (apiKey || "").trim();
  if (!apiKey) return { ok: false, error: t("bg_emptyKey") };
  const gw = await requireGateway(); if (gw) return gw;
  return postApiKey(slug, (name && name.trim()) ? name.trim() : slug, apiKey, psd);
}

// Bulk add: several API keys of ONE provider at once (dashboard's bulkCreateProviderSchema).
function bulkApiKeyInPage(slug, entries, loginErr) {
  return fetch("/api/providers/bulk", {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: slug, entries }),
  }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) return { ok: false, error: loginErr };
    if ((r.ok || r.status === 201) && !(d && d.error)) return { ok: true, added: entries.length };
    return { ok: false, error: (d && d.error) || "HTTP " + r.status };
  }).catch((e) => ({ ok: false, error: String(e).slice(0, 120) }));
}
async function bulkAddApiKeys(slug, keys) {
  if (!slug) return { ok: false, error: t("bg_noProvider") };
  const clean = (keys || []).map((k) => (k || "").trim()).filter((k) => k.length >= 8);
  if (!clean.length) return { ok: false, error: t("bg_noValidKeys") };
  const gw = await requireGateway(); if (gw) return gw;
  // Each key gets a stable per-credential name+id (mirrors single-add) so re-adds UPSERT, not duplicate.
  const entries = clean.map((k) => ({ name: slug + " · " + omniAccountId(k), apiKey: k, accountId: omniAccountId(k) }));
  const r = await runInDash(bulkApiKeyInPage, [slug, entries, t("bg_needLogin")]);
  return { ...r, slug };
}

// ── live connections (what's actually in OmniRoute right now) ────────────────
// Distinguish "unreachable" (couldn't read) from "genuinely empty" — a down gateway must NOT look
// like "0 connections" (that inverts the honest-signal premise this extension is built on).
function readConnectionsInPage() {
  return fetch("/api/providers", { credentials: "include" })
    .then((r) => (r.ok ? r.json().then((d) => ({ ok: true, connections: d.connections || [] })) : { ok: false, error: "HTTP " + r.status }))
    .catch((e) => ({ ok: false, error: String(e).slice(0, 100) }));
}
async function readConnections() {
  const res = await runInDash(readConnectionsInPage); // runInDash already reloads a dead tab + retries internally
  if (!res || res.ok !== true || !Array.isArray(res.connections)) {
    return { byProvider: {}, total: 0, problems: [], unreachable: true, error: (res && res.error) || t("bg_noData") };
  }
  const list = res.connections.map((c) => ({ provider: c.provider, id: c.id, name: c.name || "", testStatus: c.testStatus, hasError: !!c.errorCode, isActive: c.isActive !== false }));
  const byProvider = {};
  const problems = [];
  for (const c of list) {
    const bad = c.hasError || c.testStatus === "banned" || c.testStatus === "error";
    const g = byProvider[c.provider] || (byProvider[c.provider] = { total: 0, good: 0, bad: 0, names: [] });
    g.total++;
    if (c.name) g.names.push(c.name);
    if (bad) { g.bad++; problems.push({ provider: c.provider, id: c.id, name: c.name, isActive: c.isActive }); }
    else if (c.testStatus === "active") g.good++;
  }
  // Seed the slug snapshot for the unattended health sweep (so it can probe without opening a tab).
  LOC.set({ conn_slugs: Object.keys(byProvider) });
  return { byProvider, total: list.length, problems, all: list, unreachable: false };
}

// Delete a specific connection (used to clear dead/banned accounts from the popup).
function deleteConnInPage(id) {
  return fetch("/api/providers/" + id, { method: "DELETE", credentials: "include" })
    .then((r) => ({ ok: r.ok, status: r.status }))
    .catch((e) => ({ ok: false, error: String(e).slice(0, 100) }));
}
async function deleteConn(id) { return runInDash(deleteConnInPage, [id]); }

// Update an existing connection (rename / enable-disable / priority) — PATCH /api/providers/<id>.
function updateConnInPage(id, patch, loginErr) {
  return fetch("/api/providers/" + id, {
    method: "PATCH", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
  }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) return { ok: false, error: loginErr };
    return (r.ok && !(d && d.error)) ? { ok: true } : { ok: false, error: (d && d.error) || "HTTP " + r.status };
  }).catch((e) => ({ ok: false, error: String(e).slice(0, 100) }));
}
async function updateConn(id, patch) {
  if (!id || !patch || typeof patch !== "object") return { ok: false, error: t("bg_noIdData") };
  const gw = await requireGateway(); if (gw) return gw;
  return runInDash(updateConnInPage, [id, patch, t("bg_needLogin")]);
}

// ── real probe (honest "does it work") ──────────────────────────────────────
// The gateway is open locally (tokens:[]), so /v1 needs no dashboard session — but the fetch is proxied
// THROUGH the dashboard tab (runInDash) so Firefox mixed-content doesn't block a direct http fetch from
// the extension's secure moz-extension context. Result is persisted (probe_<slug>) so the popup can show
// the last verdict after it reopens.
let _modelsCache = null; // { at, models } — /v1/models rarely changes; a short TTL collapses back-to-back probes' refetches
// Fetch /v1/models FROM the dashboard tab, not a direct SW fetch: Firefox blocks a direct http fetch
// from the extension's secure context to the http loopback (mixed content). The tab is http→http.
function fetchModelsInPage() {
  return fetch("/v1/models")
    .then((r) => (r.ok ? r.json().then((d) => ({ fetched: true, ok: true, models: d.data || [] })) : { fetched: true, ok: false }))
    .catch(() => ({ fetched: true, ok: false }));
}
async function fetchModels() {
  if (_modelsCache && Date.now() - _modelsCache.at < 45000) return { ok: true, models: _modelsCache.models };
  if (CAN_DIRECT_FETCH) {
    // Chrome: direct, no tab. A non-ok response is a real answer (don't tab-retry); only a throw falls through.
    try {
      const mr = await fetch(OMNI_BASE + "/v1/models");
      if (mr.ok) { const models = (await mr.json()).data || []; _modelsCache = { at: Date.now(), models }; return { ok: true, models }; }
      return { ok: false };
    } catch {}
  }
  const r = await runInDash(fetchModelsInPage); // Firefox: via the dashboard tab (a direct fetch hangs)
  if (r && r.ok && Array.isArray(r.models)) { _modelsCache = { at: Date.now(), models: r.models }; return { ok: true, models: r.models }; }
  return { ok: false };
}
// One real completion against the provider's first model. 5xx / network → ONE retry (transient
// upstream); 4xx → real auth verdict, no retry. Shared by single probe, batch, and health sweep.
// The completion probe runs IN the dashboard tab (http→http) — a direct SW fetch to the http loopback is
// blocked by Firefox mixed content. The page fn returns a plain verdict (a Response can't cross
// executeScript); `fetched:true` marks a real page result vs a runInDash-level inject/timeout failure.
function chatProbeInPage(modelId) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 30000); // self-abort so a hung fetch doesn't orphan past runInDash's cap
  return fetch("/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal,
    body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
  }).then(async (r) => {
    let msg = "HTTP " + r.status; try { msg = ((await r.json()).error || {}).message || msg; } catch (e) {}
    return { fetched: true, ok: r.ok, status: r.status, msg };
  }).catch((e) => ({ fetched: true, netErr: true, msg: String(e).slice(0, 120) })).finally(() => clearTimeout(to));
}
// Direct completion probe first (Chrome — no tab); on throw (Firefox mixed content) fall back to the tab.
async function chatProbe(modelId) {
  const body = JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1 });
  if (CAN_DIRECT_FETCH) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 30000);
      const r = await fetch(OMNI_BASE + "/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal, body,
      }).finally(() => clearTimeout(to));
      let msg = "HTTP " + r.status; try { msg = ((await r.json()).error || {}).message || msg; } catch (e) {}
      return { fetched: true, ok: r.ok, status: r.status, msg };
    } catch (e) {
      if (e && e.name === "AbortError") return { fetched: true, netErr: true, msg: t("bg_probeAbort") };
      // any other direct error → fall through to the tab
    }
  }
  const r = await runInDash(chatProbeInPage, [modelId], 32000); // Firefox: via the tab (a direct fetch hangs)
  if (r && r.fetched) return r;
  return { fetched: true, netErr: true, msg: String((r && r.error) || "").slice(0, 120) };
}
async function probeModel(models, slug) {
  const m = models.find((x) => typeof x.id === "string" && x.id.startsWith(slug + "/"));
  if (!m) return { alive: null, detail: t("bg_noModelsForProbe") };
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chatProbe(m.id); // direct in Chrome, dashboard-tab fallback in Firefox
    // runInDash-level failure (inject error / timeout) → retry once, then UNKNOWN (not "dead").
    if (!r || !r.fetched) {
      if (attempt === 0) continue;
      return { alive: null, model: m.id, detail: t("bg_probeTimeout", [String((r && r.error) || t("bg_noAnswer")).slice(0, 100)]) };
    }
    if (r.netErr) { if (attempt === 0) continue; return { alive: null, model: m.id, detail: String(r.msg).slice(0, 120) }; }
    if (r.ok) return { alive: true, model: m.id, detail: t("bg_answered200") };
    if (r.status >= 500 && attempt === 0) continue; // transient upstream → retry once
    // 429 = rate-limited, NOT dead — the account is almost certainly authenticated, just throttled.
    // A persistent 5xx is a provider-side blip, not a verified auth failure → don't flag either as dead.
    if (r.status === 429) return { alive: null, model: m.id, status: 429, detail: t("bg_rateLimited") };
    if (r.status >= 500) return { alive: null, model: m.id, status: r.status, detail: t("bg_provider5xx", [String(r.msg).slice(0, 110)]) };
    return { alive: false, model: m.id, status: r.status, detail: String(r.msg).slice(0, 140) };
  }
  return { alive: null, detail: t("bg_probeFailed") };
}
async function runProbe(slug) {
  const mm = await fetchModels();
  if (!mm.ok) return { alive: null, detail: t("bg_noModelsAccess") };
  return probeModel(mm.models, slug);
}
async function realProbe(slug) {
  const result = await runProbe(slug);
  LOC.set({ ["probe_" + slug]: { ...result, at: Date.now() } });
  return result;
}

// Batch health-check: fetch the model list ONCE, then probe each provider. A down gateway reports
// "нет доступа к /v1/models" (distinct from a provider that genuinely has no models).
let probing = false; // a probe pass is running — the unattended sweep steps aside so they don't double-load /v1
async function probeAll(slugs, emit = true) {
  probing = true;
  try {
    const mm = await fetchModels();
    const models = mm.ok ? mm.models : [];
    const out = {};
    const now = Date.now();
    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i];
      out[slug] = models.length ? await probeModel(models, slug) : { alive: null, detail: mm.ok ? t("bg_noModels") : t("bg_noModelsAccess") };
      // Persist each verdict as it lands, NOT one batch at the end: every verdict costs a real
      // completion against the provider, and an MV3 worker can be killed mid-sweep — batching traded
      // the whole run's work for saving a few microsecond-cheap storage writes.
      await LOC.set({ ["probe_" + slug]: { ...out[slug], at: now } });
      // emit=false for the unattended sweep: it must NOT drive the popup's user-initiated progress bar
      // (which would animate a run the user never started and then stick, since the sweep sends no "done").
      if (emit) try { chrome.runtime.sendMessage({ type: "probeProgress", done: i + 1, total: slugs.length, slug, alive: out[slug].alive }); } catch (e) { /* popup closed */ }
    }
    return { results: out };
  } finally { probing = false; }
}

// ── unattended health sweep (badge/notify when a connection dies) ────────────
// ponytail: probes EVERY known connection every 15 min with a real 1-token completion — costs a
// hair on paid tiers and can trip rate-limits (e.g. kiro 429). Upgrade: per-provider "skip in sweep"
// opt-out. Uses the popup-seeded conn_slugs snapshot. Probes go direct (Chrome — no tab); only when a
// direct fetch is blocked (Firefox mixed content) do they fall back through the dashboard tab.
const HEALTH_ALARM = "health_sweep";
async function healthSweep(force = false) {
  if (probing) return false; // a manual "Проверить все" is running — don't double-probe /v1
  const st = await getSettings();
  if (!force && !st.sweep) return; // sweep disabled in settings (manual "проверить сейчас" passes force)
  const { conn_slugs, last_active } = await LOC.get(["conn_slugs", "last_active"]);
  // Don't burn quota unattended forever: only sweep if the popup was used in the last 24h.
  if (!force && last_active && Date.now() - last_active > 24 * 60 * 60 * 1000) return;
  // Honour the per-provider opt-out (settings.sweepSkip): an unattended probe costs a real completion,
  // so a provider the user marked "don't probe" must not be touched here. The manual "Проверить все"
  // ignores this list on purpose — that run is user-initiated and its cost is a deliberate choice.
  const skip = new Set(st.sweepSkip || []);
  const slugs = (conn_slugs || []).filter((s) => !skip.has(s));
  if (!slugs.length) { await LOC.set({ health_dead: [], last_sweep: Date.now() }); updateBadge(); return; } // clear a stale red badge
  const { results } = await probeAll(slugs, false); // emit=false: unattended — don't drive the popup progress bar
  const dead = Object.keys(results).filter((s) => results[s].alive === false);
  const prev = (await LOC.get("health_dead")).health_dead || [];
  const fresh = dead.filter((s) => !prev.includes(s));
  await LOC.set({ health_dead: dead, last_sweep: Date.now() });
  updateBadge();
  try { chrome.runtime.sendMessage({ type: "healthSwept" }); } catch (e) { /* popup closed — badge already updated */ }
  if (fresh.length && st.notify && chrome.notifications) {
    const names = fresh.map((s) => (OMNI_WEB_MAP[s] && OMNI_WEB_MAP[s].label) || s).join(", ");
    try {
      chrome.notifications.create("omnihealth_" + Date.now(), {
        type: "basic", iconUrl: "icons/icon128.png", requireInteraction: true, // a dead connection is worth a sticky toast
        title: t("bg_notifyTitle"), message: "🔴 " + names,
      });
    } catch (e) { /* notifications permission absent → badge still turns red */ }
  }
}
// Clear cached probe verdicts + the dead-connection snapshot (a clean slate; badge goes neutral).
async function clearProbes() {
  const all = await LOC.get(null);
  const rm = Object.keys(all).filter((k) => k.startsWith("probe_"));
  rm.push("health_dead");
  await LOC.remove(rm);
  updateBadge();
}
// Persist settings; reschedule (or disable) the sweep alarm to match.
async function applySettings(patch) {
  const prev = await getSettings();
  const next = { ...prev, ...(patch || {}) };
  await LOC.set({ settings: next });
  chrome.alarms.clear(HEALTH_ALARM);
  if (next.sweep) chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: Math.max(5, next.sweepMin || 15), delayInMinutes: 1 });
  // Turning persistence off must not leave captured secrets on disk — purge the mirrored copies.
  if (prev.persistSessions && !next.persistSessions) {
    const all = await LOC.get(null);
    const stale = Object.keys(all).filter((k) => k.startsWith("cap_"));
    if (stale.length) await LOC.remove(stale);
  }
  return next;
}

// ── OAuth device_code flow (alarms-driven, survives popup close / SW sleep) ──
function oauthDeviceCodeInPage(provider) {
  return fetch("/api/oauth/" + provider + "/device-code", { credentials: "include" })
    .then((r) => r.ok ? r.json() : r.text().then((t) => ({ error: t || "HTTP " + r.status })))
    .catch((e) => ({ error: String(e).slice(0, 120) }));
}
function oauthPollInPage(provider, deviceCode, codeVerifier, extraData) {
  return fetch("/api/oauth/" + provider + "/poll", {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode, codeVerifier, extraData: extraData || null }),
  }).then((r) => (r.ok ? r.json() : { error: "authorization_pending" })) // OmniRoute returns 200 for real verdicts; a non-200 is a transient gateway blip → keep waiting, don't kill the flow
    .catch(() => ({ error: "authorization_pending" }));
}
// Redirect/PKCE flows: OmniRoute starts a loopback callback server (self-completing) and we poll it —
// same shape as device poll. Fallback = /authorize giving an authUrl that lands on OmniRoute's /callback.
function oauthStartCallbackInPage(provider) {
  return fetch("/api/oauth/" + provider + "/start-callback-server", { credentials: "include" })
    .then((r) => r.ok ? r.json() : r.text().then((t) => ({ error: t || "HTTP " + r.status })))
    .catch((e) => ({ error: String(e).slice(0, 120) }));
}
function oauthAuthorizeInPage(provider, redirectUri) {
  return fetch("/api/oauth/" + provider + "/authorize?redirect_uri=" + encodeURIComponent(redirectUri), { credentials: "include" })
    .then((r) => r.ok ? r.json() : r.text().then((t) => ({ error: t || "HTTP " + r.status })))
    .catch((e) => ({ error: String(e).slice(0, 120) }));
}
// Redirect completion is detected UNIVERSALLY by a new connection appearing for the provider —
// works whether OmniRoute finished it via the loopback callback server OR its own /callback page
// (the poll-callback endpoint only covers the former, so counting connections is the robust signal).
function allConnCountsInPage() {
  return fetch("/api/providers", { credentials: "include" })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => { const m = {}; for (const c of (d.connections || [])) m[c.provider] = (m[c.provider] || 0) + 1; return m; })
    .catch(() => null);
}
let _connCount = null; // { at, all } — short memo so baseCount + first poll + concurrent redirect flows share one read
async function providerConnCount(provider) {
  if (!_connCount || Date.now() - _connCount.at > 2000) {
    const map = await runInDash(allConnCountsInPage);
    // A real count map is { slug: number } with NO `ok` field; runInDash returns { ok:false, error } on
    // ANY failure (timeout/inject/no-tab) — those must map to null (→ -1), NOT be read as count 0.
    _connCount = { at: Date.now(), all: (map && typeof map === "object" && map.ok === undefined) ? map : null };
  }
  return _connCount.all ? (_connCount.all[provider] || 0) : -1; // -1 = couldn't read (abort/keep-pending semantics)
}
// Auto-import: OmniRoute reads the provider's CLI creds already stored locally on the machine.
function oauthAutoImportInPage(provider) {
  return fetch("/api/oauth/" + provider + "/auto-import", { credentials: "include" })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => ({ ok: true, found: !!d.found, token: d.refreshToken || d.token || "" }))
    .catch(() => ({ ok: false }));
}
// Import-token flows: user pastes a CLI/session token; OmniRoute validates + creates the connection.
function oauthImportTokenInPage(provider, token, loginErr) {
  return fetch("/api/oauth/" + provider + "/import-token", {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, connectionId: null }),
  }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) return { ok: false, error: loginErr };
    // Trust success only on a 2xx WITHOUT an error field (some endpoints return 200 + {error}).
    if ((r.ok || r.status === 201) && !(d && d.error)) return { ok: true, id: d.connection && d.connection.id };
    return { ok: false, error: (d && d.error) || "HTTP " + r.status };
  }).catch((e) => ({ ok: false, error: String(e).slice(0, 120) }));
}
// Paste-credentials: some providers export an "omniroute-cred-v1.…" blob instead of a bare token.
function oauthPasteCredsInPage(provider, blob, loginErr) {
  return fetch("/api/oauth/" + provider + "/paste-credentials", {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" },
    body: JSON.stringify({ blob, connectionId: null }),
  }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) return { ok: false, error: loginErr };
    return ((r.ok || r.status === 201) && !(d && d.error)) ? { ok: true, id: d.connection && d.connection.id } : { ok: false, error: (d && d.error) || "HTTP " + r.status };
  }).catch((e) => ({ ok: false, error: String(e).slice(0, 120) }));
}
const OAUTH_KEY = (slug) => "oauth_" + slug;

async function oauthStart(provider) {
  const p = OMNI_OAUTH.find((o) => o.slug === provider);
  if (!p || !p.deviceFlow) return { ok: false, error: t("bg_notDeviceFlow") };
  const gw = await requireGateway(); if (gw) return gw;
  const d = await runInDash(oauthDeviceCodeInPage, [provider]);
  if (!d || d.error || !d.device_code) return { ok: false, error: (d && d.error) || t("bg_providerUnavailable") };
  // Some providers (kiro / amazon-q, AWS SSO) echo client creds back — the poll needs them.
  const extraData = (d._clientId || d._clientSecret || d._region)
    ? { _clientId: d._clientId, _clientSecret: d._clientSecret, _region: d._region } : null;
  const state = {
    provider, label: p.label, kind: "device", deviceCode: d.device_code, codeVerifier: d.codeVerifier || "", extraData,
    userCode: d.user_code, verifyUrl: d.verification_uri_complete || d.verification_uri || "",
    expiresAt: Date.now() + (d.expires_in || 899) * 1000, status: "pending", detail: "", at: Date.now(),
    interval: d.interval || 5, nextPollAt: 0, // device-flow poll cadence (see pollProvider) — RFC 8628 default 5s
  };
  await SEC.set({ [OAUTH_KEY(provider)]: state });
  if (state.verifyUrl) chrome.tabs.create({ url: state.verifyUrl });
  chrome.alarms.create("oauth_poll", { periodInMinutes: 0.5 });
  return { ok: true, userCode: state.userCode, verifyUrl: state.verifyUrl };
}

// Redirect/PKCE: open the provider auth page; OmniRoute's callback server completes it. We poll
// poll-callback (device-like) until the connection lands. Prefer the callback server; fall back to
// a plain /authorize whose authUrl redirects to OmniRoute's own /callback page.
async function oauthConnect(provider) {
  const p = OMNI_OAUTH.find((o) => o.slug === provider);
  if (!p || p.kind !== "redirect") return { ok: false, error: t("bg_notRedirect") };
  const gw = await requireGateway(); if (gw) return gw;
  let d = await runInDash(oauthStartCallbackInPage, [provider]);
  let authUrl = d && d.authUrl;
  if (!authUrl) {
    const a = await runInDash(oauthAuthorizeInPage, [provider, OMNI_BASE + "/callback"]);
    authUrl = a && a.authUrl;
    if (!authUrl) return { ok: false, error: (a && a.error) || (d && d.error) || t("bg_noBrowserLogin") };
  }
  // Abort if we can't read a trustworthy baseline — a defaulted 0 would make a pre-existing
  // connection look like a fresh success on the very next poll (false "Подключено").
  _connCount = null; // fresh baseline read, not a memoized one
  const baseCount = await providerConnCount(provider);
  if (typeof baseCount !== "number" || baseCount < 0) return { ok: false, error: t("bg_connReadFail") };
  const state = {
    provider, label: p.label, kind: "redirect", status: "pending", detail: "", verifyUrl: authUrl,
    baseCount,
    at: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000, nextPollAt: 0, interval: 3,
  };
  await SEC.set({ [OAUTH_KEY(provider)]: state });
  chrome.tabs.create({ url: authUrl });
  chrome.alarms.create("oauth_poll", { periodInMinutes: 0.5 });
  return { ok: true, verifyUrl: authUrl };
}

// Import-token: paste a CLI/session token → OmniRoute creates the connection (create-only; probe separately).
async function oauthImport(provider, token) {
  const p = OMNI_OAUTH.find((o) => o.slug === provider);
  if (!p) return { ok: false, error: t("bg_unknownProvider") };
  token = (token || "").trim();
  if (!token) return { ok: false, error: t("bg_emptyToken") };
  if (token.length < 8) return { ok: false, error: t("bg_tokenShort") };
  const gw = await requireGateway(); if (gw) return gw;
  // Accept EITHER a bare token (import-token) OR an exported "omniroute-cred-v1.…" blob (paste-credentials).
  const inPage = token.startsWith("omniroute-cred-v1.") ? oauthPasteCredsInPage : oauthImportTokenInPage;
  const r = await runInDash(inPage, [provider, token, t("bg_needLogin")]);
  return { ...r, slug: provider };
}

// Auto-import: try to detect the provider's CLI creds already on the machine, then import them.
// Best-effort — falls back to manual paste on "not found" / server error.
async function oauthAutoImport(provider) {
  const p = OMNI_OAUTH.find((o) => o.slug === provider);
  if (!p) return { ok: false, error: t("bg_unknownProvider") };
  const gw = await requireGateway(); if (gw) return gw;
  const d = await runInDash(oauthAutoImportInPage, [provider]);
  if (d && d.error) return { ok: false, error: t("bg_omniUnreachable", [String(d.error)]) }; // runInDash-level failure (timeout/inject) ≠ "not found"
  if (!d || d.ok !== true || !d.found || !d.token) return { ok: false, error: t("bg_noLocalCreds") };
  const r = await runInDash(oauthImportTokenInPage, [provider, d.token, t("bg_needLogin")]);
  return { ...r, slug: provider };
}

// Bulk ZIP import: a .zip of many exported accounts → extract (raw octet-stream) → import-bulk.
// The file can't cross executeScript args (only JSON), so the popup sends base64 and we rebuild the
// bytes in-page.
function zipExtractInPage(authSlug, b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return fetch("/api/providers/" + authSlug + "/zip-extract", {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/octet-stream" }, body: arr,
  }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, entries: d.entries || d.accounts || [] } : { ok: false, error: d.error || "HTTP " + r.status };
  }).catch((e) => ({ ok: false, error: String(e).slice(0, 120) }));
}
function importBulkInPage(authSlug, entries) {
  return fetch("/api/providers/" + authSlug + "/import-bulk", {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries }),
  }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    return (r.ok || r.status === 201) && !(d && d.error) ? { ok: true, added: (d.imported || entries).length || entries.length } : { ok: false, error: (d && d.error) || "HTTP " + r.status };
  }).catch((e) => ({ ok: false, error: String(e).slice(0, 120) }));
}
async function zipImport(provider, b64) {
  const p = OMNI_OAUTH.find((o) => o.slug === provider);
  if (!p || !p.zipAuth) return { ok: false, error: t("bg_noZipSupport") };
  if (!b64) return { ok: false, error: t("bg_noFile") };
  const gw = await requireGateway(); if (gw) return gw;
  const ex = await runInDash(zipExtractInPage, [p.zipAuth, b64]);
  if (!ex || ex.ok !== true) return { ok: false, error: (ex && ex.error) || t("bg_zipExtractFail") };
  if (!ex.entries.length) return { ok: false, error: t("bg_zipEmpty") };
  const r = await runInDash(importBulkInPage, [p.zipAuth, ex.entries]);
  return { ...r, slug: provider };
}

// Poll ONE provider's pending flow → updated state (state is stored per-provider, so concurrent
// flows for DIFFERENT providers never clobber each other; the single-flight guard on pollAllOauth
// prevents two concurrent passes over the SAME provider from double-hitting /poll → slow_down).
async function pollProvider(slug) {
  const key = OAUTH_KEY(slug);
  const { [key]: s } = await SEC.get(key);
  if (!s || s.status !== "pending") return s || null;
  if (Date.now() > s.expiresAt) {
    const done = { ...s, status: "expired", detail: t("bg_codeExpired") };
    await SEC.set({ [key]: done }); return done;
  }
  // Respect the device-flow polling interval. GitHub (interval:5) returns slow_down — and then
  // WITHHOLDS the token indefinitely — if polled faster than allowed. The popup refreshes every 3s,
  // so gate the actual /poll hit here by nextPollAt, regardless of how often pollAllOauth runs.
  const interval = s.interval || 5;
  if (s.nextPollAt && Date.now() < s.nextPollAt) return s;
  // Redirect flows: success = a NEW connection for this provider appeared (universal signal — covers
  // both the loopback callback server and OmniRoute's own /callback page completing the exchange).
  if (s.kind === "redirect") {
    const n = await providerConnCount(s.provider);
    if (typeof n === "number" && n > (s.baseCount || 0)) {
      const done = { ...s, status: "success", detail: t("bg_connected") };
      await SEC.set({ [key]: done }); return done;
    }
    const wait = { ...s, nextPollAt: Date.now() + interval * 1000 };
    await SEC.set({ [key]: wait }); return wait;
  }
  // Device flow: poll the token endpoint.
  const r = await runInDash(oauthPollInPage, [s.provider, s.deviceCode, s.codeVerifier, s.extraData]);
  if (r && r.success === true) {
    const done = { ...s, status: "success", connId: (r.connection && r.connection.id) || s.connId, detail: t("bg_connected") };
    await SEC.set({ [key]: done }); return done;
  }
  if (r && r.error === "slow_down") {
    // RFC 8628 / GitHub: add 5s to the interval on every slow_down and back off before the next hit.
    const backed = { ...s, interval: interval + 5, nextPollAt: Date.now() + (interval + 5) * 1000 };
    await SEC.set({ [key]: backed }); return backed;
  }
  if (r && r.error && r.error !== "authorization_pending") {
    const done = { ...s, status: "error", detail: r.errorDescription || r.error };
    await SEC.set({ [key]: done }); return done;
  }
  const next = { ...s, nextPollAt: Date.now() + interval * 1000 }; // still pending — hold off `interval` seconds
  await SEC.set({ [key]: next }); return next;
}

// Poll ALL pending flows (alarm-driven + on popup open). Single-flight: concurrent callers (the 30s
// alarm and the popup's 3s refresh) share ONE in-flight pass so they can't both clear a provider's
// interval gate and double-hit /poll. Clears the alarm when none remain pending.
let pollInFlight = null;
function pollAllOauth() {
  if (pollInFlight) return pollInFlight;
  pollInFlight = (async () => {
    // Fetch only the known oauth_<slug> keys (not SEC.get(null), which would also scan every cookie blob).
    const all = await SEC.get(OMNI_OAUTH.map((o) => OAUTH_KEY(o.slug)));
    const slugs = OMNI_OAUTH.map((o) => o.slug).filter((slug) => all[OAUTH_KEY(slug)]);
    const states = {}; let anyPending = false;
    for (const slug of slugs) {
      try {
        const s = await pollProvider(slug);
        if (s) states[slug] = s;
        if (s && s.status === "pending") anyPending = true;
      } catch (e) { anyPending = true; /* transient — keep the alarm alive to retry */ }
    }
    if (!anyPending) chrome.alarms.clear("oauth_poll");
    return states;
  })().finally(() => { pollInFlight = null; });
  return pollInFlight;
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "oauth_poll") pollAllOauth().catch((e) => console.warn("[omni] oauth poll failed", e));
  else if (a.name === HEALTH_ALARM) healthSweep().catch((e) => console.warn("[omni] health sweep failed", e));
});
// Only arm the sweep if it isn't ALREADY scheduled — alarms persist across SW restarts, and a bare
// create() at module top level would re-fire delayInMinutes on every SW cold-start (collapsing the
// 15-min cadence to ~2 min → ~7× the completion cost, or starving it when wakes are frequent).
getSettings().then((st) => {
  if (!st.sweep) { chrome.alarms.clear(HEALTH_ALARM); return; }
  chrome.alarms.get(HEALTH_ALARM, (a) => { if (!a) chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: Math.max(5, st.sweepMin || 15), delayInMinutes: 2 }); });
});

// ── restart recovery ────────────────────────────────────────────────────────
// chrome.storage.session is wiped on browser restart, so on a cold start the web-session connections
// have no capture to refresh and sit red until each is re-imported by hand. When persistSessions is on,
// captures are mirrored to .local; here we rehydrate them into session and re-push each to OmniRoute
// (POST /api/providers UPSERTs by name — the same path as a manual re-import), then re-probe so the
// badge reflects reality. Fires once per browser launch.
// ponytail: sequential best-effort; a stale cookie just stays red, same as today. If the MV3 worker is
// killed mid-loop the next health sweep still converges — upgrade to a resumable queue only if it bites.
async function restartRecovery() {
  const st = await getSettings();
  if (!st.persistSessions) return;
  const all = await LOC.get(null);
  const capKeys = Object.keys(all).filter((k) => k.startsWith("cap_") && all[k]);
  if (!capKeys.length) return;
  // Bury the corpses BEFORE hydrating: past CAP_DISK_TTL_MS a capture can't authenticate anything, so
  // it's a secret kept on disk for nothing — and re-pushing it would only overwrite OmniRoute's copy
  // with the same dead cookie. Purging here (not later) keeps expired creds out of session storage too.
  const now = Date.now();
  const expired = capKeys.filter((k) => !all[k].at || now - all[k].at > CAP_DISK_TTL_MS);
  if (expired.length) await LOC.remove(expired);
  const live = capKeys.filter((k) => !expired.includes(k));
  // Record even when everything expired: burying N corpses IS what this run did, and without the line
  // the popup would report "ещё не запускалось" straight after doing it.
  if (!live.length) {
    await LOC.set({ last_recovery: { at: Date.now(), restored: 0, purged: expired.length, unreachable: false } });
    return;
  }
  const sec = await SEC.get(null);
  const toHydrate = {};
  for (const k of live) if (!sec[k]) toHydrate[k] = all[k]; // don't clobber a fresher in-session capture
  if (Object.keys(toHydrate).length) { await SEC.set(toHydrate); updateBadge(); }
  // Re-push ONLY to refresh sessions OmniRoute still has — never resurrect a connection the user
  // deleted in the dashboard (its cap_ can linger on disk). If OmniRoute is unreachable we can't verify
  // existence, so skip the re-push rather than blind-recreate; the health sweep below still runs.
  const conns = await readConnections();
  const existing = conns.unreachable ? null : new Set(Object.keys(conns.byProvider || {}));
  const restored = [];
  if (existing) {
    for (const k of live) {
      const slug = (OMNI_WEB_MAP[k.slice(4)] || {}).slug;
      if (slug && existing.has(slug)) {
        try {
          const r = await sendToOmni(k.slice(4));
          if (r && r.ok) restored.push(slug);
        } catch (e) { /* one bad slug must not stop the rest */ }
      }
    }
  }
  // Leave a trace: this runs unattended at browser launch, so without a record the user cannot tell
  // whether the thing that exists to save their morning did anything. The popup renders it next to
  // "Последняя проверка" (same `ago()` line, one glance).
  await LOC.set({ last_recovery: { at: Date.now(), restored: restored.length, purged: expired.length, unreachable: !existing } });
  // Refresh the badge after re-push — but honor the user's choice if they disabled health checks.
  if (st.sweep) { try { await healthSweep(true); } catch (e) { /* badge refresh is best-effort */ } }
}
chrome.runtime.onStartup.addListener(() => { restartRecovery().catch((e) => console.warn("[omni] restart recovery failed", e)); });

async function oauthStates() { return { states: await pollAllOauth() }; }
async function oauthCancel(slug) { if (slug) await SEC.remove(OAUTH_KEY(slug)); return { ok: true }; }
