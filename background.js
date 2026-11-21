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
const SETTINGS_DEFAULT = { sweep: true, sweepMin: 15, notify: true, theme: "auto", persistSessions: true, sweepSkip: [], autoRepair: true, nightly: true, autoPark: true };

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

const CAPTURE_URLS = [...new Set(OMNI_CAPTURE_WEB.flatMap((p) => p.capturePerms || p.perms))];
const captureWrites = new Map();
// Serialize updates per provider so concurrent XHRs / a store scan cannot replace a newer capture.
function queueCapture(key, fn) {
  const task = (captureWrites.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  captureWrites.set(key, task);
  task.finally(() => { if (captureWrites.get(key) === task) captureWrites.delete(key); }).catch(() => {});
  return task;
}

if (CAPTURE_URLS.length) chrome.webRequest.onBeforeSendHeaders.addListener((d) => {
  const provider = OMNI_CAPTURE_WEB.find((p) => p.hostRe.test(d.url));
  if (!provider) return;
  const h = {};
  for (const x of (d.requestHeaders || [])) h[x.name.toLowerCase()] = x.value;
  const cookie = h["cookie"] || "";
  const auth = h["authorization"] || "";
  const token = /^bearer\s+\S+\s*$/i.test(auth) ? auth.replace(/^bearer\s+/i, "").trim() : "";
  if (!cookie && !token) return;
  if (provider.cred.t === "token" && !token) return; // token-less traffic cannot refresh or replace a bearer session
  const capKey = "cap_" + provider.key;
  queueCapture(provider.key, async () => {
    const dismissKey = "dismiss_" + provider.key;
    const stored = await SEC.get([capKey, dismissKey]);
    const prev = stored[capKey];
    // Chrome omits cookieStoreId on webRequest, but its regular/private cookie stores are 0/1.
    const storeId = d.cookieStoreId || (CAN_DIRECT_FETCH ? (d.incognito ? "1" : "0") : "");
    // Firefox supplies cookieStoreId on requests. Do not borrow a bearer from another container,
    // or attach it to a different cookie session after an account switch in the same container.
    const sameStore = !!prev && (prev.storeId || "") === storeId;
    const oldSession = prev && sessionKey(provider, prev.cookie, "");
    const newSession = sessionKey(provider, cookie, "");
    const sameSession = !!oldSession && oldSession === newSession;
    const retainedToken = token || (sameStore && sameSession && prev.token) || "";
    const cap = {
      provider: provider.key, slug: provider.slug, label: provider.label,
      cookie, token: retainedToken, storeId, cookieCount: cookie.split(";").filter(Boolean).length, at: Date.now(),
      // Requests don't expose partition keys. An identical session in the same store can retain
      // its discovered context; a different session must not adopt that context's remembered slot.
      cookieContext: sameStore && sameSession ? prev.cookieContext || "" : "",
    };
    if (!hasSession(provider, cap)) return;
    capSeen[provider.key] = Date.now(); // a refresh waits on this even when storage is deduplicated
    if (stored[dismissKey]) await SEC.remove(dismissKey);
    await saveCapture(provider, cap, prev);
    maybeAutoAdd(provider.key);
  }).catch(() => {});
}, { urls: CAPTURE_URLS, types: ["xmlhttprequest"] }, captureOpts);

// When the user was sent to log in (wizard / "добить недостающих"), the popup is already closed by the
// time the site sends its first authenticated XHR — so the SW finishes the job itself: push the fresh
// capture, probe it, and say so with a toast. One-shot per provider, expires after 15 min.
const AUTOADD_TTL_MS = 15 * 60 * 1000;
const autoAdding = new Set();
if (chrome.cookies && chrome.cookies.onChanged) chrome.cookies.onChanged.addListener((ch) => {
  if (ch.removed || !ch.cookie) return;
  const dom = String(ch.cookie.domain || "").replace(/^\./, "");
  for (const p of OMNI_CAPTURE_WEB) {
    const hosts = (p.captureUrls || [p.site]).map((url) => new URL(url).hostname);
    if (p.cred.t !== "cookie" || !hosts.some((host) => host === dom || host.endsWith("." + dom) || dom.endsWith("." + host))) continue;
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
  if (p.cred.t === "dashboard") return { ok: false, dashboardOnly: true, error: t("bg_dashboardSetup") };
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
// Does a capture carry a known session credential? Analytics alone are not a session, and only
// providers configured for token credentials can use a captured Bearer as their session.
// Only reviewed recipe names are session evidence. Cookie requirements can be AND groups of aliases.
const sessionNames = (p) => [...new Set((p.sources || []).filter((s) => s.type === "cookie" && s.name).map((s) => s.name))];
// The session identity used to deduplicate captures; unknown credential formats return "".
function sessionKey(p, cookie, token) {
  if (p.cred?.t === "dashboard") return "";
  if (p.cred && p.cred.t === "token") return token || "";
  const names = sessionNames(p);
  if (!names.length) return "";
  const parts = String(cookie || "").split(";").map((x) => x.trim()).filter((x) => {
    const name = x.slice(0, x.indexOf("="));
    return names.some((n) => name === n || (name.startsWith(n + ".") && /^\d+$/.test(name.slice(n.length + 1))));
  });
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
  return omniHasSession(p, cap);
}
const capSeen = {}; // provider key → last time ANY request carried its session (dedup-proof liveness)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── refresh sessions (идеи 1, 3, 4): open each site in a background tab, let it send its own
// authenticated XHR (the capture listener above grabs the cookie), push to OmniRoute, probe for real.
// A cookie the browser still sends can belong to a dead session, so the verdict is the probe, not the
// capture. Sequential on purpose: parallel chat probes have wedged the local server before.
const REFRESH_WAIT_MS = 15000;
const COOKIE_SCAN_MS = 4000, COOKIE_QUERY_MS = 800, COOKIE_SCAN_WORKERS = 4, COOKIE_SCAN_STORES = 8;
const COOKIE_CHUNKS = 16;
const storeCaptures = new Map();
let discovery = null;
let discoveredAt = 0;
async function captureTabs() {
  try { return await withTimeout(chrome.tabs.query({}), COOKIE_QUERY_MS, []); } catch { return []; }
}
function cookieQuery(q, scan, method = "getAll") {
  const key = JSON.stringify([method, q]);
  if (!scan.queries.has(key)) {
    scan.queries.set(key, (async () => {
      const left = scan.until - Date.now();
      // get's null means an absent cookie, not an unread chunk. Keep timeouts distinguishable.
      const expired = method === "get" ? false : null;
      if (left <= 0) return expired;
      try {
        const result = await withTimeout(chrome.cookies[method](q), Math.min(COOKIE_QUERY_MS, left), expired);
        return Date.now() < scan.until ? result : expired;
      } catch { return false; }
    })());
  }
  return scan.queries.get(key);
}
function cookieCandidateFrom(p, list, storeId) {
  const groups = new Map();
  for (const c of list) {
    if (!c || typeof c.name !== "string" || typeof c.value !== "string") continue;
    const sid = c.storeId || storeId || "";
    if (storeId && sid !== storeId) continue;
    const partition = c.partitionKey || {};
    const context = c.firstPartyDomain || partition.topLevelSite
      ? JSON.stringify([sid, c.firstPartyDomain || "", partition.topLevelSite || "", partition.hasCrossSiteAncestor ?? null]) : "";
    const groupKey = JSON.stringify([sid, context]);
    if (!groups.has(groupKey)) groups.set(groupKey, { storeId: sid, cookieContext: context, cookies: new Map() });
    // getAll sorts the longest path first, just like a Cookie header's effective value.
    const group = groups.get(groupKey);
    if (!group.cookies.has(c.name)) group.cookies.set(c.name, c.value);
  }
  for (const group of groups.values()) {
    const cookie = [...group.cookies].map(([n, v]) => n + "=" + v).join("; ");
    if (hasSession(p, { cookie })) return { cookie, storeId: group.storeId, cookieContext: group.cookieContext };
  }
  return null;
}
// getAll filters by the cookie's domain permission; get checks the requested URL. An allowed
// www host can therefore read a parent-domain session by name even when enumeration is empty.
// https://developer.chrome.com/docs/extensions/reference/api/cookies#method-get
// A singular lookup uses the default unpartitioned context, never getAll's wildcard partition /
// firstPartyDomain options. Firefox needs an explicit empty first-party domain under FPI.
async function namedCookiesFor(p, base, scan) {
  if (typeof chrome.cookies.get !== "function") return [];
  const names = sessionNames(p);
  const required = new Set((p.cookieGroups || [names]).flat());
  const url = new URL(base.url);
  const queryBase = CAN_DIRECT_FETCH ? base : { ...base, firstPartyDomain: "" };
  const sid = (c) => c.storeId || base.storeId || "";
  const read = async (name) => {
    if (Date.now() >= scan.until) return false;
    const c = await cookieQuery({ ...queryBase, name }, scan, "get");
    if (Date.now() >= scan.until || c === false) return false;
    if (c == null) return null;
    if (c.name !== name || typeof c.value !== "string" || (base.storeId && sid(c) !== base.storeId)) return false;
    // A response from another context is not evidence of absence in this one.
    if (c.firstPartyDomain || (c.partitionKey && Object.keys(c.partitionKey).length)) return false;
    if (c.domain) {
      const domain = c.domain.replace(/^\./, "").toLowerCase();
      if (url.hostname !== domain && (c.hostOnly || !url.hostname.endsWith("." + domain))) return false;
    }
    const path = c.path || "/";
    if (url.pathname !== path && !(url.pathname.startsWith(path) && (path.endsWith("/") || url.pathname[path.length] === "/"))) return false;
    if (c.secure && url.protocol !== "https:") return false;
    return c;
  };
  const list = [];
  nextName: for (const name of names) {
    if (!required.has(name)) continue;
    const direct = await read(name);
    if (direct === false) continue;
    if (direct && direct.value) list.push(direct);
    else {
      const first = await read(name + ".0");
      if (!first || !first.value) continue; // No usable head: try another reviewed name.
      const chunks = [first];
      let ended = false;
      // Check through .16 even after a missing suffix: .0 + .2 is a gap, not a full .0 token.
      // .16 is an overflow guard, never part of an accepted sixteen-chunk credential.
      // An invalid family rejects this name, not a valid alternative or another AND group.
      for (let i = 1; i <= COOKIE_CHUNKS; i++) {
        const c = await read(name + "." + i);
        if (c === false) continue nextName;
        if (!c) ended = true;
        else {
          if (ended || i === COOKIE_CHUNKS || !c.value || sid(c) !== sid(first)) continue nextName;
          chunks.push(c);
        }
      }
      list.push(...chunks);
    }
    if (cookieCandidateFrom(p, list, base.storeId)) break;
  }
  return Date.now() < scan.until ? list : [];
}
// One URL + store + first-party/partition bucket is one candidate. In particular, never join
// next-auth chunks from different containers, partitions, or login/site URL paths.
async function cookieCandidateFor(p, scan) {
  if (!chrome.cookies || p.cred.t !== "cookie" || !sessionNames(p).length) return null;
  const tabs = scan.tabs.filter((tb) => {
    if (!tb.url) return false;
    try { return p.hostRe.test(tb.url) || new URL(tb.url).origin === new URL(p.site).origin; } catch { return false; }
  }).sort((a, b) => Number(!!b.active) - Number(!!a.active));
  const stores = [...new Set([...tabs.map((tb) => tb.cookieStoreId).filter(Boolean), undefined])].slice(0, COOKIE_SCAN_STORES);
  for (const storeId of stores) for (const url of [...new Set((p.captureUrls || [p.site, p.loginUrl]).filter(Boolean))]) {
    if (Date.now() >= scan.until) return null;
    const base = storeId ? { url, storeId } : { url };
    let list = null;
    for (const q of [{ ...base, firstPartyDomain: null, partitionKey: {} }, { ...base, partitionKey: {} }, base]) {
      list = await cookieQuery(q, scan);
      if (list !== false) break; // retry only unsupported options, not a timeout or an empty result
    }
    if (!Array.isArray(list)) continue;
    if (Date.now() >= scan.until) return null;
    const enumerated = cookieCandidateFrom(p, list, storeId);
    if (enumerated) return enumerated;
    // Even a nonempty enumeration may omit a required parent-domain cookie. Named results
    // form their own candidate; never supplement an incomplete enumerated partition/store.
    const named = await namedCookiesFor(p, base, scan);
    if (Date.now() >= scan.until) return null;
    const candidate = cookieCandidateFrom(p, named, storeId);
    if (candidate) return candidate;
  }
  return null;
}
async function cookieHeaderFor(p) {
  const scan = { tabs: await captureTabs(), queries: new Map(), until: Date.now() + COOKIE_SCAN_MS };
  return (await cookieCandidateFor(p, scan))?.cookie || "";
}
async function saveCapture(p, cap, prev) {
  const sk = sessionKey(p, cap.cookie, cap.token);
  const same = prev && (prev.storeId || "") === (cap.storeId || "") && (prev.cookieContext || "") === (cap.cookieContext || "") && sk && (prev.sessKey || sessionKey(p, prev.cookie, prev.token)) === sk;
  if (same && (prev.cookie === cap.cookie || Date.now() - (prev.seenAt || prev.at) < 60000)) return prev;
  if (same) { cap.at = prev.at; cap.seenAt = Date.now(); }
  cap.sessKey = sk;
  const credential = omniBuildCredential(p, cap);
  cap.accountId = omniAccountId(credential);
  cap.email = omniAccountEmail(credential);
  await SEC.set({ ["cap_" + p.key]: cap });
  const st = await getSettings();
  if (st.persistSessions) await LOC.set({ ["cap_" + p.key]: cap });
  updateBadge();
  return cap;
}
function captureFromStore(p, scan, passive = false) {
  if (storeCaptures.has(p.key)) return storeCaptures.get(p.key);
  const task = (async () => {
    const context = scan || { tabs: await captureTabs(), queries: new Map(), until: Date.now() + COOKIE_SCAN_MS };
    const candidate = await cookieCandidateFor(p, context);
    return queueCapture(p.key, async () => {
      const key = "cap_" + p.key, dismiss = "dismiss_" + p.key;
      const stored = await SEC.get([key, dismiss]);
      const prev = stored[key];
      if (passive && stored[dismiss]) return prev || null;
      // Passive discovery fills missing captures; an XHR may have delivered a newer one mid-scan.
      if ((passive && hasSession(p, prev)) || !candidate || Date.now() >= context.until) return prev || null;
      const cap = { provider: p.key, slug: p.slug, label: p.label, ...candidate, token: "", cookieCount: candidate.cookie.split(";").filter(Boolean).length, at: Date.now() };
      return saveCapture(p, cap, prev);
    });
  })();
  storeCaptures.set(p.key, task);
  task.finally(() => { if (storeCaptures.get(p.key) === task) storeCaptures.delete(p.key); }).catch(() => {});
  return task;
}
function discoverSessions() {
  if (discovery) return discovery;
  if (discoveredAt && Date.now() - discoveredAt < 15000) return Promise.resolve();
  discovery = (async () => {
    const all = await SEC.get(OMNI_WEB.flatMap((p) => ["cap_" + p.key, "dismiss_" + p.key]));
    const providers = OMNI_CAPTURE_WEB.filter((p) => p.cred.t === "cookie" && sessionNames(p).length && !all["dismiss_" + p.key] && !hasSession(p, all["cap_" + p.key]));
    if (!providers.length || !chrome.cookies) return;
    const scan = { tabs: await captureTabs(), queries: new Map(), until: Date.now() + COOKIE_SCAN_MS };
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(COOKIE_SCAN_WORKERS, providers.length) }, async () => {
      while (i < providers.length && Date.now() < scan.until) {
        const p = providers[i++];
        try { await captureFromStore(p, scan, true); } catch { /* missing host access must not stop other providers */ }
      }
    }));
  })().finally(() => { discovery = null; discoveredAt = Date.now(); });
  return discovery;
}
async function getCaptures(discover) {
  if (discover) await discoverSessions();
  const all = await SEC.get(OMNI_WEB.map((p) => "cap_" + p.key));
  const caps = {};
  for (const p of OMNI_WEB) {
    const c = all["cap_" + p.key];
    caps[p.key] = hasSession(p, c) ? { provider: c.provider, slug: c.slug, label: c.label, cookieCount: c.cookieCount, at: c.at, email: c.email || "", accountId: c.accountId || omniAccountId(omniBuildCredential(p, c)) } : null;
  }
  return { caps };
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
      if (p.cred.t === "dashboard") { out[p.key] = { state: "unknown", detail: t("bg_dashboardSetup") }; continue; }
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
  return OMNI_CAPTURE_WEB.filter((p) => (conn_slugs || []).includes(p.slug)).map((p) => p.key);
}

// ── site reachability (идея 6): is the SITE up, separately from "is my session alive" ──
async function siteCheck(keys) {
  const out = {};
  await Promise.all(keys.map(async (k) => {
    const p = OMNI_WEB_MAP[k]; if (!p || !p.hostRe.test(p.site)) return;
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
    const p = OMNI_WEB_MAP[k]; if (!p || p.cred.t !== "cookie") continue;
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
  const [sec, loc] = await Promise.all([
    SEC.get(OMNI_CAPTURE_WEB.map((p) => "cap_" + p.key)),
    LOC.get(["health_dead", ...OMNI_CAPTURE_WEB.map((p) => "sent_" + p.key)]),
  ]);
  const caps = OMNI_CAPTURE_WEB.filter((p) => {
    const cap = sec["cap_" + p.key];
    return hasSession(p, cap) && !(loc["sent_" + p.key] >= cap.at);
  }).length;
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
      getCaptures(!!req.discover).then(send).catch(() => send({ caps: {}, error: t("bg_noData") }));
      return true;
    case "send": sendToOmni(req.providerKey, req.name, !!req.forceNew).then(async (r) => { if (r && r.ok) await LOC.set({ ["sent_" + req.providerKey]: Date.now() }); send(r); }); return true;
    case "slotFor": slotFor(req.providerKey).then(send); return true;
    case "addApiKey": sendApiKeyToOmni(req.slug, req.name, req.apiKey, req.psd).then(send); return true;
    case "bulkAddApiKey": bulkAddApiKeys(req.slug, req.keys, req.psd).then(send); return true;
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
    case "clear": queueCapture(req.providerKey, async () => {
      await SEC.set({ ["dismiss_" + req.providerKey]: true });
      await Promise.all([SEC.remove("cap_" + req.providerKey), LOC.remove("cap_" + req.providerKey)]);
      updateBadge(); send({ ok: true });
    }).catch(() => send({ ok: false })); return true;
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
    case "models": fetchModels().then((r) => send({ ok: r.ok, models: r.models || [] })); return true;
    case "chat": chatOnce(req.model, req.messages).then(send); return true;
    case "autoAdd": LOC.set({ ["autoadd_" + req.key]: Date.now() }).then(() => send({ ok: true })); return true;
    case "loginAgain": loginAgain(req.key).then(send); return true;
    case "unpark": unpark(req.slug).then(send); return true;
    case "getStats":
      LOC.get(null).then((all) => {
        const hist = {}, sites = {};
        for (const k in all) { if (k.startsWith("hist_")) hist[k.slice(5)] = all[k]; else if (k.startsWith("site_")) sites[k.slice(5)] = all[k]; }
        send({ hist, sites, lastRefresh: all.last_refresh || null, refreshing: !!refreshing, refreshState, park: all.park || {} });
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
  let timer;
  return Promise.race([promise, new Promise((res) => { timer = setTimeout(() => res(onTimeout), ms); })])
    .finally(() => clearTimeout(timer));
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
  const deadline = Date.now() + timeout;
  const left = () => Math.max(0, deadline - Date.now());
  const timeoutVal = { ok: false, state: "timeout", error: t("bg_timeout") };
  let tab;
  try { tab = await withTimeout(getDashboardTab(), left(), null); } catch (e) { return { ok: false, error: t("bg_tabOpenFail", [String(e).slice(0, 80)]) }; }
  if (!left()) return timeoutVal;
  if (!tab) return { ok: false, error: t("bg_tabOpenFail2") };
  const attempt = () => injectOnce(tab, func, args).catch((e) => ({ ok: false, __injectErr: true, error: t("bg_injectFail", [String(e).slice(0, 100)]) }));
  let r = await withTimeout(attempt(), left(), timeoutVal);
  if (r && r.__injectErr) {
    try { await withTimeout(chrome.tabs.reload(tab.id).then(() => sleep(1500)), left(), null); } catch { /* tab gone */ }
    if (!left()) return timeoutVal;
    r = await withTimeout(attempt(), left(), timeoutVal);
  }
  if (r && r.__injectErr) delete r.__injectErr;
  return r;
}

// Compatibility/authentication check, not proof of server identity. Recheck before each write.
function gatewayProbeInPage(url = "/api/providers", timeout = 4000) {
  const ctrl = new AbortController();
  let timer;
  const result = (state, status = 0) => ({ ok: state === "ready", authenticated: state === "ready", compatible: state === "ready", state, status });
  // The deadline covers headers AND JSON parsing, even if a stalled body ignores abort.
  const request = (async () => {
    try {
      const r = await fetch(url, { credentials: "include", cache: "no-store", redirect: "manual", signal: ctrl.signal });
      if (r.status === 401 || r.status === 403) return result("unauthenticated", r.status);
      if (r.status >= 500 || r.status === 408 || r.status === 429) return result("unavailable", r.status);
      if (r.status !== 200 || r.redirected || !/^application\/json(?:\s*;|$)/i.test(r.headers.get("content-type") || "")) return result("incompatible", r.status);
      const d = await r.json().catch(() => null);
      const valid = d && typeof d === "object" && !Array.isArray(d) && !("error" in d) && Array.isArray(d.connections)
        && d.connections.every((c) => c && typeof c.id === "string" && c.id.trim() && typeof c.provider === "string" && c.provider.trim())
        && (d.total === undefined || (Number.isSafeInteger(d.total) && d.total >= d.connections.length));
      return result(valid ? "ready" : "incompatible", r.status);
    } catch { return result(ctrl.signal.aborted ? "timeout" : "unreachable"); }
  })();
  const expired = new Promise((resolve) => { timer = setTimeout(() => { ctrl.abort(); resolve(result("timeout")); }, timeout); });
  return Promise.race([request, expired]).finally(() => clearTimeout(timer));
}
function gatewayResult(r) {
  const ready = r && r.ok === true && r.authenticated === true && r.compatible === true && r.status === 200 && r.state === "ready";
  const state = ready ? "ready" : r && r.state && r.state !== "ready" ? r.state : r && r.ok ? "incompatible" : "unreachable";
  const detail = ready ? "" : state === "unauthenticated" ? t("bg_needLogin") : state === "incompatible" ? t("bg_notOmni")
    : state === "timeout" ? t("bg_timeout") : (r && r.error) || (r && r.status ? "HTTP " + r.status : t("bg_noAnswer"));
  return { ok: !!ready, authenticated: !!ready, compatible: !!ready, state, status: (r && r.status) || 0, detail };
}
let gatewayChecking = null; // share only an in-flight dashboard check, never a cached authorization
function checkDashboardGateway() {
  if (!gatewayChecking) gatewayChecking = runInDash(gatewayProbeInPage, [], 10000)
    .then(gatewayResult).finally(() => { gatewayChecking = null; });
  return gatewayChecking;
}
async function ensureGateway() { return (await checkDashboardGateway()).ok; }
// Guard for every credential-writing path: returns an error object to bail with, or null if OK.
async function requireGateway() {
  const r = await checkDashboardGateway();
  return r.ok ? null : { ...r, error: r.detail };
}
// Reachability for the popup status dot: direct fetch first (Chrome — no tab), fall back to the dashboard
// tab (Firefox blocks a direct http fetch from the extension's secure context to the http loopback).
async function pingGateway() {
  if (CAN_DIRECT_FETCH) {
    const r = gatewayResult(await gatewayProbeInPage(OMNI_BASE + "/api/providers"));
    // SameSite may omit the dashboard session from a SW request. Only that/network failure
    // needs the authenticated tab fallback; a timeout or incompatible response is already decisive.
    if (r.state !== "unauthenticated" && r.state !== "unreachable") return r;
  }
  return checkDashboardGateway();
}

// POST /api/providers (create only — NO lying auto-test; the popup probes for real separately).
// psd = optional providerSpecificData (e.g. { cx } for google-pse-search, { baseUrl } to override endpoint).
function postProviderInPage(slug, name, apiKey, authType, psd, loginErr, invalidErr = "Invalid provider response") {
  const body = { provider: slug, authType, name, apiKey };
  if (psd && Object.keys(psd).length) body.providerSpecificData = psd;
  return fetch("/api/providers", {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const text = await r.text();
    if (r.status === 401 || r.status === 403) return { ok: false, error: loginErr };
    let p = {}; try { p = JSON.parse(text); } catch (x) {}
    if (r.status !== 201 && r.status !== 200) return { ok: false, error: typeof p?.error === "string" ? p.error : "HTTP " + r.status };
    if (!p || p.error || typeof p.connection?.id !== "string" || !p.connection.id.trim()) return { ok: false, error: typeof p?.error === "string" ? p.error : invalidErr };
    return { ok: true, id: p.connection.id };
  }).catch((e) => ({ ok: false, error: String(e).slice(0, 120) }));
}

// Shared add tail: name = "<base> · <stable per-credential id>" so OmniRoute's UPSERT-by-name treats
// "same key re-added" as an update, but two DIFFERENT keys under one custom name stay separate.
async function postApiKey(slug, base, apiKey, psd) {
  const r = await runInDash(postProviderInPage, [slug, base + " · " + omniAccountId(apiKey), apiKey, "apikey", psd || null, t("bg_needLogin"), t("bg_invalidResponse")]);
  return { ...r, slug };
}

// Which existing connection does a fresh session of THIS browser belong to? OmniRoute does NOT upsert
// web-session connections by name (#15070: two accounts may share a label), it only dedups an identical
// credential — and a refreshed cookie is never identical. So every re-send used to mint a duplicate row
// (45 → 52 on 2026-11-03). The answer, in order of certainty:
//   1. the credential carries a real account id (JWT) → the connection named "… · <that id>";
//   2. the connection this browser wrote last time in the same cookie store/context (remembered by id).
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
  if (slot && (slot.storeId || "") === (cap.storeId || "") && (slot.cookieContext || "") === (cap.cookieContext || "")
    && !(stable && slot.acc && slot.stable && slot.acc !== acc)) {
    const c = mine.find((x) => x.id === slot.id);
    if (c) return { conn: c, acc, stable };
  }
  // A sole connection or a recent matching label can still belong to another account/browser.
  return { conn: null, acc, stable };
}
async function sendToOmni(providerKey, name, forceNew = false) {
  const provider = OMNI_WEB_MAP[providerKey];
  if (!provider) return { ok: false, error: t("bg_unknownProvider") };
  if (provider.cred.t === "dashboard") return { ok: false, dashboardOnly: true, error: t("bg_dashboardSetup") };
  const gw = await requireGateway(); if (gw) return gw;
  const stored = await SEC.get("cap_" + providerKey);
  const cap = stored["cap_" + providerKey];
  if (!cap) return { ok: false, error: t("bg_noCapture") };
  if (!hasSession(provider, cap)) return { ok: false, error: missingSessionDetail(provider, cap) };
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
  if (r.ok && r.id) await LOC.set({ ["slot_" + provider.key]: { id: r.id, acc: slot.acc || cap.accountId, stable: !!slot.stable, storeId: cap.storeId || "", cookieContext: cap.cookieContext || "", at: Date.now() } });
  return r;
}
async function slotFor(providerKey) {
  const provider = OMNI_WEB_MAP[providerKey];
  const { ["cap_" + providerKey]: cap } = await SEC.get("cap_" + providerKey);
  if (!provider || !hasSession(provider, cap)) return { conn: null };
  const s = await resolveSlot(provider, cap);
  return { conn: s.conn ? { id: s.conn.id, name: s.conn.name } : null };
}

async function sendApiKeyToOmni(slug, name, apiKey, psd) {
  if (!slug) return { ok: false, error: t("bg_noProvider") };
  const provider = OMNI_APIKEY_MAP[slug];
  if (!provider) return { ok: false, error: t("bg_unknownProvider") };
  if (provider.dashboardOnly) return { ok: false, dashboardOnly: true, error: t("bg_dashboardSetup") };
  apiKey = (apiKey || "").trim();
  if (!apiKey && !provider.keyOptional) return { ok: false, error: t("bg_emptyKey") };
  const missing = (provider.extra || []).find((field) => field.required && !(typeof psd?.[field.key] === "string" && psd[field.key].trim()));
  if (missing) return { ok: false, error: t("key_fillField", [missing.label]) };
  const gw = await requireGateway(); if (gw) return gw;
  return postApiKey(slug, (name && name.trim()) ? name.trim() : slug, apiKey, psd);
}

// Bulk add: several API keys of ONE provider at once (dashboard's bulkCreateProviderSchema).
function bulkApiKeyInPage(slug, entries, loginErr, invalidErr = "Invalid batch response", psd) {
  const unknown = (error) => ({ ok: false, batch: true, partial: false, added: null, failed: null, total: entries.length, errors: [], error });
  const body = { provider: slug, entries };
  if (psd && Object.keys(psd).length) body.providerSpecificData = psd;
  return fetch("/api/providers/bulk", {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    if (r.status === 401 || r.status === 403) return unknown(loginErr);
    const d = await r.json().catch(() => null);
    if (!r.ok) return unknown(typeof d?.error === "string" ? d.error : "HTTP " + r.status);
    // Both bulk APIs return 200 even when EVERY entry failed. Cross-check the counters and
    // per-entry evidence; a missing/contradictory response leaves the write outcome unknown.
    const valid = d && !d.error && [d.success, d.failed, d.total].every((n) => Number.isSafeInteger(n) && n >= 0)
      && d.total === entries.length && d.success + d.failed === d.total
      && Array.isArray(d.created) && d.created.length === d.success && d.created.every((c) => c && typeof c.id === "string" && c.id.trim())
      && Array.isArray(d.errors) && d.errors.length === d.failed
      && d.errors.every((e) => e && Number.isInteger(e.index) && e.index >= 0 && e.index < d.total && typeof e.message === "string")
      && new Set(d.errors.map((e) => e.index)).size === d.failed;
    if (!valid) return unknown(invalidErr);
    const errors = d.errors.map((e) => ({ index: e.index, message: e.message.slice(0, 240) }));
    return { ok: d.success > 0 && d.failed === 0, batch: true, partial: d.success > 0 && d.failed > 0, added: d.success, failed: d.failed, total: d.total, errors };
  }).catch(() => unknown(invalidErr));
}
async function bulkAddApiKeys(slug, keys, psd) {
  if (!slug) return { ok: false, error: t("bg_noProvider") };
  const provider = OMNI_APIKEY_MAP[slug];
  if (!provider) return { ok: false, error: t("bg_unknownProvider") };
  if (provider.dashboardOnly || !provider.bulk) return { ok: false, error: t("bg_bulkUnsupported") };
  const missing = (provider.extra || []).find((field) => field.required && !(typeof psd?.[field.key] === "string" && psd[field.key].trim()));
  if (missing) return { ok: false, error: t("key_fillField", [missing.label]) };
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string")) return { ok: false, error: t("bg_noValidKeys") };
  const clean = keys.map((k) => k.trim()).filter(Boolean);
  if (!clean.length) return { ok: false, error: t("bg_noValidKeys") };
  const gw = await requireGateway(); if (gw) return gw;
  // accountId is upstream routing configuration (e.g. Cloudflare), not a hash of the API key.
  const entries = clean.map((k) => ({ name: slug + " · " + omniAccountId(k), apiKey: k, ...(typeof psd?.accountId === "string" && psd.accountId.trim() ? { accountId: psd.accountId.trim() } : {}) }));
  const r = await runInDash(bulkApiKeyInPage, [slug, entries, t("bg_needLogin"), t("bg_invalidResponse"), psd || null]);
  return { batch: true, added: null, failed: null, total: entries.length, errors: [], ...r, slug };
}

// ── live connections (what's actually in OmniRoute right now) ────────────────
// Distinguish "unreachable" (couldn't read) from "genuinely empty" — a down gateway must NOT look
// like "0 connections" (that inverts the honest-signal premise this extension is built on).
function readConnectionsInPage() {
  const ctrl = new AbortController();
  let timer;
  const request = (async () => {
    try {
      const r = await fetch("/api/providers", { credentials: "include", cache: "no-store", redirect: "manual", signal: ctrl.signal });
      if (r.status !== 200) return { ok: false, error: "HTTP " + r.status };
      if (r.redirected || !/^application\/json(?:\s*;|$)/i.test(r.headers.get("content-type") || "")) return { ok: false };
      const d = await r.json().catch(() => null);
      if (!d || Array.isArray(d) || d.error || !Array.isArray(d.connections)
        || !d.connections.every((c) => c && typeof c.id === "string" && c.id.trim() && typeof c.provider === "string" && c.provider.trim())
        || (d.total !== undefined && (!Number.isSafeInteger(d.total) || d.total < d.connections.length))) return { ok: false };
      // Only the roster fields used by the extension cross back to the worker. The server may
      // be configured to reveal API keys in its response; they are not needed here.
      return { ok: true, connections: d.connections.map((c) => ({ id: c.id, provider: c.provider, name: typeof c.name === "string" ? c.name : "", testStatus: c.testStatus, errorCode: !!c.errorCode, isActive: c.isActive, createdAt: c.createdAt })) };
    } catch { return { ok: false }; }
  })();
  const expired = new Promise((resolve) => { timer = setTimeout(() => { ctrl.abort(); resolve({ ok: false, state: "timeout" }); }, 4000); });
  return Promise.race([request, expired]).finally(() => clearTimeout(timer));
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
function fetchModelsInPage(url = "/v1/models") {
  const ctrl = new AbortController();
  let timer;
  const request = (async () => {
    try {
      const r = await fetch(url, { cache: "no-store", redirect: "manual", signal: ctrl.signal });
      if (!r.ok || r.redirected || !/^application\/json(?:\s*;|$)/i.test(r.headers.get("content-type") || "")) return { fetched: true, ok: false };
      const d = await r.json().catch(() => null);
      if (!d || d.error || !Array.isArray(d.data) || !d.data.every((m) => m && typeof m.id === "string" && m.id.trim())) return { fetched: true, ok: false };
      return { fetched: true, ok: true, models: d.data.map((m) => ({
        id: m.id, owned_by: typeof m.owned_by === "string" ? m.owned_by : "",
        ...(typeof m.type === "string" ? { type: m.type } : {}),
        ...(typeof m.api_format === "string" ? { api_format: m.api_format } : {}),
        ...(typeof m.supported_in_api === "boolean" ? { supported_in_api: m.supported_in_api } : {}),
        ...(m.supported_endpoints !== undefined ? { supported_endpoints: Array.isArray(m.supported_endpoints) ? m.supported_endpoints.filter((e) => typeof e === "string") : [] } : {}),
      })) };
    } catch { return { fetched: true, ok: false, netErr: !ctrl.signal.aborted }; }
  })();
  const expired = new Promise((resolve) => { timer = setTimeout(() => { ctrl.abort(); resolve({ fetched: true, ok: false, state: "timeout" }); }, 4000); });
  return Promise.race([request, expired]).finally(() => clearTimeout(timer));
}
async function fetchModels() {
  if (_modelsCache && Date.now() - _modelsCache.at < 45000) return { ok: true, models: _modelsCache.models };
  if (CAN_DIRECT_FETCH) {
    const r = await fetchModelsInPage(OMNI_BASE + "/v1/models");
    if (r.ok) { _modelsCache = { at: Date.now(), models: r.models }; return { ok: true, models: r.models }; }
    if (!r.netErr) return { ok: false }; // a timeout or an HTTP/shape failure is already decisive
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
function chatProbeInPage(modelId, url = "/v1/chat/completions", timeoutErr = "Request timed out") {
  const ctrl = new AbortController();
  let timer;
  const timedOut = { fetched: true, ok: false, netErr: true, state: "timeout", msg: timeoutErr };
  const request = (async () => {
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal,
        body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 16 }),
      });
      let msg = "HTTP " + r.status, text = "";
      try { const d = await r.json(); msg = (d.error || {}).message || msg; text = ((((d.choices || [])[0] || {}).message || {}).content || ""); }
      catch (e) { if (ctrl.signal.aborted || e?.name === "AbortError") return timedOut; }
      if (ctrl.signal.aborted) return timedOut;
      return { fetched: true, ok: r.ok, status: r.status, msg, text: String(text).slice(0, 200) };
    } catch (e) {
      return ctrl.signal.aborted || e?.name === "AbortError" ? timedOut : { fetched: true, ok: false, netErr: true, msg: String(e).slice(0, 120) };
    }
  })();
  // Keep the deadline through JSON parsing; the race also bounds a body that ignores abort.
  const expired = new Promise((resolve) => { timer = setTimeout(() => { ctrl.abort(); resolve(timedOut); }, 30000); });
  return Promise.race([request, expired]).finally(() => clearTimeout(timer));
}
// Direct completion probe first (Chrome — no tab); on throw (Firefox mixed content) fall back to the tab.
async function chatProbe(modelId) {
  if (CAN_DIRECT_FETCH) {
    const r = await chatProbeInPage(modelId, OMNI_BASE + "/v1/chat/completions", t("bg_probeAbort"));
    if (!r.netErr || r.state === "timeout") return r; // a timeout must not send the completion again via the tab
  }
  const r = await runInDash(chatProbeInPage, [modelId, "/v1/chat/completions", t("bg_probeAbort")], 32000); // Firefox: via the tab (a direct fetch hangs)
  if (r && r.fetched) return r;
  return { fetched: true, netErr: true, msg: String((r && r.error) || "").slice(0, 120) };
}
// Test chat (popup "Чат"): one non-streamed completion, timed. Same direct-in-Chrome / tab-in-Firefox split
// as the probe. The reply text is returned to the popup only — nothing is stored.
function chatInPage(model, messages, url = "/v1/chat/completions", timeoutErr = "Request timed out") {
  const ctrl = new AbortController();
  let timer;
  const timedOut = { ok: false, status: 0, state: "timeout", data: { error: { message: timeoutErr } } };
  const request = (async () => {
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal,
        body: JSON.stringify({ model, messages, max_tokens: 800, stream: false }),
      });
      let d = {};
      try { d = await r.json(); }
      catch (e) { if (ctrl.signal.aborted || e?.name === "AbortError") return timedOut; }
      return ctrl.signal.aborted ? timedOut : { ok: r.ok, status: r.status, data: d };
    } catch (e) {
      return ctrl.signal.aborted || e?.name === "AbortError" ? timedOut : { ok: false, status: 0, netErr: true, data: { error: { message: String(e).slice(0, 160) } } };
    }
  })();
  const expired = new Promise((resolve) => { timer = setTimeout(() => { ctrl.abort(); resolve(timedOut); }, 90000); });
  return Promise.race([request, expired]).finally(() => clearTimeout(timer));
}
async function chatOnce(model, messages) {
  if (!model || !Array.isArray(messages) || !messages.length) return { ok: false, error: t("bg_noIdData") };
  const t0 = Date.now();
  let r = null;
  if (CAN_DIRECT_FETCH) {
    r = await chatInPage(model, messages, OMNI_BASE + "/v1/chat/completions", t("bg_timeout"));
    if (r.netErr) r = null; // retry only a network failure, never an aborted completion
  }
  if (!r) r = await runInDash(chatInPage, [model, messages, "/v1/chat/completions", t("bg_timeout")], 95000);
  const ms = Date.now() - t0;
  const d = (r && r.data) || {};
  const text = d.choices && d.choices[0] && d.choices[0].message ? String(d.choices[0].message.content || "") : "";
  if (r && r.ok && text) return { ok: true, text, ms, usage: d.usage || null, model: d.model || model };
  return { ok: false, ms, status: r && r.status, error: (d.error && (d.error.message || d.error)) || (r && r.error) || ("HTTP " + (r && r.status)) };
}
const LOGGED_OUT_RE = /\b(sign up|sign in|log in|login to)\b.{0,40}(repeat|continue|request)|войдите|зарегистрируйтесь/i;
async function probeModel(models, slug) {
  if (OMNI_CATALOG_MAP[slug]?.probeKind === "dashboard") return { alive: null, detail: t("bg_specializedProbe") };
  const candidates = models.filter((x) => typeof x.id === "string" && x.id.startsWith(slug + "/") && omniCanChatModel(x));
  const m = candidates.find((x) => x.type === "chat" || x.supported_endpoints?.includes("chat")) || candidates[0];
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
    // 200 + the site's own "sign up / log in" text = a logged-out web session (perplexity-web, 2026-11-03).
    if (r.ok && LOGGED_OUT_RE.test(r.text || "")) return { alive: false, model: m.id, ms, status: 401, detail: t("bg_loggedOutReply", [String(r.text).trim().slice(0, 50)]) };
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
  if (OMNI_CATALOG_MAP[slug]?.probeKind === "dashboard") return { alive: null, detail: t("bg_specializedProbe") };
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
    const mm = slugs.some((slug) => OMNI_CATALOG_MAP[slug]?.probeKind !== "dashboard") ? await fetchModels() : { ok: true, models: [] };
    const models = mm.ok ? mm.models : [];
    const out = {};
    const now = Date.now();
    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i];
      out[slug] = OMNI_CATALOG_MAP[slug]?.probeKind === "dashboard" ? { alive: null, detail: t("bg_specializedProbe") }
        : models.length ? await probeModel(models, slug) : { alive: null, detail: mm.ok ? t("bg_noModels") : t("bg_noModelsAccess") };
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
    const webDead = dead.map((s) => OMNI_CAPTURE_WEB.find((p) => p.slug === s)).filter(Boolean);
    const rep = await LOC.get(webDead.map((p) => "repair_" + p.key));
    const due = webDead.filter((p) => !rep["repair_" + p.key] || Date.now() - rep["repair_" + p.key] > 6 * 60 * 60 * 1000);
    if (due.length) {
      const r = await refreshSessions(due.map((p) => p.key), false);
      const fixed = new Set(Object.entries((r && r.results) || {}).filter(([, v]) => v.state === "ok").map(([k]) => OMNI_WEB_MAP[k].slug));
      dead = dead.filter((s) => !fixed.has(s));
    }
  }
  if (st.autoPark) await parkSweep(results);
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
// ── auto-park (owner's rule 2026-11-03: "отключать + возвращать", never delete) ──
// A provider that fails the real probe 3 sweeps in a row gets its ACTIVE connections disabled, so
// OmniRoute's routing (and OpenCode's auto/* combos) stop landing on it. Each later sweep wakes ONE of
// them, probes, and puts it back to sleep unless it passed — 2 passes in a row re-enable all of them.
// 429 / "no answer" count as neither. Connections the owner disabled himself are never touched.
const PARK_FAILS = 3, PARK_PASSES = 2;
async function parkSweep(results) {
  const { park = {} } = await LOC.get("park");
  const changed = [];
  for (const [slug, r] of Object.entries(results)) {
    if (park[slug] && park[slug].ids) continue; // parked ones are judged by their wake-up probe below
    if (r.alive === null) continue;
    const e = park[slug] || (park[slug] = { fails: 0 });
    e.fails = r.alive === false ? e.fails + 1 : 0;
    if (e.fails >= PARK_FAILS) {
      const conns = await readConnections();
      const ids = (conns.all || []).filter((c) => c.provider === slug && c.isActive).map((c) => c.id);
      for (const id of ids) await updateConn(id, { isActive: false });
      if (ids.length) { park[slug] = { ids, passes: 0, at: Date.now(), why: r.detail || "" }; changed.push("⏸ " + providerName(slug)); }
    }
  }
  for (const [slug, e] of Object.entries(park)) {
    if (!e.ids || !e.ids.length) continue;
    await updateConn(e.ids[0], { isActive: true }); // wake one so the provider exposes a model to probe
    _modelsCache = null;
    await sleep(1500);
    const r = await runProbe(slug);
    await LOC.set({ ["probe_" + slug]: { ...r, at: Date.now() } });
    e.passes = r.alive === true ? (e.passes || 0) + 1 : r.alive === false ? 0 : e.passes || 0;
    if (e.passes >= PARK_PASSES) {
      for (const id of e.ids.slice(1)) await updateConn(id, { isActive: true });
      delete park[slug]; changed.push("▶ " + providerName(slug));
    } else await updateConn(e.ids[0], { isActive: false });
  }
  await LOC.set({ park });
  if (changed.length) toast(t("bg_parkChanged", [changed.join(", ")]));
}
const providerName = (slug) => OMNI_CATALOG_MAP[slug]?.label || slug;
async function unpark(slug) {
  const { park = {} } = await LOC.get("park");
  const e = park[slug]; if (!e) return { ok: true };
  for (const id of e.ids || []) await updateConn(id, { isActive: true });
  delete park[slug]; await LOC.set({ park });
  return { ok: true, n: (e.ids || []).length };
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
// The callback server receives the code; POST poll-callback performs the exchange and saves it.
function oauthStartCallbackInPage(provider) {
  return fetch("/api/oauth/" + provider + "/start-callback-server", { credentials: "include" })
    .then((r) => r.ok ? r.json() : r.text().then((t) => ({ error: t || "HTTP " + r.status })))
    .catch((e) => ({ error: String(e).slice(0, 120) }));
}
async function oauthCallbackPollInPage(provider, invalidErr) {
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { ctrl.abort(); resolve({ error: invalidErr }); }, 30000);
  });
  const request = (async () => {
    try {
      const r = await fetch("/api/oauth/" + provider + "/poll-callback", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: "{}", signal: ctrl.signal,
      });
      const d = await r.json();
      if (!r.ok || d?.error) return { error: typeof d?.error === "string" ? d.error : invalidErr };
      if (d?.success === true && typeof d.connection?.id === "string" && d.connection.id.trim()
          && (!d.connection.provider || d.connection.provider === provider)) {
        return { success: true, connection: { id: d.connection.id } };
      }
      if (d?.success === false && d.pending === true) return { pending: true };
      return { error: invalidErr };
    } catch { return { error: invalidErr }; }
  })();
  // The exchange consumes server-side callback state. A lost response is an unconfirmed result,
  // never success inferred from another connection and never an automatic second exchange.
  try { return await Promise.race([request, timeout]); }
  finally { clearTimeout(timer); }
}
// Auto-import: OmniRoute reads the provider's CLI creds already stored locally on the machine.
function oauthAutoImportInPage(provider) {
  return fetch("/api/oauth/" + provider + "/auto-import", { credentials: "include" })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => ({ ok: true, found: !!d.found, token: d.refreshToken || d.token || "" }))
    .catch(() => ({ ok: false }));
}
// Import-token flows: user pastes a CLI/session token; OmniRoute validates + creates the connection.
function oauthImportTokenInPage(provider, token, loginErr, invalidErr = "Invalid provider response") {
  return fetch("/api/oauth/" + provider + "/import-token", {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, connectionId: null }),
  }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) return { ok: false, error: loginErr };
    if (!r.ok || d?.error || d?.success === false) return { ok: false, error: typeof d?.error === "string" ? d.error : "HTTP " + r.status };
    if (typeof d?.connection?.id !== "string" || !d.connection.id.trim()) return { ok: false, error: invalidErr };
    return { ok: true, id: d.connection.id };
  }).catch((e) => ({ ok: false, error: String(e).slice(0, 120) }));
}
// Paste-credentials: some providers export an "omniroute-cred-v1.…" blob instead of a bare token.
function oauthPasteCredsInPage(provider, blob, loginErr, invalidErr = "Invalid provider response") {
  return fetch("/api/oauth/" + provider + "/paste-credentials", {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" },
    body: JSON.stringify({ blob, connectionId: null }),
  }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) return { ok: false, error: loginErr };
    if (!r.ok || d?.error || d?.success === false) return { ok: false, error: typeof d?.error === "string" ? d.error : "HTTP " + r.status };
    if (typeof d?.connection?.id !== "string" || !d.connection.id.trim()) return { ok: false, error: invalidErr };
    return { ok: true, id: d.connection.id };
  }).catch((e) => ({ ok: false, error: String(e).slice(0, 120) }));
}
const OAUTH_KEY = (slug) => "oauth_" + slug;

async function oauthStart(provider) {
  const p = OMNI_OAUTH.find((o) => o.slug === provider);
  if (!p || !p.deviceFlow) return { ok: false, error: t("bg_notDeviceFlow") };
  if (p.dashboardOnly) return { ok: false, dashboardOnly: true, error: t("bg_dashboardSetup") };
  const gw = await requireGateway(); if (gw) return gw;
  const d = await runInDash(oauthDeviceCodeInPage, [provider]);
  if (!d || d.error || !d.device_code) return { ok: false, error: (d && d.error) || t("bg_providerUnavailable") };
  // Some providers (kiro / amazon-q, AWS SSO) echo client creds back — the poll needs them.
  const extraData = (d._clientId || d._clientSecret || d._region || d._authMethod)
    ? { _clientId: d._clientId, _clientSecret: d._clientSecret, _region: d._region, _authMethod: d._authMethod } : null;
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

// Redirect/PKCE uses only the registered callback-server path; its poll response owns completion.
async function oauthConnect(provider) {
  const p = OMNI_OAUTH.find((o) => o.slug === provider);
  if (!p || p.kind !== "redirect") return { ok: false, error: t("bg_notRedirect") };
  if (p.dashboardOnly) return { ok: false, dashboardOnly: true, error: t("bg_dashboardSetup") };
  const gw = await requireGateway(); if (gw) return gw;
  const d = await runInDash(oauthStartCallbackInPage, [provider]);
  const authUrl = d && d.authUrl;
  // /callback only relays a code to a dashboard modal; without that modal no exchange owns its state.
  if (!authUrl) return { ok: false, error: (d && d.error) || t("bg_noBrowserLogin") };
  const state = {
    provider, label: p.label, kind: "redirect", status: "pending", detail: "", verifyUrl: authUrl,
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
  if (p.dashboardOnly || !p.tokenImport) return { ok: false, dashboardOnly: true, error: t("bg_dashboardSetup") };
  token = (token || "").trim();
  if (!token) return { ok: false, error: t("bg_emptyToken") };
  if (token.length < 8) return { ok: false, error: t("bg_tokenShort") };
  const gw = await requireGateway(); if (gw) return gw;
  if (token.startsWith("omniroute-cred-v1.")) return { ok: false, dashboardOnly: true, error: t("bg_dashboardSetup") };
  const r = await runInDash(oauthImportTokenInPage, [provider, token, t("bg_needLogin"), t("bg_invalidResponse")]);
  return { ...r, slug: provider };
}

// Auto-import: try to detect the provider's CLI creds already on the machine, then import them.
// Best-effort — falls back to manual paste on "not found" / server error.
async function oauthAutoImport(provider) {
  const p = OMNI_OAUTH.find((o) => o.slug === provider);
  if (!p) return { ok: false, error: t("bg_unknownProvider") };
  if (!p.autoImport) return { ok: false, dashboardOnly: true, error: t("bg_dashboardSetup") };
  const gw = await requireGateway(); if (gw) return gw;
  const d = await runInDash(oauthAutoImportInPage, [provider]);
  if (d && d.error) return { ok: false, error: t("bg_omniUnreachable", [String(d.error)]) }; // runInDash-level failure (timeout/inject) ≠ "not found"
  if (!d || d.ok !== true || !d.found || !d.token) return { ok: false, error: t("bg_noLocalCreds") };
  // The local lookup can take time; recheck before forwarding the detected credential.
  const ready = await requireGateway(); if (ready) return ready;
  const r = await runInDash(oauthImportTokenInPage, [provider, d.token, t("bg_needLogin"), t("bg_invalidResponse")]);
  return { ...r, slug: provider };
}

// Bulk ZIP import: a .zip of many exported accounts → extract (raw octet-stream) → import-bulk.
// The file can't cross executeScript args (only JSON), so the popup sends base64 and we rebuild the
// bytes in-page.
function zipExtractInPage(authSlug, b64, loginErr, invalidErr = "Invalid archive response") {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return fetch("/api/providers/" + authSlug + "/zip-extract", {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/octet-stream" }, body: arr,
  }).then(async (r) => {
    if (r.status === 401 || r.status === 403) return { ok: false, error: loginErr };
    const d = await r.json().catch(() => null);
    if (!r.ok || d?.error) return { ok: false, error: typeof d?.error === "string" ? d.error : "HTTP " + r.status };
    if (!Array.isArray(d?.entries) || !d.entries.every((e) => e && typeof e === "object" && !Array.isArray(e) && "json" in e)) return { ok: false, error: invalidErr };
    return { ok: true, entries: d.entries };
  }).catch((e) => ({ ok: false, error: String(e).slice(0, 120) }));
}
function importBulkInPage(authSlug, entries, loginErr, invalidErr = "Invalid batch response") {
  const unknown = (error) => ({ ok: false, batch: true, partial: false, added: null, failed: null, total: entries.length, errors: [], error });
  return fetch("/api/providers/" + authSlug + "/import-bulk", {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries }),
  }).then(async (r) => {
    if (r.status === 401 || r.status === 403) return unknown(loginErr);
    const d = await r.json().catch(() => null);
    if (!r.ok) return unknown(typeof d?.error === "string" ? d.error : "HTTP " + r.status);
    // claude-auth, codex-auth and agy-auth share this numeric, per-entry contract.
    // This helper is serialized in isolation, so it cannot call the API-key helper above.
    const valid = d && !d.error && [d.success, d.failed, d.total].every((n) => Number.isSafeInteger(n) && n >= 0)
      && d.total === entries.length && d.success + d.failed === d.total
      && Array.isArray(d.created) && d.created.length === d.success && d.created.every((c) => c && typeof c.id === "string" && c.id.trim())
      && Array.isArray(d.errors) && d.errors.length === d.failed
      && d.errors.every((e) => e && Number.isInteger(e.index) && e.index >= 0 && e.index < d.total && typeof e.message === "string")
      && new Set(d.errors.map((e) => e.index)).size === d.failed;
    if (!valid) return unknown(invalidErr);
    const errors = d.errors.map((e) => ({ index: e.index, message: e.message.slice(0, 240) }));
    return { ok: d.success > 0 && d.failed === 0, batch: true, partial: d.success > 0 && d.failed > 0, added: d.success, failed: d.failed, total: d.total, errors };
  }).catch(() => unknown(invalidErr));
}
async function zipImport(provider, b64) {
  const p = OMNI_OAUTH.find((o) => o.slug === provider);
  if (!p || !p.zipAuth) return { ok: false, error: t("bg_noZipSupport") };
  if (!b64) return { ok: false, error: t("bg_noFile") };
  const gw = await requireGateway(); if (gw) return gw;
  const ex = await runInDash(zipExtractInPage, [p.zipAuth, b64, t("bg_needLogin"), t("bg_invalidResponse")]);
  if (!ex || ex.ok !== true) return { ok: false, error: (ex && ex.error) || t("bg_zipExtractFail") };
  if (!Array.isArray(ex.entries)) return { ok: false, error: t("bg_invalidResponse") };
  if (!ex.entries.length) return { ok: false, error: t("bg_zipEmpty") };
  const ready = await requireGateway(); if (ready) return ready;
  const r = await runInDash(importBulkInPage, [p.zipAuth, ex.entries, t("bg_needLogin"), t("bg_invalidResponse")]);
  return { batch: true, added: null, failed: null, total: ex.entries.length, errors: [], ...r, slug: provider };
}

// Poll ONE provider's pending flow → updated state (state is stored per-provider, so concurrent
// flows for DIFFERENT providers never clobber each other; the single-flight guard on pollAllOauth
// prevents two concurrent passes over the SAME provider from double-hitting /poll → slow_down).
async function pollProvider(slug) {
  const key = OAUTH_KEY(slug);
  const { [key]: s } = await SEC.get(key);
  if (!s || s.status !== "pending") return s || null;
  const provider = OMNI_OAUTH_MAP[slug];
  if (!provider || provider.dashboardOnly) {
    const done = { ...s, status: "error", detail: t("bg_dashboardSetup") };
    await SEC.set({ [key]: done }); return done;
  }
  if (Date.now() > s.expiresAt) {
    const done = { ...s, status: "expired", detail: t("bg_codeExpired") };
    await SEC.set({ [key]: done }); return done;
  }
  // Respect the device-flow polling interval. GitHub (interval:5) returns slow_down — and then
  // WITHHOLDS the token indefinitely — if polled faster than allowed. The popup refreshes every 3s,
  // so gate the actual /poll hit here by nextPollAt, regardless of how often pollAllOauth runs.
  const interval = s.interval || 5;
  if (s.nextPollAt && Date.now() < s.nextPollAt) return s;
  // Device codes/verifiers are credentials too; an earlier successful start cannot authorize
  // forwarding them after a dashboard logout or a service replacement.
  const gw = await requireGateway();
  if (gw) {
    const wait = { ...s, nextPollAt: Date.now() + interval * 1000 };
    await SEC.set({ [key]: wait }); return wait;
  }
  const r = s.kind === "redirect"
    ? await runInDash(oauthCallbackPollInPage, [s.provider, t("bg_invalidResponse")], 35000)
    : await runInDash(oauthPollInPage, [s.provider, s.deviceCode, s.codeVerifier, s.extraData]);
  if (r && r.success === true) {
    const id = r.connection?.id;
    const valid = !r.error && typeof id === "string" && !!id.trim()
      && (!r.connection.provider || r.connection.provider === s.provider);
    const done = { ...s, status: valid ? "success" : "error", ...(valid ? { connId: id } : {}), detail: valid ? t("bg_connected") : t("bg_invalidResponse") };
    await SEC.set({ [key]: done }); return done;
  }
  if (s.kind === "redirect" && !r?.pending) {
    const done = { ...s, status: "error", detail: r?.error || t("bg_invalidResponse") };
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
