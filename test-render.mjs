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
import { area } from "./test-harness.mjs"; // shared in-memory chrome.storage — one impl for both suites

const EXT = dirname(fileURLToPath(import.meta.url));
const { document } = parseHTML(readFileSync(join(EXT, "popup.html"), "utf8"));

const NOW = 1800000000000;
const CANNED = {
  getAll: { caps: { "claude-web": { provider: "claude-web", slug: "claude-web", label: "Claude Web", cookieCount: 12, at: NOW - 5 * 60000, accountId: "acc1" } } },
  connections: { byProvider: { "claude-web": { total: 1, good: 0, bad: 1, names: ["Claude Web · acc1"] }, "gemini": { total: 2, good: 2, bad: 0, names: [] } }, total: 3, problems: [{ provider: "claude-web", id: "dead1", name: "Claude Web · acc1", isActive: true }], all: [{ provider: "claude-web", id: "dead1", name: "Claude Web · acc1", testStatus: "error", hasError: true, isActive: true }, { provider: "gemini", id: "g1", name: "Gemini · acc1", testStatus: "active", hasError: false, isActive: true }, { provider: "gemini", id: "g2", name: "Gemini · acc2", testStatus: "active", hasError: false, isActive: false }], unreachable: false },
  getProbes: { probes: {} }, oauthState: { states: {} },
  getSettings: { settings: { sweep: true, sweepMin: 15, notify: true, theme: "auto" } },
};
const errors = [];
const chrome = {
  storage: { local: area(), session: area() },
  runtime: { sendMessage: (msg, cb) => { const r = CANNED[msg.action] || { ok: true }; if (cb) cb(r); return Promise.resolve(r); }, onMessage: { addListener: () => {} }, getURL: (x) => x, getManifest: () => ({ version: "dev" }) },
  tabs: { query: () => Promise.resolve([]), create: () => Promise.resolve({ id: 1 }), onUpdated: { addListener: () => {}, removeListener: () => {} } },
  action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
  alarms: { create: () => {}, clear: () => {}, get: (n, cb) => cb(null), onAlarm: { addListener: () => {} } },
  notifications: { create: () => {} }, windows: { create: () => {} },
};
const sandbox = {
  document, chrome, console, navigator: { clipboard: { writeText: () => Promise.resolve() } }, location: { search: "" },
  setTimeout: (f) => { try { f(); } catch (e) { errors.push("setTimeout:" + e.message); } return 0; },
  clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  URLSearchParams, URL, Blob: class {}, Promise, JSON, Math, Date,
  atob: (s) => Buffer.from(s, "base64").toString("binary"), Object, Array, String, Number, RegExp, Set, Map, Boolean, parseInt,
  // Minimal fetch/AbortController so probeServer() sees the gateway as ONLINE → init loads connections
  // (without these the sandbox throws in probeServer → serverOnline=false → the manager/attention paths never populate).
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }), text: () => Promise.resolve("{}") }),
};
sandbox.self = sandbox; sandbox.window = sandbox; sandbox.globalThis = sandbox;
sandbox.URL.createObjectURL = () => "blob:x"; sandbox.URL.revokeObjectURL = () => {};
vm.createContext(sandbox);
for (const f of ["providers.gen.js", "providers.js", "popup.js"]) {
  try { vm.runInContext(readFileSync(join(EXT, f), "utf8"), sandbox, { filename: f }); }
  catch (e) { errors.push(f + ": " + e.message); }
}
await new Promise((r) => setTimeout(r, 50));

assert.deepEqual(errors, [], `render JS errors: ${JSON.stringify(errors)}`);
const oauthCards = document.querySelectorAll("#oauthList .card").length;
const webChips = document.querySelectorAll("#webChips button").length;
assert.ok(oauthCards >= 14, `oauth cards rendered (${oauthCards})`);
assert.ok(webChips >= 18, `web chips rendered (${webChips})`);
for (const id of ["settingsBtn", "exportBtn", "clearProbesBtn", "setTheme", "webProblems"]) assert.ok(document.querySelector("#" + id), `#${id} present`);

// Attention band populated from the fixture's broken connection (dead1) — the honest-signal path.
assert.ok(document.querySelector("#webProblems .prob"), "attention band lists the broken connection");

// Full connections manager: collapsed head shows the count; expanding lists EVERY connection with
// rename/enable-disable/delete (parity with the dashboard's manage capabilities).
const manageHead = document.querySelector("#manageSection .manage-head");
assert.ok(manageHead, "manager head rendered");
assert.equal(document.querySelectorAll("#manageSection .prob").length, 0, "manager collapsed by default (no rows)");
manageHead.onclick(); // expand
const rows = document.querySelectorAll("#manageSection .prob");
assert.equal(rows.length, 3, `manager lists all 3 connections (got ${rows.length})`);
assert.equal(document.querySelectorAll("#manageSection button.danger").length, 3, "delete offered on every managed connection");
assert.equal(document.querySelectorAll("#manageSection .prob.okrow").length, 2, "healthy connections get neutral rows");
const toggleLabels = [...document.querySelectorAll("#manageSection .prob button")].map((b) => b.textContent);
assert.ok(toggleLabels.includes("Включить"), "disabled connection offers 'Включить'");
assert.ok(toggleLabels.includes("Выключить"), "active connection offers 'Выключить'");
// Settings panel: the sweep opt-out offers one chip per provider the background sweep would probe
// (i.e. per provider with connections — claude-web + gemini in the fixture).
document.querySelector("#settingsBtn").click();
await new Promise((r) => setTimeout(r, 50));
const skipChips = [...document.querySelectorAll("#sweepSkipChips .chip")].map((c) => c.textContent);
assert.equal(skipChips.length, 2, `a sweep opt-out chip per connected provider (got ${JSON.stringify(skipChips)})`);
assert.ok(document.querySelector("#setPersist"), "#setPersist toggle present");
assert.ok(document.querySelector("#lastRecovery"), "#lastRecovery line present");

console.log(`render OK — 0 JS errors, oauth cards=${oauthCards}, web chips=${webChips}, manager rows=${rows.length}, sweep-skip chips=${skipChips.length}, key controls present`);
