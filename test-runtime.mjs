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
  if (cookies) chrome.cookies = { getAll: cookies, onChanged: { addListener: () => {} } };
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
  return { chrome, sandbox, message, inPage, injected, capture };
}

test("popup discovery covers every configured cookie provider, keeps secrets in the worker and coalesces reads", async () => {
  const queries = [];
  let api;
  api = boot({ cookies: async (q) => {
    queries.push(q);
    const p = api.sandbox.OMNI_WEB.find((p) => [p.site, p.loginUrl].includes(q.url));
    const name = p && api.sandbox.sessionNames(p)[0];
    return name ? [{ name, value: "synthetic-session", domain: p.host, path: "/", storeId: "0", httpOnly: true }] : [];
  } });
  const results = await Promise.all(Array.from({ length: 5 }, () => api.message({ action: "getAll", discover: true })));
  const eligible = api.sandbox.OMNI_WEB.filter((p) => p.cred.t === "cookie" && api.sandbox.sessionNames(p).length);
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
  api.capture(eligible[0].site + "/api/synthetic", api.sandbox.sessionNames(eligible[0])[0] + "=synthetic-new-session");
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
  const providers = api.sandbox.OMNI_WEB.filter((p) => p.cred.t === "token");
  assert.ok(providers.length);
  for (const p of providers) {
    api.capture(p.site + "/api/synthetic", "", "synthetic-bearer", { cookieStoreId: "firefox-container-1" });
    await tick();
    const first = api.chrome.storage.session._dump()["cap_" + p.key];
    assert.equal(first?.token, "synthetic-bearer", p.key + " does not require cookies");
    api.capture(p.site + "/api/static", "_ga=synthetic-a", "", { cookieStoreId: "firefox-container-1" });
    await tick();
    assert.equal(api.chrome.storage.session._dump()["cap_" + p.key].token, "synthetic-bearer");
    api.capture(p.site + "/api/foreign", "_ga=synthetic-b", "", { cookieStoreId: "firefox-container-2" });
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
    ...api.sandbox.OMNI_APIKEY.map((p) => ["bulkApiKeyInPage", p.slug]),
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
  const r = await api.sandbox.bulkAddApiKeys("google-pse-search", ["short", "synthetic-long-key"], { cx: "synthetic-cx" });
  assert.equal(r.added, 2, "upstream accepts any nonempty key; a short line must not vanish");
  assert.equal(bodies[0].entries.length, 2);
  assert.equal(bodies[0].providerSpecificData.cx, "synthetic-cx");
  assert.equal(bodies[0].entries[0].accountId, undefined, "hashing an API key does not produce a Cloudflare account id");
});

test("200 with missing create/import connection id cannot trigger a success probe", async () => {
  const api = boot({ fetch: async () => response({}) });
  for (const [name, args] of [
    ["postProviderInPage", ["openai", "Synthetic", "synthetic-key", "apikey", null, "Synthetic login"]],
    ["oauthImportTokenInPage", ["cursor", "synthetic-token", "Synthetic login"]],
    ["oauthPasteCredsInPage", ["cursor", "omniroute-cred-v1.synthetic", "Synthetic login"]],
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
  const p = await popup({ bulkAddApiKey: { ...batch(1), batch: true, added: 1, ok: false, partial: true, slug: "google-pse-search" } });
  // This provider's schema is supported by the adapter but missing from the old generated catalog.
  // Supply only its metadata here; the form, message path and re-render remain the shipped code.
  vm.runInContext('OMNI_APIKEY.push({ slug: "google-pse-search", label: "Synthetic Search", family: "Synthetic", extra: [{ key: "cx", label: "Search Engine ID", required: true }] });', p.sandbox);
  vm.runInContext('keyExpanded = "google-pse-search"; $("keySearch").value = "google-pse-search"; renderKeyList();', p.sandbox);
  const form = p.document.querySelector(".keyform");
  const area = form.querySelector("textarea");
  area.classList.remove("hide");
  area.value = "synthetic-key-a\nsynthetic-key-b";
  const extra = [...form.querySelectorAll("input")].find((input) => (input.placeholder || "").includes("Search Engine ID"));
  assert.ok(extra);
  const add = form.querySelector(".actions button");
  await add.onclick();
  assert.equal(p.calls.filter((c) => c.action === "bulkAddApiKey").length, 0, "required fields also apply to bulk mode");
  extra.value = "synthetic-cx";
  await add.onclick();
  const sent = p.calls.find((c) => c.action === "bulkAddApiKey");
  assert.equal(sent.psd.cx, "synthetic-cx");
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
    for (const p of api.sandbox.OMNI_OAUTH.filter((p) => p.deviceFlow)) {
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
