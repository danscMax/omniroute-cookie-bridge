// Offline regressions for the shipped worker and serialized MAIN-world functions.
// No fetch is allowed to leave these VM contexts; every credential below is synthetic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { EXT, makeChrome, makeSandbox, runFiles, tick } from "./test-harness.mjs";

const response = (body, status = 200, type = "application/json") => ({
  status, ok: status >= 200 && status < 300, redirected: false,
  headers: { get: (name) => name.toLowerCase() === "content-type" ? type : null },
  json: async () => { if (typeof body === "string") return JSON.parse(body); return body; },
  text: async () => typeof body === "string" ? body : JSON.stringify(body),
});
const roster = { connections: [], total: 0 };
const entries = [{ name: "Synthetic A", apiKey: "synthetic-key-a" }, { name: "Synthetic B", apiKey: "synthetic-key-b" }];
function batch(success, total = 2) {
  return { success, failed: total - success, total,
    created: Array.from({ length: success }, (_, i) => ({ id: "synthetic-" + i, provider: "openai" })),
    errors: Array.from({ length: total - success }, (_, i) => ({ index: i + success, name: "Synthetic entry", message: "Synthetic rejection" })),
  };
}
function timers() {
  let id = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn, ms) { pending.set(++id, { fn, ms }); return id; },
    clearTimeout(key) { pending.delete(key); },
    fire() { for (const [key, { fn }] of [...pending]) { pending.delete(key); fn(); } },
  };
}
function boot({ fetch = async () => { throw new Error("Unexpected synthetic fetch"); }, direct = false, cookies, tabs, clock } = {}) {
  const chrome = makeChrome();
  const injected = [];
  const openedTabs = [], captureFilters = [], cookieChanges = [];
  chrome.tabs.create = async (options) => { openedTabs.push(structuredClone(options)); return { id: openedTabs.length + 10, ...options }; };
  const addCaptureListener = chrome.webRequest.onBeforeSendHeaders.addListener;
  chrome.webRequest.onBeforeSendHeaders.addListener = (fn, filter, options) => {
    captureFilters.push(structuredClone({ filter, options }));
    addCaptureListener(fn);
  };
  if (cookies) chrome.cookies = { getAll: cookies, onChanged: { addListener: (fn) => cookieChanges.push(fn) } };
  if (tabs) chrome.tabs.query = async () => tabs;
  const page = makeSandbox({ extra: { fetch, ...(clock || {}) } });
  chrome.scripting.executeScript = async ({ func, args = [] }) => {
    injected.push(func.name);
    // Chrome serializes func; extension globals must not accidentally work in an InPage helper.
    page.args = structuredClone(args);
    const result = await vm.runInContext(`(${func.toString()})(...args)`, page);
    return [{ result: structuredClone(result) }];
  };
  const sandbox = makeSandbox({ chrome, extra: { fetch, ...(clock || {}), ...(direct ? { importScripts() {} } : {}) } });
  assert.deepEqual(runFiles(sandbox, ["providers.gen.js", "providers.js", "background.js"]), []);
  sandbox.sessionNames = vm.runInContext("sessionNames", sandbox);
  const message = (req) => new Promise((resolve) => {
    assert.equal(chrome._listeners.message[0](req, {}, resolve), true);
  });
  const inPage = async (name, args = []) => (await chrome.scripting.executeScript({ func: sandbox[name], args }))[0].result;
  const capture = (url, cookie = "", token = "", extra = {}) => chrome._listeners.webRequest[0]({
    url, requestHeaders: [...(cookie ? [{ name: "Cookie", value: cookie }] : []), ...(token ? [{ name: "Authorization", value: "Bearer " + token }] : [])], ...extra,
  });
  return { chrome, sandbox, message, inPage, injected, capture, openedTabs, captureFilters, cookieChanges };
}

const requestUrl = (p, pathname = "/api/synthetic") => new URL(pathname, p.captureUrls[0]).href;
const sessionCookies = (p, value = "synthetic-session") => p.cookieGroups.map((names, i) => ({ name: names[0], value: `${value}-${i}` }));
const sessionHeader = (p, value) => sessionCookies(p, value).map(({ name, value }) => `${name}=${value}`).join("; ");

test("popup discovery covers every configured cookie provider, keeps secrets in the worker and coalesces reads", async () => {
  const queries = [];
  let api;
  api = boot({ cookies: async (q) => {
    queries.push(q);
    const p = api.sandbox.OMNI_CAPTURE_WEB.find((p) => p.cred.t === "cookie" && p.captureUrls.includes(q.url));
    return p ? sessionCookies(p).map((c) => ({ ...c, domain: new URL(q.url).hostname, path: "/", storeId: "0", httpOnly: true })) : [];
  } });
  const results = await Promise.all(Array.from({ length: 5 }, () => api.message({ action: "getAll", discover: true })));
  const eligible = api.sandbox.OMNI_CAPTURE_WEB.filter((p) => p.cred.t === "cookie" && api.sandbox.sessionNames(p).length);
  assert.ok(eligible.length > 10, "exercise the real reviewed cookie catalog");
  for (const p of eligible) {
    assert.ok(results[0].caps[p.key], p.key + " is discovered without a provider request");
    assert.ok(api.chrome.storage.local._dump()["cap_" + p.key], "default disk mirror retained");
  }
  assert.equal(JSON.stringify(results).includes("synthetic-session"), false, "getAll never returns cookies/tokens");
  assert.deepEqual(api.injected, [], "discovery cannot import credentials or contact the gateway");
  assert.equal(new Set(queries.map((q) => JSON.stringify(q))).size, queries.length, "concurrent getAll calls share each cookie query");
  const n = queries.length;
  await api.message({ action: "getAll" });
  assert.equal(queries.length, n, "periodic getAll is a cheap storage read");
  const key = eligible[0].key;
  await api.message({ action: "clear", providerKey: key });
  assert.equal((await api.message({ action: "getAll", discover: true })).caps[key], null, "dismiss survives popup reopen/discovery");
  api.capture(requestUrl(eligible[0]), sessionHeader(eligible[0], "synthetic-new-session"));
  await tick();
  assert.ok((await api.message({ action: "getAll" })).caps[key], "new authenticated site activity can capture again");
});

test("a cookie scan selects a complete store/partition candidate and never assembles accounts", async () => {
  const api = boot({
    tabs: [{ id: 1, url: "https://www.perplexity.ai/", cookieStoreId: "firefox-container-1", active: true },
      { id: 2, url: "https://www.perplexity.ai/", cookieStoreId: "firefox-container-2" }],
    cookies: async (q) => {
      if (!q.storeId) return [{ name: "_ga", value: "synthetic-default", storeId: "firefox-default" }];
      const id = q.storeId;
      return [
        { name: "__Secure-next-auth.session-token.0", value: "synthetic-" + id, storeId: id, partitionKey: { topLevelSite: "https://perplexity.ai" } },
        { name: "__Secure-next-auth.session-token.1", value: "synthetic-other-partition", storeId: id, partitionKey: { topLevelSite: "https://unrelated.test" } },
        { name: "onlyInOtherPartition", value: "synthetic-unrelated", storeId: id, partitionKey: { topLevelSite: "https://unrelated.test" } },
      ];
    },
  });
  const cap = await api.sandbox.captureFromStore(api.sandbox.OMNI_WEB_MAP["perplexity-web"]);
  assert.ok(cap);
  assert.match(cap.cookie, /synthetic-firefox-container-1/);
  assert.doesNotMatch(cap.cookie, /container-2|synthetic-default|synthetic-other-partition|synthetic-unrelated/);
  assert.equal(cap.token, "", "cookie scans never borrow a token from another capture");
});

test("all configured token providers capture Bearer-only requests and retain tokens only in the same store", async () => {
  const api = boot();
  const providers = api.sandbox.OMNI_CAPTURE_WEB.filter((p) => p.cred.t === "token");
  assert.ok(providers.length);
  for (const p of providers) {
    if (new URL(p.site).origin !== new URL(p.captureUrls[0]).origin) {
      api.capture(p.site + "/api/synthetic", "", "synthetic-initiator-only", { cookieStoreId: "firefox-container-1" });
      await tick();
      assert.equal(api.chrome.storage.session._dump()["cap_" + p.key], undefined, p.key + " must not capture unrelated app-origin traffic");
    }
    api.capture(requestUrl(p), "", "synthetic-bearer", { cookieStoreId: "firefox-container-1" });
    await tick();
    const first = api.chrome.storage.session._dump()["cap_" + p.key];
    assert.equal(first?.token, "synthetic-bearer", p.key + " does not require cookies");
    api.capture(requestUrl(p, "/api/static"), "_ga=synthetic-a", "", { cookieStoreId: "firefox-container-1" });
    await tick();
    assert.equal(api.chrome.storage.session._dump()["cap_" + p.key].token, "synthetic-bearer");
    api.capture(requestUrl(p, "/api/foreign"), "_ga=synthetic-b", "", { cookieStoreId: "firefox-container-2" });
    await tick();
    const current = api.chrome.storage.session._dump()["cap_" + p.key];
    assert.equal(current.token, "synthetic-bearer");
    assert.doesNotMatch(current.cookie, /synthetic-b/, "a foreign store cannot be combined with the bearer");
  }
});

test("unknown credential formats and analytics-only cookies do not become ready sessions", async () => {
  const { sandbox } = boot();
  for (const p of sandbox.OMNI_WEB) {
    assert.equal(sandbox.hasSession(p, { cookie: "_ga=synthetic" }), false, p.key);
    if (!sandbox.sessionNames(p).length && p.cred.t !== "token") {
      assert.equal(sandbox.hasSession(p, { cookie: "", token: "synthetic-unknown-token" }), false, p.key + " has no known token contract");
    }
  }
  const deepseek = sandbox.OMNI_WEB.find((p) => p.cred.t === "token");
  assert.equal(sandbox.hasSession(deepseek, { cookie: "user-token=synthetic-cookie" }), false, "a configured Bearer provider needs a Bearer, not a cookie-shaped key");
});

for (const direct of [false, true]) test(`gateway classifications execute the real ${direct ? "Chrome direct" : "Firefox MAIN-world"} probe`, async () => {
  let reply = () => response(roster);
  const api = boot({ direct, fetch: async () => reply() });
  for (const [body, status, type, state] of [
    [roster, 200, "application/json; charset=utf-8", "ready"],
    [{ error: "Synthetic login" }, 401, "application/json", "unauthenticated"],
    [{ error: "Synthetic login" }, 403, "application/json", "unauthenticated"],
    ["<html>not OmniRoute</html>", 200, "text/html", "incompatible"],
    [{ hello: "world" }, 200, "application/json", "incompatible"],
    [{ connections: [{}] }, 200, "application/json", "incompatible"],
    ["broken json", 200, "application/json", "incompatible"],
    [{ error: "Synthetic unavailable" }, 503, "application/json", "unavailable"],
  ]) {
    reply = () => response(body, status, type);
    const r = await api.sandbox.pingGateway();
    assert.equal(r.state, state, `${status} ${type}`);
    assert.equal(r.ok, state === "ready");
    assert.equal(r.authenticated, state === "ready");
  }
  reply = () => { throw new Error("Synthetic offline"); };
  assert.equal((await api.sandbox.pingGateway()).state, "unreachable");
});

test("gateway rechecks authorization before every write, including after a previous success", async () => {
  let body = roster, status = 200;
  const writes = [];
  const api = boot({ fetch: async (url, opts = {}) => {
    if (opts.method === "POST" || opts.method === "PATCH") { writes.push(url); return response({ connection: { id: "synthetic-created" } }, 201); }
    return response(body, status);
  } });
  assert.equal((await api.sandbox.sendApiKeyToOmni("openai", "Synthetic", "synthetic-key")).ok, true);
  assert.equal(writes.length, 1);
  for (const [next, code] of [[{ error: "Synthetic auth" }, 401], [{ wrong: true }, 200], [roster, 503]]) {
    body = next; status = code;
    assert.equal((await api.sandbox.sendApiKeyToOmni("openai", "Synthetic", "synthetic-never-send")).ok, false);
    assert.equal(writes.length, 1, "previous success cannot approve a later invalid gateway");
  }
});

test("gateway deadlines cover response bodies, abort fetch, and clear timers", async () => {
  for (const direct of [false, true]) {
    const clock = timers();
    let signal;
    const api = boot({ direct, clock, fetch: async (_url, opts) => {
      signal = opts.signal;
      return { ...response(roster), json: () => new Promise(() => {}) };
    } });
    const pending = api.sandbox.pingGateway();
    await tick();
    assert.ok(signal, "probe supplies an abort signal");
    clock.fire();
    const r = await pending;
    assert.equal(r.ok, false);
    assert.equal(r.state, "timeout");
    assert.equal(signal.aborted, true);
    assert.equal(clock.pending.size, 0);
  }
  const clock = timers();
  const api = boot({ clock, fetch: async () => response(roster) });
  assert.equal((await api.sandbox.pingGateway()).ok, true);
  assert.equal(clock.pending.size, 0, "successful injection and fetch both release deadlines");
});

test("invalid provider lists are unreadable, never an empty successful roster", async () => {
  for (const body of [{}, { connections: null }, { connections: [{}] }, { connections: "synthetic" }]) {
    const api = boot({ fetch: async () => response(body) });
    assert.equal((await api.sandbox.readConnections()).unreachable, true);
  }
});

test("all API-key and ZIP batch helpers use the upstream numeric result contract", async () => {
  let result;
  const api = boot({ fetch: async () => response(result) });
  const routes = [
    ...api.sandbox.OMNI_APIKEY.filter((p) => p.bulk && !p.dashboardOnly).map((p) => ["bulkApiKeyInPage", p.slug]),
    ...api.sandbox.OMNI_OAUTH.filter((p) => p.zipAuth).map((p) => ["importBulkInPage", p.zipAuth]),
  ];
  assert.ok(routes.length > 200);
  for (const [fn, slug] of routes) for (const added of [0, 1, 2]) {
    result = batch(added);
    const r = await api.inPage(fn, [slug, entries, "Synthetic login", "Synthetic malformed"]);
    assert.equal(r.added, added, fn + " " + slug);
    assert.equal(r.failed, 2 - added);
    assert.equal(r.total, 2);
    assert.equal(r.ok, added === 2, "only a fully successful batch is ok");
    assert.equal(r.partial, added === 1);
    assert.equal(r.errors.length, 2 - added, "failed entry information retained");
    assert.equal(JSON.stringify(r).includes("synthetic-key"), false);
  }
});

test("malformed and contradictory batch summaries never invent successful additions", async () => {
  const invalid = [{}, null, { imported: [] }, { success: true }, { ...batch(1), success: "1" },
    { ...batch(1), total: 3 }, { ...batch(1), created: [] }, { ...batch(1), errors: [] },
    { ...batch(1), errors: [{ index: 9, message: "Synthetic invalid index" }] },
    { ...batch(2), created: [{}, {}] }];
  for (const body of invalid) {
    const api = boot({ fetch: async () => response(body) });
    for (const fn of ["bulkApiKeyInPage", "importBulkInPage"]) {
      const r = await api.inPage(fn, ["synthetic", entries, "Synthetic login", "Synthetic malformed"]);
      assert.equal(r.ok, false, fn + " must reject malformed/contradictory summaries");
      assert.equal(r.added, null, "unknown count is not zero or the requested count");
      assert.ok(r.error);
    }
  }
});

test("bulk input is not silently dropped, extra data is forwarded and account ids are not fabricated", async () => {
  const bodies = [];
  const api = boot({ fetch: async (url, opts = {}) => {
    if (!opts.method || opts.method === "GET") return response(roster);
    bodies.push(JSON.parse(opts.body));
    return response(batch(JSON.parse(opts.body).entries.length, JSON.parse(opts.body).entries.length));
  } });
  const r = await api.sandbox.bulkAddApiKeys("openai", ["short", "synthetic-long-key"]);
  assert.equal(r.added, 2, "upstream accepts any nonempty key; a short line must not vanish");
  assert.equal(bodies[0].entries.length, 2);
  assert.equal(bodies[0].entries[0].accountId, undefined, "hashing an API key does not produce a Cloudflare account id");
  const cloudflare = await api.sandbox.bulkAddApiKeys("cloudflare-ai", ["short", "synthetic-long-key"], { accountId: "synthetic-cloudflare-account", tag: "synthetic-tag" });
  assert.equal(cloudflare.added, 2);
  assert.deepEqual(bodies[1].providerSpecificData, { accountId: "synthetic-cloudflare-account", tag: "synthetic-tag" });
  assert.ok(bodies[1].entries.every((entry) => entry.accountId === "synthetic-cloudflare-account"), "each Cloudflare bulk entry carries the actual accountId");
  assert.equal((await api.sandbox.bulkAddApiKeys("google-pse-search", ["synthetic-key"], { cx: "synthetic-cx" })).ok, false);
  assert.equal(bodies.length, 2, "PSE is excluded from bulk even when cx is supplied");
});

test("200 with missing create/import connection id cannot trigger a success probe", async () => {
  const api = boot({ fetch: async () => response({}) });
  for (const [name, args] of [
    ["postProviderInPage", ["openai", "Synthetic", "synthetic-key", "apikey", null, "Synthetic login"]],
    ["oauthImportTokenInPage", ["devin-cli", "synthetic-token", "Synthetic login"]],
  ]) assert.equal((await api.inPage(name, args)).ok, false, name);
});

async function popup(replies = {}) {
  const { document } = parseHTML(readFileSync(join(EXT, "popup.html"), "utf8"));
  const chrome = makeChrome();
  const calls = [];
  chrome.permissions = { contains: async () => true };
  chrome.runtime.sendMessage = (req, cb) => {
    calls.push(req);
    const defaults = {
      getAll: { caps: {} }, getProbes: { probes: {} }, oauthState: { states: {} },
      getSettings: { settings: { sweep: false, notify: false, nightly: false, theme: "light" } },
      connections: { byProvider: {}, total: 0, all: [], problems: [], unreachable: false },
    };
    const answer = replies[req.action] ?? defaults[req.action] ?? { ok: true };
    const result = typeof answer === "function" ? answer(req) : answer;
    cb?.(result);
    return Promise.resolve(result);
  };
  const sandbox = makeSandbox({ chrome, extra: { document, navigator: { userAgent: "Synthetic browser" }, location: { search: "" },
    setTimeout: () => 0, clearTimeout() {}, Blob: class {},
  } });
  sandbox.window = sandbox;
  assert.deepEqual(runFiles(sandbox, ["providers.gen.js", "providers.js", "popup.js"]), []);
  await tick();
  return { sandbox, document, calls, chrome };
}

function popupTransport(p) {
  const send = p.chrome.runtime.sendMessage;
  const transport = { failure: null, calls: [], unchecked: [] };
  p.chrome.runtime.sendMessage = (req, cb) => {
    transport.calls.push(req);
    const failure = transport.failure;
    if (!failure) return send(req, cb);
    if (failure.sync) throw new Error(failure.message);
    queueMicrotask(() => {
      let consumed = false;
      Object.defineProperty(p.chrome.runtime, "lastError", {
        configurable: true,
        get() { consumed = true; return failure.message ? { message: failure.message } : undefined; },
      });
      try { cb(failure.reply); }
      finally {
        delete p.chrome.runtime.lastError;
        if (failure.message && !consumed) transport.unchecked.push(req.action);
      }
    });
  };
  return transport;
}

test("popup transport failures consume callback lastError without replay and preserve later replies", async () => {
  const replies = {}, p = await popup(replies), transport = popupTransport(p);
  const send = vm.runInContext("msg", p.sandbox);
  for (const failure of [
    { message: "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received" },
    { message: "The message port closed before a response was received." },
    { message: "Could not establish connection. Receiving end does not exist." },
    { sync: true, message: "Extension context invalidated." },
    {}, { reply: null },
  ]) {
    transport.failure = failure; transport.calls.length = 0;
    const result = await send({ action: "addApiKey", slug: "openai", apiKey: "synthetic-must-not-replay" });
    assert.equal(result.ok, false);
    assert.equal(result.transportError, true);
    assert.equal(result.unreachable, true);
    assert.ok(result.error);
    if (failure.message) assert.equal(result.error, failure.message);
    assert.equal(result.detail, result.error);
    assert.equal(result.id, undefined, "a lost response cannot invent a created account");
    assert.equal(result.added, undefined, "a lost response cannot invent a batch count");
    assert.equal(JSON.stringify(result).includes("synthetic-must-not-replay"), false);
    assert.deepEqual(transport.calls.map((r) => r.action), ["addApiKey"]);
    p.sandbox.saveSettings(); // The real caller ignores its Promise; node:test detects any unhandled rejection.
    await tick();
    assert.deepEqual(transport.calls.map((r) => r.action), ["addApiKey", "setSettings"]);
    assert.deepEqual(transport.unchecked, [], "lastError must be consumed before the callback returns");
    transport.failure = null;
    for (const reply of [{ ok: true, state: "ready" }, { ok: false, error: "Synthetic application failure" }, false]) {
      replies.ping = reply;
      assert.equal(await send({ action: "ping" }), reply, "successful transport preserves even negative/falsy replies unchanged");
    }
    assert.equal(transport.calls.filter((r) => r.action === "addApiKey").length, 1, "recovery never replays the write");
  }
});

test("popup transport failures mark the roster unreadable and the server offline, then recover", async () => {
  const p = await popup({ connections: {
    byProvider: { openai: { total: 1, good: 1, bad: 0, names: ["Synthetic account"] } },
    total: 1, all: [{ id: "synthetic-account", provider: "openai", name: "Synthetic account" }], problems: [], unreachable: false,
  } });
  const transport = popupTransport(p);
  transport.failure = { message: "Could not establish connection. Receiving end does not exist." };
  await p.sandbox.loadConnections();
  assert.equal(vm.runInContext("connUnreachable", p.sandbox), true);
  assert.equal(p.document.getElementById("ftrHint").textContent, p.chrome.i18n.getMessage("popup_footerUnreadable"), "disconnection is not an empty successful roster");
  await p.sandbox.probeServer();
  assert.equal(p.document.getElementById("srvDot").classList.contains("bad"), true);
  assert.equal(p.document.body.classList.contains("offline"), true);
  assert.ok(p.document.getElementById("srvTxt").textContent.includes(transport.failure.message));
  assert.deepEqual(transport.unchecked, []);
  transport.failure = null;
  await p.sandbox.probeServer(); await p.sandbox.loadConnections();
  assert.equal(p.document.getElementById("srvDot").classList.contains("ok"), true);
  assert.equal(p.document.body.classList.contains("offline"), false);
  assert.equal(vm.runInContext("connUnreachable", p.sandbox), false);
  assert.equal(vm.runInContext("connTotal", p.sandbox), 1);
  assert.ok(p.document.getElementById("ftrHint").textContent.includes("🔗 1"));
});

test("popup transport failures cannot acknowledge an import, probe or session refresh", async () => {
  const p = await popup({ connections: {
    byProvider: { openai: { total: 1, good: 0, bad: 0, names: [] } }, total: 1, all: [], problems: [], unreachable: false,
  } });
  const transport = popupTransport(p);
  transport.failure = { message: "The message port closed before a response was received." };
  vm.runInContext('keyExpanded = "openai"; $("keySearch").value = "openai"; renderKeyList();', p.sandbox);
  const form = p.document.querySelector(".keyform"), key = form.querySelector('input[type="password"]');
  const add = form.querySelector(".actions button"), res = form.querySelector(".res");
  key.value = "synthetic-unsent-key";
  await add.onclick();
  assert.equal(res.classList.contains("bad"), true);
  assert.ok(res.textContent.includes(transport.failure.message));
  assert.equal(key.value, "synthetic-unsent-key", "failure retains the user's draft");
  assert.equal(add.disabled, false);
  assert.deepEqual(transport.calls.map((r) => r.action), ["addApiKey"], "a lost import reply triggers neither a probe nor another write");
  await p.sandbox.reprobe(res, "openai");
  assert.equal(res.classList.contains("mut"), true, "a lost probe reply is unknown, not a successful or dead provider");
  assert.ok(res.textContent.includes(transport.failure.message));
  const refresh = p.document.getElementById("refreshAllBtn");
  for (const run of [() => p.sandbox.runProbeAll(), () => p.sandbox.runRefresh(["perplexity-web"], refresh)]) {
    await run();
    const summary = p.document.getElementById("probeAllRes");
    assert.equal(summary.classList.contains("bad"), true, "missing aggregate results cannot render green success");
    assert.ok(summary.textContent.includes(transport.failure.message));
    assert.equal(p.document.getElementById("probeProg").classList.contains("hide"), true);
  }
  assert.equal(p.document.getElementById("probeAllBtn").disabled, false);
  assert.equal(refresh.disabled, false);
  assert.deepEqual(transport.unchecked, []);
});

test("popup requests discovery only at startup and retains batch summaries through roster refreshes", async () => {
  for (const added of [0, 1, 2]) {
    const p = await popup();
    assert.ok(p.calls.find((c) => c.action === "getAll")?.discover, "popup explicitly requests initial cookie discovery");
    p.calls.length = 0;
    await p.sandbox.refresh();
    assert.equal(p.calls.find((c) => c.action === "getAll")?.discover, undefined, "periodic refresh does not rescan stores");
    const res = p.document.createElement("div");
    const r = { ...batch(added), added, ok: added === 2, partial: added === 1, slug: "openai" };
    await p.sandbox.addAndProbe(res, async () => r);
    assert.equal(p.calls.filter((c) => c.action === "probe").length, 0, "batch import does not spend a quota probe or conceal failures");
    assert.equal(res.classList.contains("ok"), added === 2);
    assert.match(res.textContent, /2/, "the total is shown");
    assert.ok(p.calls.some((c) => c.action === "connections"), "batch completion refreshes the roster, including zero/partial outcomes");
    if (added < 2) assert.match(res.textContent, /Synthetic rejection/, "per-entry failure remains visible");
  }
});

test("bulk form keeps only failed keys after its roster refresh, and forwards required extras", async () => {
  const p = await popup({ bulkAddApiKey: { ...batch(1), batch: true, added: 1, ok: false, partial: true, slug: "cloudflare-ai" } });
  assert.equal(p.sandbox.OMNI_APIKEY_MAP["cloudflare-ai"].bulk, true);
  vm.runInContext('keyExpanded = "cloudflare-ai"; $("keySearch").value = "cloudflare-ai"; renderKeyList();', p.sandbox);
  const form = p.document.querySelector(".keyform");
  const area = form.querySelector("textarea");
  const toggle = [...form.querySelectorAll("button")].find((b) => b.textContent === p.chrome.i18n.getMessage("key_bulkOn"));
  assert.ok(toggle, "the real supported provider offers bulk mode");
  toggle.onclick();
  area.value = "synthetic-key-a\nsynthetic-key-b";
  const extra = [...form.querySelectorAll("input")].find((input) => (input.placeholder || "").includes("Cloudflare Account ID"));
  assert.ok(extra);
  const add = form.querySelector(".actions button");
  await add.onclick();
  assert.equal(p.calls.filter((c) => c.action === "bulkAddApiKey").length, 0, "required fields also apply to bulk mode");
  extra.value = "synthetic-cloudflare-account";
  await add.onclick();
  const sent = p.calls.find((c) => c.action === "bulkAddApiKey");
  assert.equal(sent.psd.accountId, "synthetic-cloudflare-account");
  assert.equal(p.document.querySelector(".keyform textarea").value, "synthetic-key-b", "refresh must not replace the form before failed rows are retained");
  assert.match(p.document.querySelector(".keyform .res").textContent, /Synthetic rejection/);
  assert.equal(p.calls.filter((c) => c.action === "probe").length, 0);
});

test("an unknown cookie account cannot adopt a sole or recently-created foreign connection", async () => {
  const connections = [{ id: "synthetic-foreign", provider: "perplexity-web", name: "Perplexity Web · foreign", createdAt: new Date().toISOString() }];
  const api = boot({ fetch: async () => response({ connections }) });
  const provider = api.sandbox.OMNI_WEB_MAP["perplexity-web"];
  const cap = { cookie: "__Secure-next-auth.session-token=synthetic-new-account", token: "", storeId: "firefox-container-2" };
  assert.equal((await api.sandbox.resolveSlot(provider, cap)).conn, null, "one connection is not proof of ownership");
  connections.push({ id: "synthetic-second", provider: provider.slug, name: "Another account" });
  assert.equal((await api.sandbox.resolveSlot(provider, cap)).conn, null, "a recent matching label is not proof either");
  await api.chrome.storage.local.set({ "slot_perplexity-web": { id: connections[0].id, storeId: "firefox-container-1" } });
  assert.equal((await api.sandbox.resolveSlot(provider, cap)).conn, null, "a remembered slot in another container is foreign");
  cap.storeId = "firefox-container-1";
  assert.equal((await api.sandbox.resolveSlot(provider, cap)).conn.id, connections[0].id, "same-store remembered slots still refresh in place");
});

test("a store-discovered session keeps its timestamp and remembered slot after the same XHR", async () => {
  for (const direct of [false, true]) {
    const storeId = direct ? "0" : "firefox-container-1";
    const cookie = "__Secure-next-auth.session-token=synthetic-session";
    const api = boot({ direct,
      tabs: [{ id: 1, url: "http://127.0.0.1:20128/home" }, { id: 2, url: "https://www.perplexity.ai/", ...(direct ? {} : { cookieStoreId: storeId }) }],
      cookies: async () => [{ name: "__Secure-next-auth.session-token", value: "synthetic-session", storeId, domain: ".perplexity.ai", path: "/" }],
      fetch: async () => response({ connections: [{ id: "synthetic-mine", provider: "perplexity-web", name: "Synthetic remembered account" }] }),
    });
    const provider = api.sandbox.OMNI_WEB_MAP["perplexity-web"];
    const cap = await api.sandbox.captureFromStore(provider);
    await api.chrome.storage.local.set({ "slot_perplexity-web": { id: "synthetic-mine", storeId: cap.storeId, cookieContext: cap.cookieContext } });
    await tick();
    api.capture("https://www.perplexity.ai/api/synthetic", cookie, "", direct ? {} : { cookieStoreId: storeId });
    await tick();
    const next = api.chrome.storage.session._dump()["cap_perplexity-web"];
    assert.equal(next.at, cap.at, "reading the same credential from a header is not a new account/capture");
    assert.equal((await api.sandbox.resolveSlot(provider, next)).conn?.id, "synthetic-mine", "scan and header contexts address the same remembered slot");
  }
});

test("dismiss remains effective after the discovery cooldown, and missing host access is isolated", async () => {
  let now = Date.now();
  const queries = [];
  const api = boot({ clock: { Date: class extends Date { static now() { return now; } } }, cookies: async (q) => {
    queries.push(q.url);
    if (q.url.startsWith("https://claude.ai")) throw new Error("Synthetic host permission denied");
    if (q.url.startsWith("https://www.perplexity.ai")) return [{ name: "__Secure-next-auth.session-token", value: "synthetic-session", storeId: "0" }];
    return [];
  } });
  assert.ok((await api.message({ action: "getAll", discover: true })).caps["perplexity-web"], "one permission failure does not stop other providers");
  await api.message({ action: "clear", providerKey: "perplexity-web" });
  now += 16000;
  queries.length = 0;
  assert.equal((await api.message({ action: "getAll", discover: true })).caps["perplexity-web"], null);
  assert.equal(queries.some((url) => url.startsWith("https://www.perplexity.ai")), false, "dismissed providers are excluded from a fresh scan");
});

test("unpartitioned cookie candidates still keep different store ids separate", async () => {
  const api = boot({ cookies: async () => [
    { name: "__Secure-next-auth.session-token.0", value: "synthetic-account-a", storeId: "firefox-default" },
    { name: "__Secure-next-auth.session-token.1", value: "synthetic-account-b", storeId: "firefox-container-2" },
  ] });
  const cap = await api.sandbox.captureFromStore(api.sandbox.OMNI_WEB_MAP["perplexity-web"]);
  assert.ok(cap);
  assert.doesNotMatch(cap.cookie, /synthetic-account-b/, "normalizing the unpartitioned context must not merge stores");
});

test("ZIP imports exercise every configured endpoint and recheck the gateway after extraction", async () => {
  let ready = true, added = 0, expireAfterExtract = false;
  const posted = [];
  const archiveEntries = [{ name: "Synthetic archive A", json: {} }, { name: "Synthetic archive B", json: {} }];
  const api = boot({ fetch: async (url, opts = {}) => {
    if (!opts.method) return response(ready ? roster : { error: "Synthetic sign-in required" }, ready ? 200 : 401);
    posted.push(url);
    if (url.endsWith("/zip-extract")) {
      if (expireAfterExtract) ready = false;
      return response({ entries: archiveEntries });
    }
    assert.ok(url.endsWith("/import-bulk"));
    assert.deepEqual(JSON.parse(opts.body), { entries: archiveEntries });
    return response(batch(added));
  } });
  for (const p of api.sandbox.OMNI_OAUTH.filter((p) => p.zipAuth)) {
    for (added of [0, 1, 2]) {
      posted.length = 0;
      const result = await api.sandbox.zipImport(p.slug, "c3ludGhldGlj");
      assert.equal(result.added, added);
      assert.equal(result.failed, 2 - added);
      assert.equal(result.ok, added === 2);
      assert.deepEqual(posted, [`/api/providers/${p.zipAuth}/zip-extract`, `/api/providers/${p.zipAuth}/import-bulk`]);
    }
    ready = true; expireAfterExtract = true; posted.length = 0;
    assert.equal((await api.sandbox.zipImport(p.slug, "c3ludGhldGlj")).ok, false);
    assert.deepEqual(posted, [`/api/providers/${p.zipAuth}/zip-extract`], "a signed-out dashboard cannot receive extracted credentials");
    ready = true; expireAfterExtract = false;
  }
});

test("model-list deadlines cover headers and bodies in both browser paths", async () => {
  for (const direct of [false, true]) for (const stalledBody of [false, true]) {
    const clock = timers();
    let signal;
    const api = boot({ direct, clock, fetch: async (_url, opts = {}) => {
      signal = opts.signal;
      return stalledBody ? { ...response({ data: [] }), json: () => new Promise(() => {}) } : new Promise(() => {});
    } });
    const pending = api.sandbox.fetchModels();
    await tick();
    assert.ok(signal, "model reads supply an abort signal");
    clock.fire();
    assert.equal((await pending).ok, false);
    assert.equal(signal.aborted, true);
    assert.equal(clock.pending.size, 0);
  }
  for (const direct of [false, true]) {
    const clock = timers();
    let body = { data: [{}] };
    const api = boot({ direct, clock, fetch: async () => response(body) });
    assert.equal((await api.sandbox.fetchModels()).ok, false, "malformed models are not a cached success");
    body = { data: [{ id: "openai/synthetic-model" }] };
    assert.equal((await api.sandbox.fetchModels()).models[0].id, "openai/synthetic-model");
    assert.equal(clock.pending.size, 0);
  }
});

test("pending device flows never forward codes to a signed-out or incompatible gateway", async () => {
  for (const [body, status] of [[{ error: "Synthetic sign-in required" }, 401], [{ wrong: true }, 200]]) {
    const writes = [];
    const api = boot({ fetch: async (url, opts = {}) => {
      if (opts.method === "POST") { writes.push(url); return response({ error: "authorization_pending" }); }
      return response(body, status);
    } });
    for (const p of api.sandbox.OMNI_OAUTH.filter((p) => p.deviceFlow && !p.dashboardOnly)) {
      await api.chrome.storage.session.set({ ["oauth_" + p.slug]: {
        provider: p.slug, kind: "device", status: "pending", deviceCode: "synthetic-device-code",
        codeVerifier: "synthetic-verifier", expiresAt: Date.now() + 60000, interval: 5,
      } });
      const state = await api.sandbox.pollProvider(p.slug);
      assert.equal(state.status, "pending", "a temporary dashboard problem does not discard the flow");
      assert.ok(state.nextPollAt > Date.now());
    }
    assert.deepEqual(writes, [], "gateway auth is checked again after the flow starts");
  }
});

test("old invalid captures cannot be imported by a manual send or restart path", async () => {
  const writes = [];
  const api = boot({ fetch: async (url, opts = {}) => {
    if (opts.method === "POST" || opts.method === "PATCH") { writes.push(url); return response({ connection: { id: "synthetic-wrong" } }, 201); }
    return response(roster);
  } });
  for (const p of api.sandbox.OMNI_WEB) {
    await api.chrome.storage.session.set({ ["cap_" + p.key]: { cookie: "_ga=synthetic", token: "" } });
    assert.equal((await api.sandbox.sendToOmni(p.key)).ok, false, p.key + " needs a known session credential");
  }
  assert.deepEqual(writes, []);
});

test("hung cookie discovery is bounded and coalesced without late capture writes", async () => {
  const clock = timers();
  let now = Date.now();
  const pendingQueries = [];
  const api = boot({ clock: { ...clock, Date: class extends Date { static now() { return now; } } },
    cookies: (q) => new Promise((resolve) => pendingQueries.push({ q, resolve })),
  });
  const pending = Promise.all(Array.from({ length: 5 }, () => api.message({ action: "getAll", discover: true })));
  await tick();
  assert.ok(pendingQueries.length > 0 && pendingQueries.length <= 4, "discovery starts at most four cookie queries concurrently");
  now += 5000;
  clock.fire();
  const results = await pending;
  assert.equal(results.some((r) => Object.values(r.caps).some(Boolean)), false);
  assert.equal(clock.pending.size, 0);
  for (const query of pendingQueries) query.resolve([{ name: "sessionKey", value: "synthetic-late-session" }]);
  await tick();
  assert.equal(Object.keys(api.chrome.storage.session._dump()).some((k) => k.startsWith("cap_")), false, "expired cookie queries do not publish stale captures");
});

test("identical authenticated XHRs do not repeatedly write or remove session storage", async () => {
  const api = boot();
  const storage = api.chrome.storage.session;
  const set = storage.set, remove = storage.remove;
  let writes = 0, removals = 0;
  storage.set = (...args) => { writes++; return set(...args); };
  storage.remove = (...args) => { removals++; return remove(...args); };
  for (let i = 0; i < 12; i++) api.capture("https://claude.ai/api/synthetic", "sessionKey=synthetic-identical");
  await tick();
  assert.equal(writes, 1, "a burst of identical captures has one storage write");
  assert.equal(removals, 0, "an absent dismissal marker does not need twelve storage removals");
});

for (const direct of [false, true]) for (const probe of [false, true]) {
  test(`${probe ? "chatProbe" : "chatOnce"} bounds stalled bodies in the ${direct ? "direct" : "serialized page"} path`, async () => {
    for (const honorsAbort of [false, true]) {
      const clock = timers();
      const reply = { choices: [{ message: { content: "Synthetic late completion" } }] };
      let signal, resolveBody, result, requests = 0;
      const api = boot({ direct, clock, fetch: async (_url, opts) => {
        requests++;
        signal = opts.signal;
        return { ...response(reply), json: () => new Promise((resolve, reject) => {
          resolveBody = resolve;
          if (honorsAbort) signal.addEventListener("abort", () => reject(Object.assign(new Error("Synthetic body aborted"), { name: "AbortError" })), { once: true });
        }) };
      } });
      const pending = probe ? api.sandbox.chatProbe("openai/synthetic-model")
        : api.sandbox.chatOnce("openai/synthetic-model", [{ role: "user", content: "Synthetic test" }]);
      pending.then((r) => { result = r; });
      try {
        await tick();
        assert.ok(resolveBody, "response headers arrived and the body is being read");
        const deadline = [...clock.pending].find(([, timer]) => timer.ms === (probe ? 30000 : 90000));
        assert.ok(deadline, "the fetch deadline stays active after receiving headers");
        // Fire only the fetch deadline, not runInDash's longer outer injection timeout.
        clock.pending.delete(deadline[0]);
        deadline[1].fn();
        await tick();
        assert.ok(result, "the deadline settles even when a body ignores abort");
        assert.equal(signal.aborted, true);
        assert.equal(result.ok, false, "aborting a 200 response body is not a successful completion");
        assert.equal(result.text, undefined);
        if (probe) {
          assert.equal(result.netErr, true, "a timed-out probe is unknown, not an auth verdict");
          assert.equal(result.msg, api.chrome.i18n.getMessage("bg_probeAbort"));
        } else {
          assert.equal(result.status, 0);
          assert.equal(result.error, api.chrome.i18n.getMessage("bg_timeout"));
        }
        assert.equal(requests, 1, "a timed-out completion is not sent again through a dashboard tab");
        assert.equal(api.injected.length, direct ? 0 : 1);
        assert.equal(clock.pending.size, 0, "fetch and injection deadlines are both released");
      } finally {
        resolveBody?.(reply);
        clock.fire();
        await pending;
      }
    }
  });
}

test("chat deadlines clear on completed bodies and retain HTTP failures in both browser paths", async () => {
  for (const direct of [false, true]) for (const probe of [false, true]) for (const status of [200, 401]) {
    const clock = timers();
    const reply = status === 200 ? { choices: [{ message: { content: "Synthetic reply" } }], usage: { total_tokens: 2 } }
      : { error: { message: "Synthetic authentication failure" } };
    let requests = 0;
    const api = boot({ direct, clock, fetch: async () => { requests++; return response(reply, status); } });
    const result = probe ? await api.sandbox.chatProbe("openai/synthetic-model")
      : await api.sandbox.chatOnce("openai/synthetic-model", [{ role: "user", content: "Synthetic test" }]);
    assert.equal(result.ok, status === 200);
    if (status === 200) assert.equal(result.text, "Synthetic reply");
    else {
      assert.equal(result.status, 401);
      assert.equal(probe ? result.msg : result.error, "Synthetic authentication failure");
    }
    assert.equal(requests, 1, "HTTP responses do not cause a second completion");
    assert.equal(clock.pending.size, 0);
  }
});

test("chat direct network failures retain the one dashboard fallback", async () => {
  for (const probe of [false, true]) {
    const clock = timers(), urls = [];
    const api = boot({ direct: true, clock, fetch: async (url) => {
      urls.push(url);
      if (url.startsWith("http:")) throw new TypeError("Synthetic direct network failure");
      return response({ choices: [{ message: { content: "Synthetic fallback reply" } }] });
    } });
    const result = probe ? await api.sandbox.chatProbe("openai/synthetic-model")
      : await api.sandbox.chatOnce("openai/synthetic-model", [{ role: "user", content: "Synthetic test" }]);
    assert.equal(result.ok, true);
    assert.equal(result.text, "Synthetic fallback reply");
    assert.deepEqual(urls, ["http://127.0.0.1:20128/v1/chat/completions", "/v1/chat/completions"]);
    assert.equal(clock.pending.size, 0);
  }
});

test("focused API-key row headers open forms while focused text fields retain their drafts", async () => {
  const p = await popup();
  vm.runInContext('$("keySearch").value = "openai"; renderKeyList();', p.sandbox);
  let active = null;
  Object.defineProperty(p.document, "activeElement", { configurable: true, get: () => active });
  const row = [...p.document.querySelectorAll(".keyrow")].find((row) => row.querySelector(".kname").textContent === p.sandbox.OMNI_APIKEY_MAP.openai.label);
  assert.ok(row);
  active = row.querySelector(".keyrow-h"); // a real mouse/keyboard activation focuses the header
  active.onclick();
  const input = p.document.querySelector('.keyform input[type="password"]');
  assert.ok(input, "focus on the activated header must not suppress the form render");
  input.value = "synthetic-unsent-draft";
  active = input;
  p.sandbox.renderKeyList();
  assert.equal(p.document.querySelector('.keyform input[type="password"]'), input, "a focused credential draft is still protected from background renders");
  assert.equal(input.value, "synthetic-unsent-draft");
});

test("focused OAuth actions render device progress and cancellation without wiping token drafts", async () => {
  let started = false;
  const p = await popup({
    oauthStart: () => { started = true; return { ok: true }; },
    oauthCancel: () => { started = false; return { ok: true }; },
    oauthState: () => ({ states: started ? { github: { status: "pending", kind: "device", userCode: "TEST-ONLY", verifyUrl: "", interval: 5 } } : {} }),
  });
  let active = null;
  Object.defineProperty(p.document, "activeElement", { configurable: true, get: () => active });
  active = [...p.document.querySelectorAll('#oauthList [data-slug="github"] button')]
    .find((button) => !button.closest(".provider-guidance") && button.textContent === p.chrome.i18n.getMessage("oauth_connect"));
  assert.ok(active);
  await active.onclick();
  assert.equal(p.document.querySelector('[data-slug="github"] .code')?.textContent, "TEST-ONLY", "the focused Connect button must not freeze the old card");
  active = p.document.querySelector('[data-slug="github"] .cancel');
  await active.onclick();
  assert.equal(p.document.querySelector('[data-slug="github"] .code'), null, "cancel renders immediately even while its button is focused");
  const input = p.document.querySelector('#oauthList [data-slug="devin-cli"] input[type="password"]');
  assert.ok(input);
  input.value = "synthetic-token-draft";
  active = input;
  p.sandbox.renderOauth();
  assert.equal(p.document.querySelector('#oauthList [data-slug="devin-cli"] input[type="password"]'), input);
  assert.equal(input.value, "synthetic-token-draft");
});

test("every reviewed web recipe captures only its request hosts and complete credential format", async () => {
  const api = boot();
  const expectedFilters = [...new Set(api.sandbox.OMNI_CAPTURE_WEB.flatMap((p) => p.capturePerms))].sort();
  assert.equal(api.captureFilters.length, 1);
  assert.deepEqual(api.captureFilters[0].filter.urls.slice().sort(), expectedFilters);
  assert.deepEqual(api.captureFilters[0].filter.types, ["xmlhttprequest"]);
  assert.ok(api.captureFilters[0].options.includes("requestHeaders"));
  const captured = [];
  for (const p of api.sandbox.OMNI_CAPTURE_WEB) {
    const key = "cap_" + p.key, url = requestUrl(p), host = new URL(url).hostname;
    const cookie = p.cred.t === "cookie" ? sessionHeader(p) : "";
    const token = p.cred.t === "token" ? "synthetic-reviewed-bearer" : "";
    const flush = () => api.sandbox.queueCapture(p.key, async () => {});
    for (const wrong of [`http://${host}/api/synthetic`, `https://${host}.unreviewed.test/api/synthetic`, `https://extra.${host}/api/synthetic`]) {
      api.capture(wrong, cookie, token); await flush();
      assert.equal(api.chrome.storage.session._dump()[key], undefined, `${p.slug}: wrong host ${wrong}`);
    }
    if (!p.hostRe.test(p.site)) {
      assert.ok(p.perms.includes(new URL(p.site).origin + "/*"));
      assert.ok(!p.capturePerms.includes(new URL(p.site).origin + "/*"));
      api.capture(p.site, cookie, token); await flush();
      assert.equal(api.chrome.storage.session._dump()[key], undefined, `${p.slug}: initiator-only permission is not a capture recipe`);
    }
    if (p.cred.t === "cookie") {
      const complete = sessionCookies(p);
      for (let missing = 0; missing < p.cookieGroups.length; missing++) {
        const incomplete = complete.filter((_, i) => i !== missing).map((c) => `${c.name}=${c.value}`).join("; ");
        api.capture(url, "_ga=synthetic; " + incomplete, "synthetic-not-a-cookie-fallback"); await flush();
        assert.equal(api.chrome.storage.session._dump()[key], undefined, `${p.slug}: required cookie group ${missing} cannot be omitted or borrowed from another request`);
      }
    } else {
      for (const value of ["Basic synthetic", "Bearer ", "Bearer synthetic extra"]) {
        api.capture(url, "", "", { requestHeaders: [{ name: "Authorization", value }] }); await flush();
        assert.equal(api.chrome.storage.session._dump()[key], undefined, `${p.slug}: malformed Authorization is not a token`);
      }
    }
    for (const source of p.captureUrls) {
      api.capture(source, cookie, token); await flush();
      const cap = api.chrome.storage.session._dump()[key];
      assert.ok(cap, `${p.slug}: ${source} captures the reviewed format`);
      const expected = token || (p.valueCookie ? sessionCookies(p).find((c) => c.name === p.valueCookie).value : cookie);
      assert.equal(api.sandbox.omniBuildCredential(p, cap), expected, `${p.slug}: named value, full header or Bearer is preserved`);
    }
    captured.push(p.slug);
  }
  assert.deepEqual(captured, Array.from(api.sandbox.OMNI_CAPTURE_WEB, (p) => p.slug));
  assert.deepEqual(api.injected, [], "capture never forwards credentials to the dashboard by itself");
});

test("cookie aliases satisfy their own required group and worker imports preserve the reviewed credential shape", async () => {
  const writes = [];
  const api = boot({ fetch: async (url, options = {}) => {
    assert.equal(url, "/api/providers");
    if (options.method !== "POST") return response(roster);
    const body = JSON.parse(options.body); writes.push(body);
    return response({ connection: { id: "synthetic-cookie-import-" + writes.length } }, 201);
  } });
  let alternativeCases = 0, namedCases = 0;
  for (const p of api.sandbox.OMNI_CAPTURE_WEB.filter((p) => p.cred.t === "cookie")) {
    const complete = sessionCookies(p, "synthetic-" + p.slug);
    const variants = [complete];
    for (const [i, group] of p.cookieGroups.entries()) for (const alias of group.slice(1)) {
      variants.push(complete.map((cookie, index) => index === i ? { ...cookie, name: alias } : cookie));
      alternativeCases++;
    }
    for (const cookies of variants) {
      const header = "_ga=synthetic-analytics; " + cookies.map(({ name, value }) => `${name}=${value}==`).join("; ");
      api.capture(requestUrl(p), header);
      await api.sandbox.queueCapture(p.key, async () => {});
      const cap = api.chrome.storage.session._dump()["cap_" + p.key];
      assert.equal(cap?.cookie, header, `${p.slug}: an OR alias is a complete session when every other required group is present`);
      const before = writes.length;
      const result = await api.sandbox.sendToOmni(p.key, "Synthetic cookie import", true);
      assert.equal(result.ok, true, p.slug);
      assert.equal(writes.length, before + 1, `${p.slug}: one actual serialized import`);
      assert.equal(writes[before].provider, p.slug);
      assert.equal(writes[before].authType, "apikey");
      const expected = p.valueCookie ? cookies.find((cookie) => cookie.name === p.valueCookie).value + "==" : header;
      assert.equal(writes[before].apiKey, expected, `${p.slug}: named imports exclude the cookie name and analytics; header imports retain the full Cookie header`);
      if (p.valueCookie) namedCases++;
    }
  }
  assert.ok(alternativeCases > 0, "the shipped alias recipe must exercise a non-first cookie name");
  assert.ok(namedCases > 0, "exercise value-only imports through the serialized provider POST");
});

test("worker capture rejects cookie chunk gaps and unsupported Auth.js names before importing a contiguous named value", async () => {
  const writes = [];
  const api = boot({ fetch: async (url, options = {}) => {
    assert.equal(url, "/api/providers");
    if (options.method !== "POST") return response(roster);
    writes.push(JSON.parse(options.body));
    return response({ connection: { id: "synthetic-chunk-import" } }, 201);
  } });
  const p = api.sandbox.OMNI_WEB_MAP["perplexity-web"];
  const name = "__Secure-next-auth.session-token", key = "cap_" + p.key;
  assert.equal(p.valueCookie, name);
  const invalid = [
    "__Secure-authjs.session-token=synthetic-unsupported",
    `${name}.1=synthetic-tail`,
    `${name}.0=synthetic-head; ${name}.2=synthetic-tail`,
    `${name}.0=; ${name}.1=synthetic-tail`,
    `prefix-${name}=synthetic-wrong-name`,
  ];
  for (const cookie of invalid) {
    api.capture(requestUrl(p), cookie, "synthetic-bearer-is-not-a-cookie");
    await api.sandbox.queueCapture(p.key, async () => {});
    assert.equal(api.chrome.storage.session._dump()[key], undefined, `incomplete or unsupported cookie must not become ready: ${cookie}`);
  }
  assert.deepEqual(writes, [], "rejected headers cannot initiate an import");
  const header = `${name}.1=tail==; _ga=synthetic; ${name}.0=synthetic-head-`;
  api.capture(requestUrl(p), header);
  await api.sandbox.queueCapture(p.key, async () => {});
  assert.equal(api.chrome.storage.session._dump()[key]?.cookie, header);
  const imported = await api.sandbox.sendToOmni(p.key, "Synthetic chunk account", true);
  assert.equal(imported.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].apiKey, "synthetic-head-tail==", "out-of-order contiguous chunks are joined by index and sent as a value only");
  for (const cookie of invalid) {
    api.capture(requestUrl(p), cookie);
    await api.sandbox.queueCapture(p.key, async () => {});
    assert.equal(api.chrome.storage.session._dump()[key].cookie, header, "later incomplete traffic cannot replace the complete captured session");
  }
});

test("dashboard-only providers reject credential operations before any network request", async () => {
  const requests = [], queries = [];
  const api = boot({
    fetch: async (url) => { requests.push(url); throw new Error("Dashboard-only operation attempted a request"); },
    cookies: async (q) => { queries.push(q); return []; },
  });
  const manual = api.sandbox.OMNI_WEB.filter((p) => p.cred.t === "dashboard");
  assert.ok(manual.some((p) => p.slug === "chatgpt-web"));
  for (const p of manual) {
    api.capture(new URL("/api/synthetic", p.site).href, "sessionKey=synthetic; __client=synthetic; token_v2=synthetic", "synthetic-token");
    await api.sandbox.queueCapture(p.key, async () => {});
    assert.equal(api.chrome.storage.session._dump()["cap_" + p.key], undefined, p.slug + " is not captured");
    // Old persisted captures must not bypass the current capability decision.
    await api.chrome.storage.session.set({ ["cap_" + p.key]: { cookie: "sessionKey=synthetic", token: "synthetic-token", at: Date.now() } });
    assert.equal((await api.sandbox.sendToOmni(p.key)).dashboardOnly, true, p.slug);
    assert.equal((await api.sandbox.loginAgain(p.key)).dashboardOnly, true, p.slug);
    assert.equal((await api.message({ action: "getAll" })).caps[p.key], null, p.slug + " is never shown ready");
  }
  const refreshed = await api.sandbox.refreshSessions(Array.from(manual, (p) => p.key), false);
  for (const p of manual) assert.equal(refreshed.results[p.key].state, "unknown", p.slug + " has no cookie refresh path");
  for (const p of api.sandbox.OMNI_APIKEY) {
    if (p.dashboardOnly) assert.equal((await api.sandbox.sendApiKeyToOmni(p.slug, "Synthetic", "synthetic-key")).dashboardOnly, true, p.slug);
    if (p.dashboardOnly || !p.bulk) assert.equal((await api.sandbox.bulkAddApiKeys(p.slug, ["synthetic-key"], { cx: "synthetic", accountId: "synthetic" })).ok, false, p.slug + " bulk exclusion");
  }
  for (const p of api.sandbox.OMNI_OAUTH) {
    if (p.dashboardOnly) {
      const result = p.kind === "device" ? await api.sandbox.oauthStart(p.slug)
        : p.kind === "redirect" ? await api.sandbox.oauthConnect(p.slug) : await api.sandbox.oauthImport(p.slug, "synthetic-token");
      assert.equal(result.dashboardOnly, true, p.slug);
      await api.chrome.storage.session.set({ ["oauth_" + p.slug]: { provider: p.slug, kind: p.kind, status: "pending", expiresAt: Date.now() + 60000 } });
      assert.equal((await api.sandbox.pollProvider(p.slug)).status, "error", p.slug + " old pending state cannot bypass the gate");
    }
    if (p.dashboardOnly || !p.tokenImport) assert.equal((await api.sandbox.oauthImport(p.slug, "synthetic-token")).dashboardOnly, true, p.slug + " unsupported token route");
    assert.equal((await api.sandbox.oauthAutoImport(p.slug)).dashboardOnly, true, p.slug + " has no generic local import");
  }
  assert.deepEqual(requests, []);
  assert.deepEqual(queries, []);
  assert.deepEqual(api.openedTabs, []);
});

test("every inline key provider preserves its exact ID, optional-key policy and required fields", async () => {
  const writes = [], requests = [];
  const api = boot({ fetch: async (url, options = {}) => {
    requests.push({ url, method: options.method || "GET" });
    assert.equal(url, "/api/providers");
    if (options.method !== "POST") return response(roster);
    const body = JSON.parse(options.body); writes.push(body);
    return response({ connection: { id: "synthetic-created-" + body.provider } }, 201);
  } });
  const inline = api.sandbox.OMNI_APIKEY.filter((p) => !p.dashboardOnly);
  for (const p of inline) {
    const psd = Object.fromEntries((p.extra || []).filter((f) => f.required).map((f) => [f.key, "synthetic-" + f.key]));
    const key = p.keyOptional ? "" : "synthetic-key-" + p.slug;
    const n = writes.length;
    const result = await api.sandbox.sendApiKeyToOmni(p.slug, "Synthetic account", `  ${key}  `, psd);
    assert.equal(result.ok, true, p.slug);
    assert.equal(result.id, "synthetic-created-" + p.slug);
    assert.equal(result.slug, p.slug);
    assert.equal(writes.length, n + 1);
    assert.equal(writes[n].provider, p.slug);
    assert.equal(writes[n].apiKey, key);
    assert.equal(writes[n].authType, "apikey");
    assert.deepEqual(writes[n].providerSpecificData || {}, psd);
    if (!p.keyOptional) {
      const before = requests.length;
      assert.equal((await api.sandbox.sendApiKeyToOmni(p.slug, "Synthetic", "  ", psd)).ok, false, p.slug + " requires a key");
      assert.equal(requests.length, before);
    }
  }
  assert.deepEqual(writes.map((p) => p.provider), Array.from(inline, (p) => p.slug));
  for (const [slug, field] of [["google-pse-search", "cx"], ["cloudflare-ai", "accountId"]]) {
    for (const psd of [undefined, {}, { [field]: "  " }, { [field]: 42 }]) {
      const before = requests.length;
      assert.equal((await api.sandbox.sendApiKeyToOmni(slug, "Synthetic", "synthetic-key", psd)).ok, false, `${slug}: ${field} must be supplied`);
      assert.equal(requests.length, before, "invalid required fields fail before gateway access");
    }
  }
});

test("all inline device routes forward their own verifier and extra data and require a saved connection", async () => {
  const requests = [];
  const api = boot({ fetch: async (url, options = {}) => {
    if (url === "/api/providers") return response(roster);
    requests.push({ url, options });
    const [, slug, action] = url.match(/^\/api\/oauth\/([^/]+)\/(device-code|poll)$/) || [];
    assert.ok(slug, "only the provider's registered device routes may be called");
    if (action === "device-code") return response({
      device_code: "synthetic-code-" + slug, user_code: "TEST-ONLY", codeVerifier: "synthetic-verifier-" + slug,
      verification_uri: "https://synthetic.example.test/device", expires_in: 600, interval: 5,
      _clientId: "synthetic-client", _clientSecret: "synthetic-secret", _region: "synthetic-region", _authMethod: "synthetic-method",
    });
    return response({ success: true, connection: { id: "synthetic-saved-" + slug, provider: slug } });
  } });
  const providers = api.sandbox.OMNI_OAUTH.filter((p) => p.deviceFlow && !p.dashboardOnly);
  for (const p of providers) {
    const n = requests.length;
    assert.equal((await api.sandbox.oauthStart(p.slug)).ok, true, p.slug);
    const state = await api.sandbox.pollProvider(p.slug);
    assert.equal(state.status, "success", p.slug);
    assert.equal(state.connId, "synthetic-saved-" + p.slug);
    assert.deepEqual(requests.slice(n).map((r) => r.url), [`/api/oauth/${p.slug}/device-code`, `/api/oauth/${p.slug}/poll`]);
    const poll = requests[n + 1].options;
    assert.equal(poll.method, "POST");
    assert.equal(poll.credentials, "include");
    assert.deepEqual(JSON.parse(poll.body), { deviceCode: "synthetic-code-" + p.slug, codeVerifier: "synthetic-verifier-" + p.slug,
      extraData: { _clientId: "synthetic-client", _clientSecret: "synthetic-secret", _region: "synthetic-region", _authMethod: "synthetic-method" } });
    await api.sandbox.oauthCancel(p.slug);
  }
  assert.equal(api.openedTabs.length, providers.length, "authorization tabs are synthetic recorded actions only");
});

test("redirect completion uses POST poll-callback, ignores roster growth and accepts a same-account update", async () => {
  let now = Date.now(), reply, connections = [];
  const callbacks = [], starts = [];
  const api = boot({ clock: { Date: class extends Date { static now() { return now; } } }, fetch: async (url, options = {}) => {
    if (url === "/api/providers") return response({ connections });
    if (url.endsWith("/start-callback-server")) { starts.push(url); return response({ authUrl: "https://synthetic.example.test/authorize" }); }
    assert.ok(url.endsWith("/poll-callback"), "no generic authorize or roster-count completion fallback");
    callbacks.push({ url, options });
    return response(reply);
  } });
  const providers = api.sandbox.OMNI_OAUTH.filter((p) => p.kind === "redirect" && !p.dashboardOnly);
  for (const p of providers) {
    const id = "synthetic-existing-" + p.slug;
    connections = [{ id, provider: p.slug, name: "Synthetic existing account" }];
    reply = { success: false, pending: true };
    assert.equal((await api.sandbox.oauthConnect(p.slug)).ok, true, p.slug);
    assert.equal((await api.sandbox.pollProvider(p.slug)).status, "pending");
    connections.push({ id: "synthetic-unrelated-" + p.slug, provider: p.slug, name: "Synthetic independent addition" });
    now += 5000;
    assert.equal((await api.sandbox.pollProvider(p.slug)).status, "pending", "an independently added connection is not callback completion");
    now += 5000;
    reply = { success: true, connection: { id, provider: p.slug, accessToken: "synthetic-must-not-leak" } };
    const result = await api.sandbox.pollProvider(p.slug);
    assert.equal(result.status, "success");
    assert.equal(result.connId, id, "same connection ID can be updated without increasing the roster count");
    assert.equal(JSON.stringify(result).includes("synthetic-must-not-leak"), false);
    await api.sandbox.oauthCancel(p.slug);
  }
  assert.equal(starts.length, providers.length);
  assert.equal(callbacks.length, providers.length * 3);
  for (const { options } of callbacks) {
    assert.equal(options.method, "POST");
    assert.equal(options.credentials, "include");
    assert.deepEqual(JSON.parse(options.body), {});
  }
  assert.ok(api.injected.includes("oauthCallbackPollInPage"), "the real helper runs serialized in MAIN world");
});

test("callback errors and missing, wrong or foreign connection IDs never finish successfully or retry exchange", async () => {
  const cases = [
    [{}, 200], [{ pending: true }, 200], [{ success: true }, 200],
    [{ success: true, connection: { id: "" } }, 200], [{ success: true, connection: { id: "  " } }, 200],
    [{ success: true, connection: { id: 42 } }, 200], [{ success: "true", connection: { id: "synthetic-id" } }, 200],
    [{ success: true, connection: { id: "synthetic-id", provider: "unrelated-provider" } }, 200],
    [{ success: true, connection: { id: "synthetic-id" }, error: "Synthetic exchange failed" }, 200],
    [{ success: true, connection: { id: "synthetic-id" } }, 401], ["not-json", 200],
  ];
  for (const [reply, status] of cases) {
    const posts = [];
    const api = boot({ fetch: async (url, options = {}) => {
      if (url === "/api/providers") return response(roster);
      posts.push({ url, options }); return response(reply, status);
    } });
    await api.chrome.storage.session.set({ oauth_codex: { provider: "codex", kind: "redirect", status: "pending", expiresAt: Date.now() + 60000, interval: 3 } });
    const state = await api.sandbox.pollProvider("codex");
    assert.equal(state.status, "error", JSON.stringify(reply));
    assert.equal(state.connId, undefined);
    assert.ok(state.detail);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "/api/oauth/codex/poll-callback");
    assert.equal(posts[0].options.method, "POST");
    await api.sandbox.pollProvider("codex");
    assert.equal(posts.length, 1, "an unconfirmed exchange must not be silently replayed");
  }
});

test("callback body timeout aborts once and leaves no successful or replayed exchange", async () => {
  const clock = timers();
  let signal, release, requests = 0;
  const api = boot({ clock, fetch: async (_url, options) => {
    requests++; signal = options.signal;
    return { ...response({}), json: () => new Promise((resolve) => { release = resolve; }) };
  } });
  const pending = api.inPage("oauthCallbackPollInPage", ["codex", "Synthetic unconfirmed exchange"]);
  await tick();
  assert.ok(signal && release);
  clock.fire();
  const result = await pending;
  assert.equal(result.error, "Synthetic unconfirmed exchange");
  assert.equal(result.success, undefined);
  assert.equal(signal.aborted, true);
  assert.equal(requests, 1);
  assert.equal(clock.pending.size, 0);
  release({ success: true, connection: { id: "synthetic-too-late" } });
  await tick();
  assert.equal(result.success, undefined);
  assert.equal(requests, 1);
});

test("only source-enabled token imports reach import-token; generic credential blobs never reach a write endpoint", async () => {
  const posts = [];
  const api = boot({ fetch: async (url, options = {}) => {
    if (url === "/api/providers") return response(roster);
    posts.push({ url, options });
    return response({ connection: { id: "synthetic-imported", accessToken: "synthetic-do-not-return" } });
  } });
  const supported = api.sandbox.OMNI_OAUTH.filter((p) => p.tokenImport && !p.dashboardOnly);
  assert.ok(supported.some((p) => p.slug === "devin-cli"));
  assert.ok(supported.some((p) => p.slug === "devin-desktop"));
  for (const p of supported) {
    const n = posts.length;
    const result = await api.sandbox.oauthImport(p.slug, "  synthetic-token-import  ");
    assert.equal(result.ok, true, p.slug);
    assert.equal(result.id, "synthetic-imported");
    assert.equal(JSON.stringify(result).includes("synthetic-do-not-return"), false);
    assert.equal(posts.length, n + 1);
    assert.equal(posts[n].url, `/api/oauth/${p.slug}/import-token`);
    assert.equal(posts[n].options.method, "POST");
    assert.deepEqual(JSON.parse(posts[n].options.body), { token: "synthetic-token-import", connectionId: null });
    const blob = await api.sandbox.oauthImport(p.slug, "omniroute-cred-v1.synthetic-only");
    assert.equal(blob.ok, false);
    assert.equal(blob.dashboardOnly, true);
    assert.equal(posts.length, n + 1, "unsupported blobs must not be forwarded or imported as tokens");
  }
});

test("specialized providers return unknown without model-list or chat requests", async () => {
  const requests = [];
  const api = boot({ fetch: async (url) => { requests.push(url); throw new Error("Unexpected request for specialized probe"); } });
  const specialized = api.sandbox.OMNI_CATALOG.filter((p) => p.probeKind === "dashboard");
  assert.ok(specialized.some((p) => p.slug === "google-pse-search"));
  for (const p of specialized) {
    assert.equal((await api.sandbox.runProbe(p.slug)).alive, null, p.slug);
    assert.equal((await api.sandbox.probeModel([{ id: p.slug + "/synthetic-nonchat" }], p.slug)).alive, null, p.slug);
  }
  const ids = Array.from(specialized.slice(0, 2), (p) => p.slug);
  const result = await api.sandbox.probeAll(ids, false);
  for (const id of ids) {
    assert.equal(result.results[id].alive, null);
    assert.equal(api.chrome.storage.local._dump()["probe_" + id].alive, null);
  }
  assert.deepEqual(requests, [], "specialized capability gating happens before any synthetic fetch");
  assert.deepEqual(api.injected, []);
});

for (const direct of [false, true]) {
  const pathLabel = direct ? "Chrome direct" : "serialized MAIN-world";
  test(`model capability metadata survives the models message and mixed-service probes prefer explicit chat (${pathLabel})`, async () => {
    const models = [
      { id: "openai/synthetic-embedding", owned_by: "openai", type: "embedding", supported_endpoints: ["embeddings"], api_format: "openai", supported_in_api: true },
      { id: "openai/synthetic-responses-only", owned_by: "openai", type: "chat", supported_endpoints: ["responses"], api_format: "openai-responses", supported_in_api: true },
      { id: "openai/synthetic-disabled-chat", owned_by: "openai", type: "chat", supported_endpoints: ["chat"], supported_in_api: false },
      { id: "openai/synthetic-legacy", owned_by: "openai" },
      { id: "openrouter/synthetic-foreign-chat", owned_by: "openrouter", type: "chat", supported_endpoints: ["chat"] },
      { id: "openai/synthetic-chat", owned_by: "openai", type: "chat", supported_endpoints: ["chat", "responses"], api_format: "openai", supported_in_api: true },
    ];
    const reads = [], completions = [];
    const api = boot({ direct, fetch: async (url, options = {}) => {
      if (url.endsWith("/v1/models")) {
        reads.push(url);
        assert.equal(options.method || "GET", "GET");
        return response({ data: models.map((model) => ({ ...model, fixtureOnly: "synthetic-unneeded-field" })) });
      }
      assert.equal(url, (direct ? "http://127.0.0.1:20128" : "") + "/v1/chat/completions");
      assert.equal(options.method, "POST");
      completions.push(JSON.parse(options.body));
      return response({ choices: [{ message: { content: "Synthetic chat answer" } }] });
    } });
    const listed = await api.message({ action: "models" });
    assert.equal(listed.ok, true);
    assert.deepEqual(structuredClone(listed.models), models, "the popup receives capability fields, not just model IDs, and no unrelated server fields");
    const probe = await api.sandbox.runProbe("openai");
    assert.equal(probe.alive, true);
    assert.equal(probe.model, "openai/synthetic-chat", "embedding/Responses-only/disabled/foreign rows are excluded and explicit chat wins over a preceding legacy row");
    assert.deepEqual(completions.map((body) => body.model), ["openai/synthetic-chat"]);
    assert.deepEqual(reads, [(direct ? "http://127.0.0.1:20128" : "") + "/v1/models"], "cached models retain the capability metadata used by the probe");
    if (direct) assert.deepEqual(api.injected, []);
    else assert.deepEqual(api.injected, ["fetchModelsInPage", "chatProbeInPage"]);
  });

  test(`explicit non-chat or unavailable models return unknown without a completion (${pathLabel})`, async () => {
    const models = [
      { id: "openai/synthetic-responses-only", type: "chat", supported_endpoints: ["responses"] },
      { id: "openai/synthetic-embedding", type: "embedding" },
      { id: "openai/synthetic-audio", type: "audio" },
      { id: "openai/synthetic-image", type: "image" },
      { id: "openai/synthetic-disabled-chat", type: "chat", supported_endpoints: ["chat"], supported_in_api: false },
      { id: "openai/synthetic-no-endpoints", type: "chat", supported_endpoints: [] },
      { id: "openai/synthetic-malformed-endpoints", supported_endpoints: "chat" },
      { id: "openrouter/synthetic-other-provider", type: "chat", supported_endpoints: ["chat"] },
    ];
    const requests = [];
    const api = boot({ direct, fetch: async (url, options = {}) => {
      requests.push({ url, method: options.method || "GET" });
      assert.equal(url, (direct ? "http://127.0.0.1:20128" : "") + "/v1/models", "a non-chat model must never trigger a completion request");
      return response({ data: models });
    } });
    const probe = await api.sandbox.realProbe("openai");
    assert.equal(probe.alive, null, "missing chat capability is unknown, not a failed credential");
    assert.equal(probe.model, undefined);
    assert.equal(api.chrome.storage.local._dump().probe_openai.alive, null);
    assert.deepEqual(requests, [{ url: (direct ? "http://127.0.0.1:20128" : "") + "/v1/models", method: "GET" }]);
  });

  test(`legacy model rows without capability fields still support a chat probe (${pathLabel})`, async () => {
    const posts = [];
    const api = boot({ direct, fetch: async (url, options = {}) => {
      if (url.endsWith("/v1/models")) return response({ data: [{ id: "openai/synthetic-legacy" }] });
      assert.equal(url, (direct ? "http://127.0.0.1:20128" : "") + "/v1/chat/completions");
      assert.equal(options.method, "POST");
      posts.push(JSON.parse(options.body).model);
      return response({ choices: [{ message: { content: "Synthetic legacy answer" } }] });
    } });
    const probe = await api.sandbox.runProbe("openai");
    assert.equal(probe.alive, true);
    assert.equal(probe.model, "openai/synthetic-legacy");
    assert.deepEqual(posts, ["openai/synthetic-legacy"], "legacy fallback is retained without trying multiple completions");
  });
}
