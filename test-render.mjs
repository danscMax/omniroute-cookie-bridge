// Headless render smoke: run the REAL popup.html + providers + popup.js under linkedom (no browser),
// asserting the popup boots and renders every pane WITHOUT a JS error. Catches what `node --check`
// can't — a runtime DOM/logic error on load. Run: `npm run test:render` (needs devDep `linkedom`).
// This is the fallback when the Playwright/pw-firefox MCP is unavailable; it is NOT a pixel check.
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import vm from "node:vm";
import { area, i18nStub } from "./test-harness.mjs"; // shared in-memory chrome.storage + i18n — one impl for both suites

const EXT = dirname(fileURLToPath(import.meta.url));
const { document, Event } = parseHTML(readFileSync(join(EXT, "popup.html"), "utf8"));

// linkedom has a getter-only select.value. Supply the missing DOM setter for the real UI handlers;
// provider matching, form validation and action selection below remain the shipped implementation.
for (const select of document.querySelectorAll("select")) Object.defineProperty(select, "value", {
  configurable: true,
  get() { return this.querySelector("option[selected]")?.value ?? this.querySelector("option")?.value ?? ""; },
  set(value) { for (const option of this.querySelectorAll("option")) option.toggleAttribute("selected", option.value === String(value)); },
});

const NOW = 1800000000000;
const CANNED = {
  getAll: { caps: { "claude-web": { provider: "claude-web", slug: "claude-web", label: "Claude Web", cookieCount: 12, at: NOW - 5 * 60000, accountId: "acc1" } } },
  connections: { byProvider: { "claude-web": { total: 1, good: 0, bad: 1, names: ["Claude Web · acc1"] }, "gemini": { total: 2, good: 2, bad: 0, names: [] } }, total: 3, problems: [{ provider: "claude-web", id: "dead1", name: "Claude Web · acc1", isActive: true }], all: [{ provider: "claude-web", id: "dead1", name: "Claude Web · acc1", testStatus: "error", hasError: true, isActive: true }, { provider: "gemini", id: "g1", name: "Gemini · acc1", testStatus: "active", hasError: false, isActive: true }, { provider: "gemini", id: "g2", name: "Gemini · acc2", testStatus: "active", hasError: false, isActive: false }], unreachable: false },
  getProbes: { probes: {} }, oauthState: { states: {} },
  getSettings: { settings: { sweep: true, sweepMin: 15, notify: true, theme: "auto" } },
  addApiKey: (req) => ({ ok: true, slug: req.slug, id: "synthetic-added-" + req.slug }),
  probe: { alive: null, detail: "Synthetic response: no live provider verification" },
  models: { ok: true, models: [{ id: "gemini/synthetic-chat", type: "chat", supported_endpoints: ["chat"] }] },
};
for (const [provider, id] of [["chatgpt-web", "native-chatgpt"], ["synthetic-unlisted", "unknown-provider"], ["qwen-web", "retired-provider"]]) {
  const name = "Synthetic " + provider;
  CANNED.connections.byProvider[provider] = { total: 1, good: 1, bad: 0, names: [name] };
  CANNED.connections.all.push({ provider, id, name, testStatus: "active", hasError: false, isActive: true });
  CANNED.connections.total++;
}
const errors = [];
const calls = [], openedTabs = [];
const scheduled = new Map();
let timerSerial = 0;
const chrome = {
  i18n: i18nStub(), // real ru strings — the assertions below read the labels the popup actually paints
  storage: { local: area(), session: area() },
  runtime: {
    sendMessage: (msg, cb) => {
      calls.push(structuredClone(msg));
      const reply = CANNED[msg.action] || { ok: true };
      const result = Promise.resolve(typeof reply === "function" ? reply(msg) : reply);
      // Deferred fixtures deliver their resolved data through the real callback-based UI path.
      if (cb) result.then(cb);
      return result;
    },
    onMessage: { addListener: () => {} }, getURL: (x) => x, getManifest: () => ({ version: "dev" }),
  },
  tabs: { query: () => Promise.resolve([]), create: async (options) => { openedTabs.push(structuredClone(options)); return { id: openedTabs.length }; }, onUpdated: { addListener: () => {}, removeListener: () => {} } },
  action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
  alarms: { create: () => {}, clear: () => {}, get: (n, cb) => cb(null), onAlarm: { addListener: () => {} } },
  notifications: { create: () => {} }, windows: { create: () => {} },
  permissions: { contains: () => Promise.resolve(true), request: () => Promise.resolve(true) }, // granted → banner hidden (Chrome-like)
};
const sandbox = {
  document, chrome, console, navigator: { userAgent: "Synthetic DOM browser", clipboard: { writeText: () => Promise.resolve() } }, location: { search: "" },
  setTimeout: (f, ms = 0) => {
    const id = ++timerSerial;
    scheduled.set(id, f);
    // Flush focus/debounce work at a microtask boundary. Long refresh/confirmation timers stay idle.
    if (ms <= 200) queueMicrotask(() => {
      if (!scheduled.delete(id)) return;
      try { Promise.resolve(f()).catch((e) => errors.push("timer:" + e.message)); }
      catch (e) { errors.push("timer:" + e.message); }
    });
    return id;
  },
  clearTimeout: (id) => scheduled.delete(id), setInterval: () => 0, clearInterval: () => {},
  URLSearchParams, URL, Blob: class {}, Promise, JSON, Math, Date,
  atob: (s) => Buffer.from(s, "base64").toString("binary"), Object, Array, String, Number, RegExp, Set, Map, Boolean, parseInt,
  // All network-facing behavior is supplied through the synthetic worker messages, never a socket.
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  fetch: () => { throw new Error("Unexpected fetch in offline popup render"); },
};
sandbox.self = sandbox; sandbox.window = sandbox; sandbox.globalThis = sandbox;
sandbox.URL.createObjectURL = () => "blob:x"; sandbox.URL.revokeObjectURL = () => {};
vm.createContext(sandbox);
for (const f of ["providers.gen.js", "providers.js", "popup.js"]) {
  try { vm.runInContext(readFileSync(join(EXT, f), "utf8"), sandbox, { filename: f }); }
  catch (e) { errors.push(f + ": " + e.message); }
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
await settle();
const gen = sandbox.OMNI_GEN;
const t = (key, subs) => chrome.i18n.getMessage(key, subs);
const ids = (rows) => Array.from(rows, (p) => p.slug);
const directoryIds = () => [...document.querySelectorAll("#catalogList .directory-entry")].map((e) => e.dataset.slug);

assert.deepEqual(errors, [], `render JS errors: ${JSON.stringify(errors)}`);
const oauthCards = document.querySelectorAll("#oauthList .card").length;
const webChips = document.querySelectorAll("#webChips button").length;
assert.equal(oauthCards, gen.oauth.length, "every registered OAuth route renders exactly one card");
assert.deepEqual([...document.querySelectorAll("#oauthList .card")].map((e) => e.dataset.slug).sort(), ids(gen.oauth));
assert.equal(webChips, gen.web.length, "web chips include supported and dashboard-only providers");
assert.deepEqual([...document.querySelectorAll("#webGuide .directory-entry")].map((e) => e.dataset.slug).sort(), ids(gen.web));
for (const id of ["settingsBtn", "exportBtn", "clearProbesBtn", "setTheme", "webProblems"]) assert.ok(document.querySelector("#" + id), `#${id} present`);

// The i18n pass must FILL the static markup, not blank it. `t()` returning undefined (a bad key lookup)
// silently empties every label — the exact failure the key-fallback exists to prevent, and one no
// assertion above would notice because they only count elements.
const i18nEls = [...document.querySelectorAll("[data-i18n]")];
assert.ok(i18nEls.length >= 20, `static markup carries i18n keys (${i18nEls.length})`);
const blank = i18nEls.filter((e) => !String(e.textContent || "").trim()).map((e) => e.getAttribute("data-i18n"));
assert.deepEqual(blank, [], `every [data-i18n] element rendered text: ${blank.join(", ")}`);
assert.equal(document.querySelector("#exportBtn").textContent, "⬇ Скачать список соединений (бэкап)", "static label reads the shipped ru string");
assert.equal(document.querySelector("#settingsBtn").title, "Настройки", "[data-i18n-title] fills the attribute");
assert.equal(document.querySelector("#webSearch").placeholder, "Поиск веб-провайдера…", "[data-i18n-placeholder] fills the attribute");
assert.equal(document.querySelector("#webSearch").getAttribute("aria-label"), "Поиск веб-провайдера", "[data-i18n-label] fills aria-label");

// Attention band populated from the fixture's broken connection (dead1) — the honest-signal path.
assert.ok(document.querySelector("#webProblems .prob"), "attention band lists the broken connection");

// Full connections manager: collapsed head shows the count; expanding lists EVERY connection with
// rename/enable-disable/delete (parity with the dashboard's manage capabilities).
const manageHead = document.querySelector("#manageSection .manage-head");
assert.ok(manageHead, "manager head rendered");
assert.equal(document.querySelectorAll("#manageSection .prob").length, 0, "manager collapsed by default (no rows)");
manageHead.onclick(); // expand
const rows = document.querySelectorAll("#manageSection .prob");
assert.equal(rows.length, CANNED.connections.total, "manager lists every synthetic connection, including dashboard-only and unknown providers");
assert.equal(document.querySelectorAll("#manageSection button.danger").length, CANNED.connections.total, "explicit delete offered on every managed connection");
assert.equal(document.querySelectorAll("#manageSection .prob.okrow").length, CANNED.connections.total - 1, "healthy connections get neutral rows");
const toggleLabels = [...document.querySelectorAll("#manageSection .prob button")].map((b) => b.textContent);
assert.ok(toggleLabels.includes("Включить"), "disabled connection offers 'Включить'");
assert.ok(toggleLabels.includes("Выключить"), "active connection offers 'Выключить'");
// Settings panel: the sweep opt-out offers one chip per provider the background sweep would probe
// (i.e. per provider with connections, including native/unknown entries in the fixture).
document.querySelector("#settingsBtn").click();
await settle();
const skipChips = [...document.querySelectorAll("#sweepSkipChips .chip")].map((c) => c.textContent);
assert.equal(skipChips.length, Object.keys(CANNED.connections.byProvider).length, `a sweep opt-out chip per connected provider (got ${JSON.stringify(skipChips)})`);
assert.ok(document.querySelector("#setPersist"), "#setPersist toggle present");
assert.equal(document.querySelector("#setPersist").checked, true, "persistence defaults ON when the saved setting is absent");
assert.ok(document.querySelector("#lastRecovery"), "#lastRecovery line present");
// Firefox host-permission prompt: the grant button exists, and with permission granted (stub) the banner is hidden.
assert.ok(document.querySelector("#grantBtn"), "#grantBtn present");
assert.ok(document.querySelector("#permBanner").classList.contains("hide"), "permission banner hidden when access is granted");

// Exercise actual navigation; a populated off-screen pane alone does not establish usable navigation.
for (const pane of ["dash", "wizard", "web", "key", "oauth", "table", "chat", "catalog", "set"]) {
  const tab = document.querySelector(`[data-pane="${pane}"]`);
  tab.click(); await settle();
  assert.equal(tab.getAttribute("aria-selected"), "true", pane);
  assert.ok(tab.getAttribute("aria-label"), `${pane}: accessible name`);
  assert.deepEqual([...document.querySelectorAll(".pane:not(.hide)")].map((p) => p.id), ["pane-" + pane]);
}
document.querySelector('[data-pane="catalog"]').click();
await settle();
assert.equal(gen.all.length, 394, "pinned catalog has 394 unique entries");
assert.deepEqual(directoryIds(), ids(gen.all), "the full directory has exact all-provider set parity");
assert.equal(document.querySelector("#catalogCount").textContent, "394/394");
assert.deepEqual([...document.querySelectorAll("#catalogCategory option")].map((o) => o.value).filter(Boolean).sort(), [...new Set(gen.all.map((p) => p.category))].sort());

function expand(slug) {
  const entry = document.querySelector(`#catalogList [data-slug="${slug}"]`);
  assert.ok(entry, `directory contains ${slug}`);
  entry.open = true;
  entry.ontoggle(); // linkedom has no native details toggle default action.
  assert.ok(entry.querySelector(".directory-body"), `${slug}: expansion renders the body`);
  return entry;
}
const buttons = (parent) => [...parent.querySelectorAll("button")];
const dashboardUrl = (p) => "http://127.0.0.1:20128/dashboard/providers" +
  (p.category === "cloud-agent" ? "?section=cloudagent" : ["system", "other"].includes(p.category) ? "" : "/" + p.slug);
async function openedBy(button, url, label) {
  assert.ok(button, label);
  const n = openedTabs.length;
  await button.onclick();
  assert.equal(openedTabs.length, n + 1, `${label}: exactly one navigation`);
  assert.equal(openedTabs[n].url, url, label);
}

// Check visible source metadata and every setup handoff, not just the number of collapsed rows.
for (const p of sandbox.OMNI_CATALOG) {
  const entry = expand(p.slug), body = entry.querySelector(".directory-body"), guidance = body.querySelector(".provider-guidance");
  assert.ok(entry.querySelector("summary").textContent.startsWith(p.label), `${p.slug}: display name`);
  const notes = [...guidance.querySelectorAll("p")].map((node) => node.textContent);
  const upstream = [...new Set([p.authHint, p.apiHint, p.notice, p.freeNote].filter(Boolean))];
  for (const note of upstream) assert.ok(notes.includes(note), `${p.slug}: source note rendered verbatim`);
  if (!upstream.length) assert.ok(notes.includes(t("catalog_noGuidance")), `${p.slug}: honest missing-guidance fallback`);
  if (p.localDefault) assert.ok(notes.includes(t("catalog_endpoint", [p.localDefault])));
  if (p.serviceKinds.length) assert.ok(notes.includes(t("catalog_services", [p.serviceKinds.join(", ")])));
  const source = guidance.querySelector(".source-link");
  assert.equal(source.getAttribute("href"), `https://github.com/diegosouzapw/OmniRoute/blob/${gen.provenance.ref}/${p.source.file.split("/").map(encodeURIComponent).join("/")}#L${p.source.line}`);
  assert.equal(source.getAttribute("target"), "_blank");
  assert.match(source.getAttribute("rel"), /noopener/);
  const guideButtons = buttons(guidance), expectedLinks = [];
  if (p.deepLink && p.get) expectedLinks.push(p.get);
  if (p.signupUrl) expectedLinks.push(p.signupUrl);
  if (p.website) expectedLinks.push(p.website);
  assert.equal(guideButtons.length, expectedLinks.length, `${p.slug}: all source links have actions`);
  for (const [i, url] of expectedLinks.entries()) await openedBy(guideButtons[i], url, `${p.slug}: source navigation`);
  const setup = buttons(body.lastElementChild), expectedActions = [];
  const web = sandbox.OMNI_WEB_MAP[p.slug], key = sandbox.OMNI_APIKEY_MAP[p.slug], oauth = sandbox.OMNI_OAUTH_MAP[p.slug];
  if (web && web.cred.t !== "dashboard") expectedActions.push(t(web.cred.t === "token" ? "catalog_bearer" : "catalog_cookie"));
  if (key && !key.dashboardOnly) expectedActions.push(t("catalog_keyForm"));
  if (oauth && !oauth.dashboardOnly) expectedActions.push(t("oauth_connect"));
  expectedActions.push(t("oauth_inDashboard"));
  assert.deepEqual(setup.map((b) => b.textContent), expectedActions, `${p.slug}: actions respect each independent capability`);
  await openedBy(setup.at(-1), dashboardUrl(p), `${p.slug}: dashboard handoff`);
  entry.open = false; entry.ontoggle();
}

// An open source note must survive the regular roster refresh without duplicate bodies.
expand("pioneer");
await sandbox.loadConnections();
const retained = document.querySelector('#catalogList [data-slug="pioneer"]');
assert.equal(retained.open, true, "open directory details survive a roster render");
assert.equal(retained.querySelectorAll(".directory-body").length, 1);
assert.ok(retained.textContent.includes(sandbox.OMNI_CATALOG_MAP.pioneer.notice));

async function search(query) {
  const input = document.querySelector("#globalSearch");
  input.value = query; input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  for (const id of ["webSearch", "keySearch", "oauthSearch"]) assert.equal(document.querySelector("#" + id).value, query);
}
for (const [query, slug] of [["Pioneer AI by Fastino Labs", "pioneer"], ["Free 10K Neurons/day", "cloudflare-ai"], ["adp-web", "adapta-web"]]) {
  await search(query);
  assert.deepEqual(directoryIds(), [slug], `${query}: source notice/free-note/alias is searchable`);
}
await search("Playwright-compatible storage-state JSON");
assert.ok(directoryIds().includes("chatgpt-web"), "native browser import instructions remain searchable");
await search("");
const category = document.querySelector("#catalogCategory");
category.value = "local"; category.dispatchEvent(new Event("change"));
assert.deepEqual(directoryIds(), ids(gen.all.filter((p) => p.category === "local")), "category filter preserves every local provider");
assert.equal(document.querySelector("#catalogCount").textContent, "15/394");
category.value = ""; category.dispatchEvent(new Event("change"));
await search("synthetic-no-such-provider-12345");
assert.deepEqual(directoryIds(), []);
assert.equal(document.querySelector("#catalogCount").textContent, "0/394");
assert.equal(document.querySelector("#catalogList .empty").textContent, t("popup_nothingFound"));
await search("");

// A known retired provider is a positive control. Native ChatGPT and an unknown ID are not retired.
assert.deepEqual(Array.from(sandbox.cleanupInfo().retired, (c) => c.provider), ["qwen-web"]);
assert.equal(vm.runInContext('kindOf("chatgpt-web")', sandbox), "web");
assert.equal(vm.runInContext('kindOf("synthetic-unlisted")', sandbox), "other");
assert.ok(!document.querySelector("#dashCleanup").textContent.includes("chatgpt-web"));
const chatgptRow = sandbox.providerRows().find((p) => p.slug === "chatgpt-web");
assert.ok(chatgptRow && chatgptRow.status !== "retired");
const nativeActions = document.createElement("div");
sandbox.nextActionBtns(chatgptRow, nativeActions);
assert.ok(buttons(nativeActions).some((b) => b.textContent === t("oauth_inDashboard")));
assert.ok(!buttons(nativeActions).some((b) => b.textContent === t("det_refresh")), "native ChatGPT has no cookie refresh action");
assert.ok(!buttons(sandbox.provRow(chatgptRow)).some((b) => b.title === t("row_refresh")), "native web row has no refresh icon");
const refreshStart = calls.length;
await sandbox.runRefresh(["chatgpt-web"]);
assert.ok(!calls.slice(refreshStart).some((c) => c.action === "refreshSessions"), "manual-only refresh selection does not call the worker");
assert.ok(document.querySelector("#probeAllRes").classList.contains("mut"), "unsupported refresh is unknown, not a broken login");

// Dual-auth providers keep the usable key action when OAuth is dashboard-only, and both when inline.
for (const [slug, oauthExpected] of [["cline", false], ["codebuddy-cn", true]]) {
  const box = document.createElement("div");
  sandbox.nextActionBtns({ slug, kind: "oauth" }, box);
  const labels = buttons(box).map((b) => b.textContent);
  assert.ok(labels.includes(t("det_newKey")), `${slug}: key recovery is not masked by OAuth classification`);
  assert.equal(labels.includes(t("oauth_reconnect")), oauthExpected, `${slug}: independent OAuth recovery capability`);
  assert.ok(labels.includes(t("oauth_inDashboard")));
  if (slug === "cline") {
    await search("pioneer");
    await buttons(box).find((b) => b.textContent === t("det_newKey")).onclick(); await settle();
    for (const id of ["globalSearch", "webSearch", "keySearch", "oauthSearch"]) {
      assert.equal(document.querySelector("#" + id).value, slug, `${slug}: detail recovery replaces the unrelated search`);
    }
    assert.equal(document.querySelector("#keyList .keyrow.open .kname")?.textContent, sandbox.OMNI_APIKEY_MAP[slug].label);
    assert.ok(document.querySelector("#keyList .keyrow.open .keyform"), "detail recovery opens the requested key form");
  }
}

async function keyFormFromDirectory(slug) {
  document.querySelector('[data-pane="catalog"]').click();
  await search(slug);
  const entry = expand(slug);
  const action = buttons(entry.querySelector(".directory-body").lastElementChild).find((b) => b.textContent === t("catalog_keyForm"));
  assert.ok(action, `${slug}: directory exposes key form`);
  await action.onclick(); await settle();
  assert.ok(!document.querySelector("#pane-key").classList.contains("hide"));
  const form = document.querySelector("#keyList .keyform");
  assert.ok(form, `${slug}: key form opened`);
  return form;
}
for (const [slug, field] of [["google-pse-search", "cx"], ["cloudflare-ai", "accountId"]]) {
  const form = await keyFormFromDirectory(slug), schema = sandbox.OMNI_APIKEY_MAP[slug];
  const required = schema.extra.find((f) => f.key === field && f.required);
  assert.ok(required);
  const extra = [...form.querySelectorAll("input")].find((e) => e.placeholder.startsWith(required.label));
  assert.ok(extra, `${slug}: required ${field} control`);
  form.querySelector('input[type="password"]').value = "synthetic-render-key";
  const add = form.querySelector(".actions button"), before = calls.length;
  await add.onclick();
  assert.ok(form.querySelector(".res").classList.contains("bad"));
  assert.ok(form.querySelector(".res").textContent.includes(required.label));
  assert.ok(!calls.slice(before).some((c) => ["addApiKey", "bulkAddApiKey"].includes(c.action)), `${slug}: missing required field blocks submission`);
  assert.equal(!!form.querySelector("textarea"), schema.bulk, `${slug}: bulk control follows upstream exclusions`);
  extra.value = "synthetic-" + field;
  await add.onclick(); await settle();
  const sent = calls.slice(before).filter((c) => c.action === "addApiKey");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].slug, slug);
  assert.equal(sent[0].psd[field], "synthetic-" + field);
}
for (const slug of ["azure-openai", "heroku", "databricks", "snowflake"]) {
  const provider = sandbox.OMNI_APIKEY_MAP[slug];
  assert.equal(provider.dashboardOnly, true, `${slug}: resource/endpoint setup needs the dashboard`);
  const form = sandbox.keyForm(provider);
  assert.equal(form.querySelector("input, textarea"), null, `${slug}: generic key fields would lose required configuration`);
  await openedBy(buttons(form).find((b) => b.textContent === t("oauth_inDashboard")), dashboardUrl(provider), `${slug}: specialized setup`);
}
await search("");
document.querySelector('[data-pane="oauth"]').click(); await settle();
for (const slug of ["cursor", "zed", "trae", "ghe-copilot"]) {
  const card = document.querySelector(`#oauthList [data-slug="${slug}"]`);
  assert.ok(card);
  assert.equal(card.querySelector('input[type="password"], .codebox'), null, `${slug}: no unsupported inline credential action`);
  await openedBy(buttons(card).find((b) => b.textContent === t("oauth_inDashboard")), dashboardUrl(sandbox.OMNI_OAUTH_MAP[slug]), `${slug}: OAuth handoff`);
}
assert.ok(document.querySelector('#oauthList [data-slug="devin-cli"] input[type="password"]'), "source-supported manual token import remains available");

// A broken native/unknown connection may be explicitly managed, but is never a retired-delete task.
const originalConnections = CANNED.connections;
for (const provider of ["chatgpt-web", "synthetic-unlisted", "cline"]) {
  const conn = { provider, id: "synthetic-wizard", name: "Synthetic wizard", testStatus: "error", hasError: true, isActive: true };
  CANNED.connections = { byProvider: { [provider]: { total: 1, good: 0, bad: 1, names: [conn.name] } }, total: 1, all: [conn], problems: [conn], unreachable: false };
  await sandbox.loadConnections();
  vm.runInContext('wizMode = "fix"; wizSkip.clear();', sandbox);
  if (provider === "cline") await search("pioneer");
  document.querySelector('[data-pane="wizard"]').click(); await settle();
  const action = document.querySelector("#wizBox .wiz-go");
  assert.ok(action && !action.classList.contains("danger"), `${provider}: not a retired-delete primary action`);
  const before = calls.length;
  if (provider === "cline") {
    assert.ok(action.textContent.includes(t("wiz_goKey")), "dashboard-only OAuth must not hide working API-key recovery");
    await action.onclick(); await settle();
    assert.ok(!document.querySelector("#pane-key").classList.contains("hide"));
    for (const id of ["globalSearch", "webSearch", "keySearch", "oauthSearch"]) {
      assert.equal(document.querySelector("#" + id).value, provider, "Wizard recovery replaces the unrelated search");
    }
    assert.equal(document.querySelector("#keyList .keyrow.open .kname")?.textContent, sandbox.OMNI_APIKEY_MAP[provider].label);
    assert.ok(document.querySelector("#keyList .keyrow.open .keyform"), "Wizard recovery opens the requested key form");
  } else await openedBy(action, provider === "chatgpt-web" ? dashboardUrl(sandbox.OMNI_CATALOG_MAP[provider]) : "http://127.0.0.1:20128/dashboard/providers", `${provider}: wizard handoff`);
  assert.ok(!calls.slice(before).some((c) => ["deleteConn", "refreshSessions", "oauthStart", "oauthConnect"].includes(c.action)), `${provider}: no unsupported/destructive shortcut`);
}
CANNED.connections = originalConnections;
await sandbox.loadConnections();

// Reconnect through the attention band's actual button while the OAuth list is filtered elsewhere.
// Merely calling startOauth("github") would miss a handler that leaves the code hidden by old search.
{
  const originalStart = CANNED.oauthStart, originalState = CANNED.oauthState;
  let started = false;
  const conn = { provider: "github", id: "synthetic-github-reconnect", name: "Synthetic GitHub reconnect", testStatus: "error", hasError: true, isActive: true };
  CANNED.connections = { byProvider: { github: { total: 1, good: 0, bad: 1, names: [conn.name] } }, total: 1, all: [conn], problems: [conn], unreachable: false };
  CANNED.oauthStart = (req) => {
    assert.equal(req.provider, "github", "attention reconnect starts only its own provider");
    started = true;
    return { ok: true };
  };
  CANNED.oauthState = () => ({ states: started ? { github: {
    status: "pending", kind: "device", userCode: "TEST-ONLY", interval: 5,
    verifyUrl: "https://synthetic.example.test/device", expiresAt: Date.now() + 60000,
  } } : {} });
  await sandbox.loadConnections();
  document.querySelector('[data-pane="key"]').click();
  await search("openai");
  assert.equal(document.querySelector('#oauthList [data-slug="github"]'), null, "precondition: unrelated search hides GitHub's OAuth card");
  document.querySelector('[data-pane="dash"]').click(); await settle();
  const problem = [...document.querySelectorAll("#webProblems .prob")].find((row) => row.querySelector(".prob-name")?.textContent === conn.name);
  assert.ok(problem, "synthetic GitHub failure appears in the visible attention band");
  const reconnect = buttons(problem).find((b) => b.textContent === t("oauth_reconnect"));
  assert.ok(reconnect, "attention band offers the real OAuth reconnect action");
  const before = calls.length;
  reconnect.click(); await settle();
  assert.deepEqual(calls.slice(before).filter((call) => call.action === "oauthStart"), [{ action: "oauthStart", provider: "github" }]);
  for (const id of ["globalSearch", "webSearch", "keySearch", "oauthSearch"]) {
    assert.equal(document.querySelector("#" + id).value, "github", "attention reconnect focuses the requested provider across searches");
  }
  assert.equal(document.querySelector('[data-pane="oauth"]').getAttribute("aria-selected"), "true");
  assert.ok(!document.querySelector("#pane-oauth").classList.contains("hide"));
  assert.equal(document.querySelector('#oauthList [data-slug="github"] .code')?.textContent, "TEST-ONLY", "the pending device code remains visible after reconnect");
  if (originalStart === undefined) delete CANNED.oauthStart; else CANNED.oauthStart = originalStart;
  CANNED.oauthState = originalState;
  CANNED.connections = originalConnections;
  await sandbox.refreshOauth();
  await sandbox.loadConnections();
}

// A detail's Chat action overlaps the generic pane fill and an explicit provider fill. Hold the one
// shared model read unresolved: a targeted handoff must clear the old sendable selection immediately,
// then keep the requested target (including an unavailable one) when all waiting fills finish.
{
  const originalModels = CANNED.models;
  const chatConnections = structuredClone(originalConnections);
  chatConnections.byProvider.openai = { total: 1, good: 1, bad: 0, names: ["Synthetic OpenAI"] };
  chatConnections.all.push({ provider: "openai", id: "synthetic-chat-openai", name: "Synthetic OpenAI", testStatus: "active", hasError: false, isActive: true });
  chatConnections.total++;
  CANNED.connections = chatConnections;
  await sandbox.loadConnections();
  const models = [
    { id: "openai/synthetic-chat", type: "chat", supported_endpoints: ["chat"] },
    { id: "openai/synthetic-alternate", type: "chat", supported_endpoints: ["chat"] },
    { id: "gemini/synthetic-chat", type: "chat", supported_endpoints: ["chat"] },
    { id: "claude-web/synthetic-chat", type: "chat", supported_endpoints: ["chat"] },
  ];
  const selection = () => ({
    provider: document.querySelector("#chatProv").value,
    model: document.querySelector("#chatModel").value,
    providers: [...document.querySelectorAll("#chatProv option")].map((o) => [o.value, o.textContent, o.hasAttribute("selected")]),
    models: [...document.querySelectorAll("#chatModel option")].map((o) => [o.value, o.textContent]),
  });
  for (const [target, expectedModel] of [["gemini", "gemini/synthetic-chat"], ["chatgpt-web", ""]]) {
    CANNED.models = { ok: true, models };
    assert.equal(vm.runInContext("modelsLoading", sandbox), null, "previous fixture model loading has settled");
    vm.runInContext("modelList = null;", sandbox);
    await sandbox.openChat("openai");
    assert.equal(document.querySelector("#chatProv").value, "openai", "precondition: an unrelated usable provider is selected");
    assert.equal(document.querySelector("#chatModel").value, "openai/synthetic-chat");
    document.querySelector('[data-pane="dash"]').click();

    const pending = [];
    CANNED.models = () => new Promise((resolve) => pending.push(resolve));
    vm.runInContext("modelList = null;", sandbox);
    const beforeModels = calls.filter((call) => call.action === "models").length;
    const untargeted = sandbox.fillChatProviders();
    const actions = document.createElement("div");
    sandbox.nextActionBtns(sandbox.providerRows().find((p) => p.slug === target), actions);
    const chat = buttons(actions).find((b) => b.textContent === t("det_chat"));
    assert.ok(chat, `${target}: detail supplies the actual Chat handler`);
    const opening = chat.onclick();
    const finished = Promise.all([untargeted, opening]);
    assert.equal(pending.length, 1, "overlapping untargeted, pane and explicit target fills share one worker model read");
    assert.equal(calls.filter((call) => call.action === "models").length - beforeModels, 1);
    assert.equal(document.querySelector('[data-pane="chat"]').getAttribute("aria-selected"), "true");
    assert.equal(document.querySelector("#chatProv").value, "", `${target}: old provider is cleared before model loading resolves`);
    assert.equal(document.querySelector("#chatModel").value, "", `${target}: old model is immediately unsendable`);
    assert.equal(document.querySelector("#chatModel").children.length, 0);
    const beforeLoadingSend = calls.length;
    document.querySelector("#chatIn").value = "Synthetic message while models are pending";
    document.querySelector("#chatSend").click(); await settle();
    assert.ok(!calls.slice(beforeLoadingSend).some((call) => call.action === "chat"), `${target}: unresolved handoff cannot send through the previous OpenAI selection`);
    assert.equal(document.querySelector("#chatIn").value, "Synthetic message while models are pending", "blocked send preserves the draft");
    assert.equal(document.querySelector("#chatProv").value, "");
    assert.equal(document.querySelector("#chatModel").value, "");
    document.querySelector("#chatIn").value = "";

    pending[0]({ ok: true, models });
    await finished; await settle();
    assert.equal(calls.filter((call) => call.action === "models").length - beforeModels, 1, "completion does not start a second model read");
    assert.equal(document.querySelector("#chatProv").value, expectedModel ? target : "", `${target}: latest explicit target determines the selection`);
    assert.equal(document.querySelector("#chatModel").value, expectedModel);
    assert.ok([...document.querySelectorAll("#chatProv option")].some((option) => option.value === "openai"), "the response contains a usable alternative, so an empty target is deliberate");
    if (!expectedModel) {
      assert.equal(document.querySelector("#chatModel").children.length, 0, "unavailable target has no model to send to");
      assert.equal(document.querySelector('#chatProv option[value=""]').textContent, sandbox.OMNI_CATALOG_MAP[target].label + ": " + t("chat_noModels"));
    }
    const chosen = selection();
    await settle();
    assert.deepEqual(selection(), chosen, `${target}: completed overlapping fills leave the explicit selection intact`);
    if (!expectedModel) {
      const before = calls.length;
      document.querySelector("#chatIn").value = "Synthetic render-only message";
      document.querySelector("#chatSend").click(); await settle();
      assert.ok(!calls.slice(before).some((call) => call.action === "chat"), "Send cannot silently route the unavailable target to OpenAI after loading");
      document.querySelector("#chatIn").value = "";

      // A later deliberate picker change takes precedence over an already-started untargeted fill.
      const refill = sandbox.fillChatProviders();
      document.querySelector("#chatProv").value = "gemini";
      document.querySelector("#chatProv").dispatchEvent(new Event("change", { bubbles: true }));
      await refill; await settle();
      assert.equal(document.querySelector("#chatProv").value, "gemini", "a later user choice is retained");
      assert.equal(document.querySelector("#chatModel").value, "gemini/synthetic-chat");
      assert.equal(calls.filter((call) => call.action === "models").length - beforeModels, 1, "the deliberate picker change uses the completed shared model read");
    }
  }
  // A later untargeted fill is not a new destination. Exercise that ordering separately from the
  // original coalescing cases above, including real rail clicks before and after the response.
  // Gemini is not the alphabetically first option: silently falling back to Claude must fail here.
  const chatTab = document.querySelector('[data-pane="chat"]');
  const dashTab = document.querySelector('[data-pane="dash"]');
  for (const targets of [["gemini"], ["chatgpt-web"], ["claude-web", "gemini"], ["gemini", "chatgpt-web"], ["chatgpt-web", "gemini"]]) {
    const target = targets.at(-1), expectedModel = target === "chatgpt-web" ? "" : target + "/synthetic-chat";
    CANNED.models = { ok: true, models };
    assert.equal(vm.runInContext("modelsLoading", sandbox), null, "previous model read has settled");
    vm.runInContext("modelList = null;", sandbox);
    await sandbox.openChat("openai");
    assert.equal(document.querySelector("#chatProv").value, "openai");
    assert.equal(document.querySelector("#chatModel").value, "openai/synthetic-chat");
    dashTab.click();

    const pending = [];
    CANNED.models = () => new Promise((resolve) => pending.push(resolve));
    vm.runInContext("modelList = null;", sandbox);
    const beforeModels = calls.filter((call) => call.action === "models").length;
    // Each real handoff supersedes the previous destination, including an unavailable one.
    const openings = targets.map((slug) => {
      const actions = document.createElement("div");
      sandbox.nextActionBtns(sandbox.providerRows().find((p) => p.slug === slug), actions);
      const chat = buttons(actions).find((b) => b.textContent === t("det_chat"));
      assert.ok(chat, `${slug}: detail exposes the real targeted Chat handler`);
      const opening = chat.onclick();
      chatTab.click(); // An untargeted fill between rapid explicit handoffs is not a new destination.
      return opening;
    });
    const laterFill = sandbox.fillChatProviders();
    chatTab.click(); // Re-click the selected rail item while the targeted fill is still waiting.
    dashTab.click();
    chatTab.click(); // Leaving and returning must also retain the pending destination.
    const finished = Promise.all([...openings, laterFill]);
    assert.equal(pending.length, 1, `${target}: later fills and rail clicks share the pending model read`);
    assert.equal(calls.filter((call) => call.action === "models").length - beforeModels, 1);
    assert.equal(document.querySelector("#chatProv").value, "", `${target}: later navigation cannot restore the old provider while loading`);
    assert.equal(document.querySelector("#chatModel").value, "", `${target}: later navigation cannot restore the old model while loading`);
    const beforeLoadingSend = calls.length;
    document.querySelector("#chatIn").value = "Synthetic draft after rail navigation while loading";
    document.querySelector("#chatSend").click(); await settle();
    assert.ok(!calls.slice(beforeLoadingSend).some((call) => call.action === "chat"), `${targets.join(" → ")}: pending handoffs remain unsendable after later rail clicks`);
    assert.equal(document.querySelector("#chatIn").value, "Synthetic draft after rail navigation while loading");
    document.querySelector("#chatIn").value = "";

    const assertTarget = (stage) => {
      assert.equal(document.querySelector("#chatProv").value, expectedModel ? target : "", `${target}: ${stage} retains the explicit provider`);
      assert.equal(document.querySelector("#chatModel").value, expectedModel, `${target}: ${stage} retains the explicit model`);
      if (!expectedModel) {
        assert.equal(document.querySelector("#chatModel").children.length, 0, `${stage}: unavailable target remains unsendable`);
        assert.equal(document.querySelector('#chatProv option[value=""]')?.textContent, sandbox.OMNI_CATALOG_MAP[target].label + ": " + t("chat_noModels"), `${stage}: unavailable target keeps its own explanation`);
      }
    };
    pending[0]({ ok: true, models });
    await finished; await settle();
    assertTarget("untargeted fills after " + targets.join(" → "));
    assert.ok([...document.querySelectorAll("#chatProv option")].some((option) => option.value === "claude-web"), "a usable default alternative makes silent fallback observable");

    await sandbox.fillChatProviders(); await settle();
    assertTarget("an untargeted fill after completion");
    dashTab.click(); chatTab.click(); chatTab.click(); await settle();
    assert.equal(chatTab.getAttribute("aria-selected"), "true");
    assert.ok(!document.querySelector("#pane-chat").classList.contains("hide"));
    assertTarget("returning to Chat and re-clicking its rail item");
    if (!expectedModel) {
      const beforeSend = calls.length;
      document.querySelector("#chatIn").value = "Synthetic draft after returning to unavailable Chat";
      document.querySelector("#chatSend").click(); await settle();
      assert.ok(!calls.slice(beforeSend).some((call) => call.action === "chat"), "returning to an unavailable target must not send through a fallback provider");
      assert.equal(document.querySelector("#chatIn").value, "Synthetic draft after returning to unavailable Chat", "blocked send after navigation preserves the draft");
      document.querySelector("#chatIn").value = "";
    }

    // A real picker change, unlike a refill or rail click, is a new destination. It must win over
    // a fill already awaiting the cached models and stay selected on subsequent visits as well.
    const refill = sandbox.fillChatProviders();
    document.querySelector("#chatProv").value = "openai";
    document.querySelector("#chatProv").dispatchEvent(new Event("change", { bubbles: true }));
    await refill; await settle();
    assert.equal(document.querySelector("#chatProv").value, "openai", `${target}: a later deliberate picker change supersedes the explicit target`);
    assert.equal(document.querySelector("#chatModel").value, "openai/synthetic-chat");
    const modelRefill = sandbox.fillChatProviders();
    document.querySelector("#chatModel").value = "openai/synthetic-alternate";
    document.querySelector("#chatModel").dispatchEvent(new Event("change", { bubbles: true }));
    await modelRefill; await settle();
    assert.equal(document.querySelector("#chatModel").value, "openai/synthetic-alternate", "a later deliberate model choice wins over an already-started fill");
    await sandbox.fillChatProviders();
    dashTab.click(); chatTab.click(); chatTab.click(); await settle();
    assert.equal(document.querySelector("#chatProv").value, "openai", `${target}: refills and return navigation preserve the user's replacement choice`);
    assert.equal(document.querySelector("#chatModel").value, "openai/synthetic-alternate", "refills and rail revisits preserve the chosen non-default model");
    assert.equal(pending.length, 1, `${target}: later navigation and picker changes never start another model read`);
    assert.equal(calls.filter((call) => call.action === "models").length - beforeModels, 1);
  }
  // Picker changes also win during a genuinely deferred untargeted refresh with existing options.
  // This exercises the real change handlers, rather than mutating the fill's generation/target state.
  for (const picker of ["provider", "model"]) {
    CANNED.models = { ok: true, models };
    await sandbox.openChat("openai");
    const pending = [];
    CANNED.models = () => new Promise((resolve) => pending.push(resolve));
    vm.runInContext("modelList = null;", sandbox);
    const beforeModels = calls.filter((call) => call.action === "models").length;
    chatTab.click();
    const refill = sandbox.fillChatProviders();
    const select = document.querySelector(picker === "provider" ? "#chatProv" : "#chatModel");
    select.value = picker === "provider" ? "gemini" : "openai/synthetic-alternate";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    assert.equal(pending.length, 1, `${picker}: deliberate change coalesces with the existing model read`);
    pending[0]({ ok: true, models });
    await refill; await settle();
    const provider = picker === "provider" ? "gemini" : "openai";
    const model = picker === "provider" ? "gemini/synthetic-chat" : "openai/synthetic-alternate";
    assert.equal(document.querySelector("#chatProv").value, provider, `${picker}: deferred completion retains the user's provider`);
    assert.equal(document.querySelector("#chatModel").value, model, `${picker}: deferred completion retains the user's model`);
    dashTab.click(); chatTab.click(); chatTab.click(); await settle();
    assert.equal(document.querySelector("#chatProv").value, provider);
    assert.equal(document.querySelector("#chatModel").value, model, `${picker}: the deliberate choice survives another rail visit`);
    assert.equal(calls.filter((call) => call.action === "models").length - beforeModels, 1, `${picker}: all fills still use one worker model read`);
  }
  CANNED.models = originalModels;
  CANNED.connections = originalConnections;
  await sandbox.loadConnections();
}

await settle();
assert.deepEqual(errors, [], `render JS errors after interactions: ${JSON.stringify(errors)}`);
assert.ok(!calls.some((c) => c.action === "deleteConn"), "this suite never requests a real or synthetic deletion");
console.log(`render OK — 0 JS errors; directory=${gen.all.length}, OAuth=${oauthCards}, web=${webChips}; metadata/search/actions, required fields, manual setup, retirement, reconnect search, shared Chat loading, persistent/rapid Chat targets and deliberate provider/model overrides`);
