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
const SETTINGS_DEFAULT = { sweep: true, sweepMin: 15, notify: true, theme: "auto", persistSessions: true, sweepSkip: [], autoRepair: true, nightly: true };

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
  let token = /^bearer\s+\S/i.test(auth) ? auth.replace(/^bearer\s+/i, "").trim() : "";
  const capKey = "cap_" + provider.key;
  capSeen[provider.key] = Date.now(); // a refresh run waits on this, even when the cookie didn't change
  // Dedup: a busy page fires many XHR/s carrying the SAME cookie — only write (and repaint the badge)
  // when the credential actually changed, else we storm session storage + a full scan on every request.
  SEC.get(capKey).then((cur) => {
    const prev = cur[capKey];
    // Not every request of a site carries the Bearer (DeepSeek's static calls don't) — a request without
    // one must not wipe the token an earlier request delivered.
    if (!token && prev && prev.token) token = prev.token;
    if (prev && prev.cookie === cookie && prev.token === token) { maybeAutoAdd(provider.key); return; }
    // Analytics cookies change on nearly every request; only a change of the SESSION part is a new
    // capture. Otherwise keep `at` (so a sent capture doesn't pop back into "ready to send" every few
    // seconds) and just refresh the stored header, at most once a minute.
    const sk = sessionKey(provider, cookie, token);
    if (prev && sk && prev.sessKey === sk) {
      if (Date.now() - (prev.seenAt || prev.at) > 60000) SEC.set({ [capKey]: { ...prev, cookie, seenAt: Date.now() } });
      maybeAutoAdd(provider.key); return;
    }
    const cap = {
      provider: provider.key, slug: provider.slug, label: provider.label,
      cookie, token, cookieCount: cookie.split(";").filter(Boolean).length, at: Date.now(), sessKey: sk,
    };
    cap.accountId = omniAccountId(omniBuildCredential(provider, cap)); // compute once at capture, not per refresh
    cap.email = omniAccountEmail(omniBuildCredential(provider, cap));
    SEC.set({ [capKey]: cap }, () => { updateBadge(); maybeAutoAdd(provider.key); });
    // Opt-in: mirror to disk so the capture survives a browser restart (restartRecovery re-pushes it).
    getSettings().then((st) => { if (st.persistSessions) LOC.set({ [capKey]: cap }); });
  });
}, { urls: CAPTURE_URLS, types: ["xmlhttprequest"] }, captureOpts);

// When the user was sent to log in (wizard / "добить недостающих"), the popup is already closed by the
// time the site sends its first authenticated XHR — so the SW finishes the job itself: push the fresh
// capture, probe it, and say so with a toast. One-shot per provider, expires after 15 min.
const AUTOADD_TTL_MS = 15 * 60 * 1000;
const autoAdding = new Set();
if (chrome.cookies && chrome.cookies.onChanged) chrome.cookies.onChanged.addListener((ch) => {
  if (ch.removed || !ch.cookie) return;
  const dom = String(ch.cookie.domain || "").replace(/^\./, "");
  for (const p of OMNI_WEB) {
    if (p.cred.t !== "cookie" || !(p.host === dom || p.host.endsWith("." + dom) || dom.endsWith(p.host))) continue;
    LOC.get("autoadd_" + p.key).then(async (r) => {
      if (!r["autoadd_" + p.key]) return;
      await captureFromStore(p); // then the shared one-shot path checks the session and pushes
      maybeAutoAdd(p.key);
    });
  }
});
async function maybeAutoAdd(key) {
  if (autoAdding.has(key)) return;
  const k = "autoadd_" + key;
  const { [k]: since } = await LOC.get(k);
  if (!since) return;
  if (Date.now() - since > AUTOADD_TTL_MS) { LOC.remove(k); return; }
  autoAdding.add(key);
  try {
    await LOC.remove(k);
    const { ["cap_" + key]: cap } = await SEC.get("cap_" + key);
    if (!hasSession(OMNI_WEB_MAP[key], cap)) { await LOC.set({ [k]: since }); return; } // not logged in yet — keep waiting
    const r = await sendToOmni(key);
    const p = r && r.ok ? await realProbe(OMNI_WEB_MAP[key].slug) : null;
    const label = (OMNI_WEB_MAP[key] || {}).label || key;
    toast(r && r.ok && p && p.alive !== false ? t("bg_autoAddOk", [label]) : t("bg_autoAddFail", [label, String((p && p.detail) || (r && r.error) || "")]));
    if (r && r.ok) { await LOC.set({ ["sent_" + key]: Date.now() }); await readConnections().catch(() => {}); }
    try { chrome.runtime.sendMessage({ type: "autoAdded", key, ok: !!(r && r.ok) }); } catch (e) { /* no popup open */ }
  } finally { autoAdding.delete(key); }
}
// "Войти заново": already logged in in this browser? Then there is nothing to log into — take the session
// from the cookie store and push it now. Only otherwise open the SITE (catalog loginUrls rot: perplexity.ai
// /login is a 404) and let the cookie watcher finish once the user logs in.
async function loginAgain(key) {
  const p = OMNI_WEB_MAP[key]; if (!p) return { ok: false };
  {
    const cap = p.cred.t === "cookie" ? await captureFromStore(p) : (await SEC.get("cap_" + key))["cap_" + key];
    if (hasSession(p, cap)) {
      const r = await sendToOmni(key);
      if (r && r.ok) {
        await LOC.set({ ["sent_" + key]: Date.now() });
        const pr = await realProbe(p.slug);
        return { ok: true, pushed: true, connName: r.connName, updated: r.updated, alive: pr.alive, state: probeState(pr), detail: pr.detail };
      }
      return { ok: false, error: (r && r.error) || "" };
    }
    if (cap) { // the browser has cookies for the site, just not a session — say which, then open the site
      await LOC.set({ ["autoadd_" + key]: Date.now() });
      await chrome.tabs.create({ url: p.site, active: true });
      return { ok: true, opened: true, detail: missingSessionDetail(p, cap) };
    }
  }
  await LOC.set({ ["autoadd_" + key]: Date.now() });
  await chrome.tabs.create({ url: p.site, active: true });
  return { ok: true, opened: true };
}
function toast(message) {
  try { chrome.notifications.create("omni_" + Date.now(), { type: "basic", iconUrl: "icons/icon128.png", title: "OmniRoute Bridge", message }); } catch (e) { /* no notifications permission */ }
}
// Does a capture carry the provider's real SESSION credential? A logged-out site still sends analytics
// cookies; pushing those unattended would mint a dead connection (new accountId → new name). Providers
// whose catalog lists no named cookie (header/localStorage-only) need the Bearer token instead.
// Session cookie names the generated catalog doesn't carry (its `sources` is empty for these).
// Auth.js v5 renamed next-auth's cookie (next-auth.session-token → authjs.session-token); accept both.
const SESSION_COOKIE_EXTRA = {
  huggingchat: ["hf-chat", "token"],
  "perplexity-web": ["__Secure-authjs.session-token", "next-auth.session-token"],
};
const sessionNames = (p) => p.sources.filter((s) => s.type === "cookie" && s.name).map((s) => s.name).concat(SESSION_COOKIE_EXTRA[p.key] || []);
// The part of a credential that IS the session: named session cookies (incl. next-auth chunks) + token.
// "" when the provider has no known session cookie → callers fall back to comparing the whole header.
function sessionKey(p, cookie, token) {
  const names = sessionNames(p);
  if (!names.length) return token || "";
  const parts = String(cookie || "").split(";").map((x) => x.trim()).filter((x) => names.some((n) => x.startsWith(n + "=") || x.startsWith(n + ".")));
  return parts.length ? parts.sort().join("; ") + "|" + (token || "") : "";
}
// Why no session: which cookies WERE there (names only — values are secrets) vs which one is needed.
// Turns "нужен вход" from a guess into something checkable against the site.
function missingSessionDetail(p, cap) {
  const have = String((cap && cap.cookie) || "").split(";").map((x) => x.trim().split("=")[0]).filter(Boolean);
  const want = sessionNames(p);
  return t("bg_noSessionNames", [want.join(" / ") || (p.cred.t === "token" ? "Bearer" : "?"), have.slice(0, 14).join(", ") + (have.length > 14 ? " …" : "") || "—"]);
}
function hasSession(p, cap) {
  if (!cap) return false;
  if (p.cred && p.cred.t === "token" && cap.token) return true; // DeepSeek: the Bearer token IS the session
  const names = sessionNames(p);
  if (!names.length) return !!cap.token;
  const have = new Set(String(cap.cookie || "").split(";").map((x) => x.trim()).filter((x) => /=./.test(x)).map((x) => x.slice(0, x.indexOf("="))));
  // next-auth (Perplexity) splits a big session cookie into "<name>.0", "<name>.1", …
  return names.some((n) => have.has(n) || have.has(n + ".0"));
}
const capSeen = {}; // provider key → last time ANY request carried its session (dedup-proof liveness)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── refresh sessions (идеи 1, 3, 4): open each site in a background tab, let it send its own
// authenticated XHR (the capture listener above grabs the cookie), push to OmniRoute, probe for real.
// A cookie the browser still sends can belong to a dead session, so the verdict is the probe, not the
// capture. Sequential on purpose: parallel chat probes have wedged the local server before.
const REFRESH_WAIT_MS = 15000;
// The Cookie header the browser would send to the provider's site — straight from the cookie store,
// HttpOnly included (needs the "cookies" permission + host access). No tab, no waiting for an XHR.
async function cookieHeaderFor(p) {
  if (!chrome.cookies) return "";
  // Read from the cookie store the site is ACTUALLY open in: in Firefox a tab may live in a container
  // (cookieStoreId ≠ default), and with first-party isolation / partitioning a bare getAll({url}) misses
  // the session (seen 2026-11-03: Perplexity logged in, store read returned no session cookie).
  const stores = new Set([undefined]);
  try { for (const tb of await chrome.tabs.query({})) if (tb.url && p.hostRe.test(tb.url) && tb.cookieStoreId) stores.add(tb.cookieStoreId); } catch (e) { /* tabs unavailable */ }
  const seen = new Map();
  for (const url of [p.site, p.loginUrl].filter(Boolean)) {
    for (const storeId of stores) {
      const base = storeId ? { url, storeId } : { url };
      // firstPartyDomain/partitionKey are Firefox/Chrome extras; an engine that rejects one gets the plain query.
      for (const q of [{ ...base, firstPartyDomain: null, partitionKey: {} }, { ...base, partitionKey: {} }, base]) {
        try { for (const c of await chrome.cookies.getAll(q)) if (!seen.has(c.name)) seen.set(c.name, c.value); break; } catch (e) { /* option unsupported → next form */ }
      }
    }
  }
  return [...seen].map(([n, v]) => n + "=" + v).join("; ");
}
// Fresh capture from the cookie store — but never REPLACE a capture that has a session with one that
// doesn't (the store can legitimately lack what the page sends, see above). Returns the usable capture.
async function captureFromStore(p) {
  const { ["cap_" + p.key]: prev } = await SEC.get("cap_" + p.key);
  const cookie = await cookieHeaderFor(p);
  const cap = cookie ? { provider: p.key, slug: p.slug, label: p.label, cookie, token: (prev && prev.token) || "", cookieCount: cookie.split(";").filter(Boolean).length, at: Date.now() } : null;
  if (!cap || !hasSession(p, cap)) return prev && hasSession(p, prev) ? prev : cap;
  cap.accountId = omniAccountId(omniBuildCredential(p, cap));
  cap.email = omniAccountEmail(omniBuildCredential(p, cap));
  cap.sessKey = sessionKey(p, cookie, cap.token);
  if (prev && prev.sessKey && prev.sessKey === cap.sessKey) cap.at = prev.at; // same session — not a "new" capture
  await SEC.set({ ["cap_" + p.key]: cap });
  const st = await getSettings(); if (st.persistSessions) await LOC.set({ ["cap_" + p.key]: cap });
  return cap;
}
// A probe's "dead" is only a login problem on 401/403; a 400/404/5xx is the provider or OmniRoute failing.
const probeState = (pr) => pr.alive === true ? "ok" : pr.alive === false && (pr.status === 401 || pr.status === 403) ? "needLogin" : pr.alive === false ? "error" : "unknown";
let refreshing = null;
let refreshState = null; // { running, done, total, key, phase, results } — lives in the SW, so a reopened popup sees it
async function refreshSessions(keys, emit = true) {
  if (refreshing) return { busy: true };
  refreshing = (async () => {
    const out = {};
    const tell = (m) => { refreshState = { running: true, total: keys.length, results: out, ...m }; if (emit) try { chrome.runtime.sendMessage({ type: "refreshProgress", ...m, total: keys.length }); } catch (e) { /* popup closed */ } };
    for (let i = 0; i < keys.length; i++) {
      const p = OMNI_WEB_MAP[keys[i]];
      if (!p) continue;
      tell({ phase: "start", done: i, key: p.key });
      const start = Date.now();
      // 1) a session the browser already has: the cookie store (cookie providers) or what the open page
      //    sent (token providers — DeepSeek's Bearer lives in page localStorage).
      let cap = p.cred.t === "cookie" ? await captureFromStore(p) : (await SEC.get("cap_" + p.key))["cap_" + p.key];
      // 2) nothing usable → let the site send one authenticated request from a background tab.
      if (!hasSession(p, cap)) {
        let tab = null;
        try { tab = await chrome.tabs.create({ url: p.site, active: false }); } catch (e) { out[p.key] = { state: "error", detail: String(e).slice(0, 80) }; continue; }
        while (Date.now() - start < REFRESH_WAIT_MS) {
          await sleep(500);
          if (capSeen[p.key] > start) { cap = (await SEC.get("cap_" + p.key))["cap_" + p.key]; if (hasSession(p, cap)) break; }
        }
        try { await chrome.tabs.remove(tab.id); } catch (e) { /* user closed it */ }
      }
      if (!hasSession(p, cap)) {
        out[p.key] = { state: capSeen[p.key] > start || cap ? "needLogin" : "noSession", detail: cap ? missingSessionDetail(p, cap) : t("bg_noRequest") };
      } else {
        const r = await sendToOmni(p.key);
        if (!r || !r.ok) out[p.key] = { state: "error", detail: (r && r.error) || "" };
        else {
          tell({ phase: "probe", done: i, key: p.key });
          const pr = await realProbe(p.slug);
          out[p.key] = { state: probeState(pr), detail: pr.detail || "", connName: r.connName, updated: r.updated };
        }
      }
      LOC.set({ ["repair_" + p.key]: Date.now() });
      await LOC.set({ last_refresh: { at: Date.now(), results: { ...out }, running: i < keys.length - 1 } }); // partial report, live
      tell({ phase: "done", done: i + 1, key: p.key, state: out[p.key].state });
    }
    await LOC.set({ last_refresh: { at: Date.now(), results: out, running: false } });
    return { results: out };
  })().finally(() => { refreshing = null; refreshState = null; });
  return refreshing;
}
// Web providers that already live in OmniRoute (the ones worth refreshing unattended).
async function knownWebKeys() {
  const { conn_slugs } = await LOC.get("conn_slugs");
  return OMNI_WEB.filter((p) => (conn_slugs || []).includes(p.slug)).map((p) => p.key);
}

// ── site reachability (идея 6): is the SITE up, separately from "is my session alive" ──
async function siteCheck(keys) {
  const out = {};
  await Promise.all(keys.map(async (k) => {
    const p = OMNI_WEB_MAP[k]; if (!p) return;
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 15000); const t0 = Date.now();
    // HEAD + manual redirect, NOT mode:"no-cors": Chrome's extension SW rejects no-cors fetches outright
    // ("Failed to fetch" in 50ms — verified 2026-11-03), while host permission already exempts us from CORS.
    // Any HTTP answer below 500 (incl. a Cloudflare 403) means the site is up.
    try { const r = await fetch(p.site, { method: "HEAD", redirect: "manual", cache: "no-store", credentials: "omit", signal: ctrl.signal }); out[k] = { up: r.status < 500, ms: Date.now() - t0, at: Date.now(), status: r.status }; }
    // A timeout is "don't know" (slow DNS/network on this PC), not "site down" — only a hard error is down.
    catch (e) { out[k] = e && e.name === "AbortError" ? { up: null, at: Date.now(), detail: "timeout" } : { up: false, at: Date.now(), detail: String(e).slice(0, 60) }; }
    finally { clearTimeout(to); }
  }));
  await LOC.set(Object.fromEntries(Object.entries(out).map(([k, v]) => ["site_" + k, v])));
  return { sites: out };
}

// ── cookie lifetime (идея 5): earliest expiry among the provider's session cookies ──
async function cookieExpiry(keys) {
  const out = {};
  if (!chrome.cookies) return { expiry: out };
  for (const k of keys) {
    const p = OMNI_WEB_MAP[k]; if (!p) continue;
    let min = null;
    for (const s of p.sources) {
      if (s.type !== "cookie" || !s.name) continue;
      try {
        const list = await chrome.cookies.getAll({ name: s.name, domain: String(s.domain || p.host).replace(/^\./, "") });
        for (const c of list) if (c.expirationDate && (min === null || c.expirationDate < min)) min = c.expirationDate;
      } catch (e) { /* no host permission for that domain */ }
    }
    if (min !== null) out[k] = Math.round(min * 1000);
  }
  return { expiry: out };
}

// ── probe history (идея 8): last 7 days of verdicts per provider ──
const HIST_MS = 7 * 24 * 60 * 60 * 1000;
async function appendHist(slug, r) {
  const k = "hist_" + slug;
  const { [k]: h } = await LOC.get(k);
  const now = Date.now();
  const next = (h || []).filter((x) => now - x.at < HIST_MS).concat([{ at: now, a: r.alive, ms: r.ms || null }]).slice(-120);
  await LOC.set({ [k]: next });
}

// ── OmniRoute version (идея 10) ──
function versionInPage() {
  return fetch("/api/system/version", { credentials: "include" })
    .then((r) => (r.ok ? r.json().then((d) => ({ ok: true, current: d.current, latest: d.latest, updateAvailable: !!d.updateAvailable })) : { ok: false, error: "HTTP " + r.status }))
    .catch((e) => ({ ok: false, error: String(e).slice(0, 80) }));
}
async function omniVersion() {
  const { omni_version: v } = await LOC.get("omni_version");
  if (v && Date.now() - v.at < 60 * 60 * 1000) return v;
  const r = await runInDash(versionInPage);
  if (!r || r.ok !== true) return v || { ok: false };
  const next = { ...r, at: Date.now() };
  await LOC.set({ omni_version: next });
  return next;
}

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
          caps[p.key] = c ? { provider: c.provider, slug: c.slug, label: c.label, cookieCount: c.cookieCount, at: c.at, email: c.email || "", accountId: c.accountId || omniAccountId(omniBuildCredential(p, c)) } : null;
        }
        send({ caps });
      });
      return true;
    case "send": sendToOmni(req.providerKey, req.name, !!req.forceNew).then(async (r) => { if (r && r.ok) await LOC.set({ ["sent_" + req.providerKey]: Date.now() }); send(r); }); return true;
    case "slotFor": slotFor(req.providerKey).then(send); return true;
    case "addApiKey": sendApiKeyToOmni(req.slug, req.name, req.apiKey, req.psd).then(send); return true;
    case "bulkAddApiKey": bulkAddApiKeys(req.slug, req.keys).then(send); return true;
    case "probe": realProbe(req.slug).then(send); return true;
    case "probeAll": probeAll(req.slugs || []).then(send); return true;
    case "connections": readConnections().then(send); return true;
    // Reachability check via the dashboard tab (runInDash) — NOT a direct fetch: Firefox blocks a direct
    // http fetch from the extension's secure moz-extension context to the http loopback (mixed content).
    case "ping": pingGateway().then((res) => send(res)).catch((e) => send({ ok: false, detail: String(e).slice(0, 120) })); return true;
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
    case "clearProbe": LOC.remove("probe_" + req.slug).then(() => send({ ok: true })); return true;
    case "refreshSessions": (req.keys ? Promise.resolve(req.keys) : knownWebKeys()).then((k) => refreshSessions(k)).then(send); return true;
    case "siteCheck": siteCheck(req.keys || OMNI_WEB.map((p) => p.key)).then(send); return true;
    case "cookieExpiry": cookieExpiry(req.keys || OMNI_WEB.map((p) => p.key)).then(send); return true;
    case "omniVersion": omniVersion().then(send); return true;
    case "models": fetchModels().then((r) => send({ ok: r.ok, models: (r.models || []).map((m) => ({ id: m.id, owned_by: m.owned_by || "" })) })); return true;
    case "chat": chatOnce(req.model, req.messages).then(send); return true;
    case "autoAdd": LOC.set({ ["autoadd_" + req.key]: Date.now() }).then(() => send({ ok: true })); return true;
    case "loginAgain": loginAgain(req.key).then(send); return true;
    case "getStats":
      LOC.get(null).then((all) => {
        const hist = {}, sites = {};
        for (const k in all) { if (k.startsWith("hist_")) hist[k.slice(5)] = all[k]; else if (k.startsWith("site_")) sites[k.slice(5)] = all[k]; }
        send({ hist, sites, lastRefresh: all.last_refresh || null, refreshing: !!refreshing, refreshState });
      });
      return true;
    default: return false;
  }
});

// ── add via the dashboard tab's session ─────────────────────────────────────
const INJECT_TIMEOUT = 12000;
let dashCreating = null; // single-flight tab creation — two concurrent callers must not spawn two tabs

const DASH_URL_PREFIX = "http://127.0.0.1:20128/";
async function getDashboardTab() {
  // 127.0.0.1 only — we navigate/create on 127.0.0.1 (a "localhost" tab is unreachable in Firefox and
  // would be a dead tab runInDash could pick and fail on). Keep this in sync with OMNI_BASE / tabs.create.
  // NOTE: do NOT use chrome.tabs.query({ url: ["http://127.0.0.1:20128/*"] }) — a match pattern with a
  // PORT matches nothing in Firefox (bugs 1362809 / 1468162), so the existing dashboard tab is never
  // found and every call spawns a fresh tab (and injects into it → "Missing host permission" before the
  // loopback host perm is granted). Chrome tolerates the port, which is why only Firefox broke. Query all
  // tabs and prefix-filter the URL in JS instead ("tabs" permission populates tab.url for every tab).
  const all = await chrome.tabs.query({});
  const existing = all.find((tb) => tb.url && tb.url.startsWith(DASH_URL_PREFIX));
  if (existing) return existing;
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
    try { if (await fetch(OMNI_BASE + "/api/providers", { method: "GET" })) return { ok: true }; } catch {}
  }
  const r = await runInDash(gatewayProbeInPage); // Firefox (and Chrome-fallback): via the dashboard tab
  if (r && r.ok === true) return { ok: true };
  // Surface WHY: runInDash already localises the failure (tab open / injection / timeout / empty result).
  // The popup shows this instead of a bare "недоступен", so the real cause is visible without devtools.
  return { ok: false, detail: (r && (r.error || (r.status ? "HTTP " + r.status : null))) || t("bg_noAnswer") };
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

// Which existing connection does a fresh session of THIS browser belong to? OmniRoute does NOT upsert
// web-session connections by name (#15070: two accounts may share a label), it only dedups an identical
// credential — and a refreshed cookie is never identical. So every re-send used to mint a duplicate row
// (45 → 52 on 2026-11-03). The answer, in order of certainty:
//   1. the credential carries a real account id (JWT) → the connection named "… · <that id>";
//   2. the connection this browser wrote last time (slot_<key>, remembered by id);
//   3. the provider's ONLY connection.
// Otherwise null → create a new one (never overwrite a connection that may be another account's).
async function resolveSlot(provider, cap) {
  const cred = omniBuildCredential(provider, cap);
  const acc = cap.accountId || omniAccountId(cred);
  const stable = omniAccountIdStable(cred);
  const conns = await readConnections();
  if (conns.unreachable) return { error: conns.error };
  const mine = (conns.all || []).filter((c) => c.provider === provider.slug);
  if (stable) {
    const same = mine.filter((c) => c.name.endsWith(" · " + acc));
    if (same.length) return { conn: same.find((c) => c.isActive) || same[0], acc, stable };
  }
  const sk = "slot_" + provider.key;
  const { [sk]: slot } = await LOC.get(sk);
  if (slot && !(stable && slot.acc && slot.stable && slot.acc !== acc)) {
    const c = mine.find((x) => x.id === slot.id);
    if (c) return { conn: c, acc, stable };
  }
  if (mine.length === 1 && !stable) return { conn: mine[0], acc, stable };
  // No slot yet (first run of this version): the connection this extension created most recently (last
  // 7 days) is the one this browser has been feeding — adopt it instead of minting yet another row.
  const recent = mine
    .filter((c) => c.createdAt && Date.now() - Date.parse(c.createdAt) < 7 * 24 * 60 * 60 * 1000 && c.name.startsWith(provider.label + " · "))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (recent && !stable) return { conn: recent, acc, stable };
  return { conn: null, acc, stable };
}
async function sendToOmni(providerKey, name, forceNew = false) {
  const provider = OMNI_WEB_MAP[providerKey];
  if (!provider) return { ok: false, error: t("bg_unknownProvider") };
  const gw = await requireGateway(); if (gw) return gw;
  const stored = await SEC.get("cap_" + providerKey);
  const cap = stored["cap_" + providerKey];
  if (!cap) return { ok: false, error: t("bg_noCapture") };
  const apiKey = omniBuildCredential(provider, cap);
  if (!apiKey) return { ok: false, error: t("bg_noCreds") };
  const slot = forceNew ? { conn: null } : await resolveSlot(provider, cap);
  if (slot.error) return { ok: false, error: slot.error };
  let r;
  if (slot.conn) {
    r = await runInDash(updateConnInPage, [slot.conn.id, { apiKey }, t("bg_needLogin")]);
    r = { ...r, slug: provider.slug, id: slot.conn.id, connName: slot.conn.name, updated: true };
  } else {
    r = await postApiKey(provider.slug, (name && name.trim()) ? name.trim() : provider.label, apiKey);
    r = { ...r, connName: ((name && name.trim()) || provider.label) + " · " + omniAccountId(apiKey), updated: false };
  }
  if (r.ok && r.id) await LOC.set({ ["slot_" + provider.key]: { id: r.id, acc: slot.acc || cap.accountId, stable: !!slot.stable, at: Date.now() } });
  return r;
}
async function slotFor(providerKey) {
  const provider = OMNI_WEB_MAP[providerKey];
  const { ["cap_" + providerKey]: cap } = await SEC.get("cap_" + providerKey);
  if (!provider || !cap) return { conn: null };
  const s = await resolveSlot(provider, cap);
  return { conn: s.conn ? { id: s.conn.id, name: s.conn.name } : null };
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
  const list = res.connections.map((c) => ({ provider: c.provider, id: c.id, name: c.name || "", testStatus: c.testStatus, hasError: !!c.errorCode, isActive: c.isActive !== false, createdAt: c.createdAt || null }));
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
// Test chat (popup "Чат"): one non-streamed completion, timed. Same direct-in-Chrome / tab-in-Firefox split
// as the probe. The reply text is returned to the popup only — nothing is stored.
function chatInPage(model, messages) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 90000);
  return fetch("/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal,
    body: JSON.stringify({ model, messages, max_tokens: 800, stream: false }),
  }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data: d };
  }).catch((e) => ({ ok: false, status: 0, data: { error: { message: String(e).slice(0, 160) } } })).finally(() => clearTimeout(to));
}
async function chatOnce(model, messages) {
  if (!model || !Array.isArray(messages) || !messages.length) return { ok: false, error: t("bg_noIdData") };
  const t0 = Date.now();
  let r = null;
  if (CAN_DIRECT_FETCH) {
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 90000);
      const res = await fetch(OMNI_BASE + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal, body: JSON.stringify({ model, messages, max_tokens: 800, stream: false }) }).finally(() => clearTimeout(to));
      r = { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
    } catch (e) { r = null; }
  }
  if (!r) r = await runInDash(chatInPage, [model, messages], 95000);
  const ms = Date.now() - t0;
  const d = (r && r.data) || {};
  const text = d.choices && d.choices[0] && d.choices[0].message ? String(d.choices[0].message.content || "") : "";
  if (r && r.ok && text) return { ok: true, text, ms, usage: d.usage || null, model: d.model || model };
  return { ok: false, ms, status: r && r.status, error: (d.error && (d.error.message || d.error)) || (r && r.error) || ("HTTP " + (r && r.status)) };
}
async function probeModel(models, slug) {
  const m = models.find((x) => typeof x.id === "string" && x.id.startsWith(slug + "/"));
  if (!m) return { alive: null, detail: t("bg_noModelsForProbe") };
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    const r = await chatProbe(m.id); // direct in Chrome, dashboard-tab fallback in Firefox
    const ms = Date.now() - t0;
    // runInDash-level failure (inject error / timeout) → retry once, then UNKNOWN (not "dead").
    if (!r || !r.fetched) {
      if (attempt === 0) continue;
      return { alive: null, model: m.id, detail: t("bg_probeTimeout", [String((r && r.error) || t("bg_noAnswer")).slice(0, 100)]) };
    }
    if (r.netErr) { if (attempt === 0) continue; return { alive: null, model: m.id, detail: String(r.msg).slice(0, 120) }; }
    if (r.ok) return { alive: true, model: m.id, ms, detail: t("bg_answered200") };
    if (r.status >= 500 && attempt === 0) continue; // transient upstream → retry once
    // 429 = rate-limited, NOT dead — the account is almost certainly authenticated, just throttled.
    // A persistent 5xx is a provider-side blip, not a verified auth failure → don't flag either as dead.
    if (r.status === 429) return { alive: null, model: m.id, status: 429, detail: t("bg_rateLimited") };
    if (r.status >= 500) return { alive: null, model: m.id, status: r.status, detail: t("bg_provider5xx", [String(r.msg).slice(0, 110)]) };
    return { alive: false, model: m.id, ms, status: r.status, detail: String(r.msg).slice(0, 140) };
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
  await LOC.set({ ["probe_" + slug]: { ...result, at: Date.now() } });
  await appendHist(slug, result);
  return result;
}

// Batch health-check: fetch the model list ONCE, then probe each provider. A down gateway reports
// "нет доступа к /v1/models" (distinct from a provider that genuinely has no models).
const PROBE_GAP_MS = 1000; // one at a time with a pause: concurrent chat probes wedged the local server (2026-11-02)
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
      if (out[slug].alive !== null) await appendHist(slug, out[slug]);
      // emit=false for the unattended sweep: it must NOT drive the popup's user-initiated progress bar
      // (which would animate a run the user never started and then stick, since the sweep sends no "done").
      if (emit) try { chrome.runtime.sendMessage({ type: "probeProgress", done: i + 1, total: slugs.length, slug, alive: out[slug].alive }); } catch (e) { /* popup closed */ }
      if (i < slugs.length - 1) await sleep(PROBE_GAP_MS);
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
  let dead = Object.keys(results).filter((s) => results[s].alive === false);
  // Auto-repair (идея 3): a dead WEB session is often just a rotated cookie the browser already has —
  // re-capture it in a background tab before shouting. At most once per 6h per provider (tabs are visible).
  if (st.autoRepair && !refreshing) {
    const webDead = dead.map((s) => OMNI_WEB.find((p) => p.slug === s)).filter(Boolean);
    const rep = await LOC.get(webDead.map((p) => "repair_" + p.key));
    const due = webDead.filter((p) => !rep["repair_" + p.key] || Date.now() - rep["repair_" + p.key] > 6 * 60 * 60 * 1000);
    if (due.length) {
      const r = await refreshSessions(due.map((p) => p.key), false);
      const fixed = new Set(Object.entries((r && r.results) || {}).filter(([, v]) => v.state === "ok").map(([k]) => OMNI_WEB_MAP[k].slug));
      dead = dead.filter((s) => !fixed.has(s));
    }
  }
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
  if (prev.nightly !== next.nightly) armNightly(next.nightly);
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
  else if (a.name === NIGHTLY_ALARM) nightlyRefresh().catch((e) => console.warn("[omni] nightly refresh failed", e));
});
// Nightly refresh (идея 4): re-capture every known web session at ~04:00 so the morning starts green.
const NIGHTLY_ALARM = "nightly_refresh";
function nextNightly() { const d = new Date(); d.setHours(4, 0, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); return d.getTime(); }
async function armNightly(on) {
  if (!on) { chrome.alarms.clear(NIGHTLY_ALARM); return; }
  chrome.alarms.get(NIGHTLY_ALARM, (a) => { if (!a) chrome.alarms.create(NIGHTLY_ALARM, { when: nextNightly(), periodInMinutes: 24 * 60 }); });
}
async function nightlyRefresh() {
  const st = await getSettings();
  if (!st.nightly) return;
  const keys = await knownWebKeys();
  if (keys.length) await refreshSessions(keys, false);
  if (st.sweep) await healthSweep(true);
}
getSettings().then((st) => armNightly(st.nightly));
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
