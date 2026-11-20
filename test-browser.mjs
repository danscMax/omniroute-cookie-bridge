// Real unpacked-extension verification. No browser API mocks and no forwarding proxy.
// node test-browser.mjs --executable <chromium> --playwright <package-dir> --output <new-dir>
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { fixture, sentinel, closeServer } from "./test-browser-fixture.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => {
  if (x.startsWith("--")) a.push([x.slice(2), all[i + 1]]); return a;
}, []));
const root = path.dirname(fileURLToPath(import.meta.url));
for (const k of ["executable", "playwright", "output"]) assert.ok(args[k], `Required --${k}`);
const output = path.resolve(args.output);
await fs.mkdir(output); // Refuse an existing output/profile instead of attaching to anything.
const require = createRequire(import.meta.url);
const pw = require(path.resolve(args.playwright));
const pwVersion = require(path.join(path.resolve(args.playwright), "package.json")).version;
const report = { startedAt: new Date().toISOString(), invocation: process.argv, playwright: pwVersion, executable: path.resolve(args.executable), extension: path.resolve(args.extension || root), features: [], errors: [], artifacts: [], isolation: {}, sources: [
  "https://github.com/microsoft/playwright/blob/main/docs/src/chrome-extensions-js-python.md",
  "https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md"
] };
let context, proxy, direct, worker, page, extensionId;
const contexts = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writeJSON = (name, value) => fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function snapshotExtension(source, name) {
  const destination = path.join(output, name);
  await fs.mkdir(destination);
  const files = [];
  async function collect(relative) {
    const stat = await fs.lstat(path.join(source, relative));
    assert.ok(!stat.isSymbolicLink(), `Refusing extension symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const child of (await fs.readdir(path.join(source, relative))).sort()) await collect(path.join(relative, child));
    } else files.push(relative);
  }
  for (const item of ["manifest.json", "background.js", "popup.html", "popup.js", "popup.css", "providers.gen.js", "providers.js", "content-aistudio.js", "icons", "_locales"]) await collect(item);
  const hashes = {};
  for (const relative of files.sort()) {
    const bytes = await fs.readFile(path.join(source, relative));
    hashes[relative.replaceAll("\\", "/")] = digest(bytes);
    await fs.mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
    await fs.writeFile(path.join(destination, relative), bytes, { flag: "wx" });
  }
  for (const relative of files) {
    const expected = hashes[relative.replaceAll("\\", "/")];
    assert.equal(digest(await fs.readFile(path.join(source, relative))), expected, `Source changed during snapshot: ${relative}`);
    assert.equal(digest(await fs.readFile(path.join(destination, relative))), expected);
  }
  const result = { source, destination, files: hashes, sha256: digest(JSON.stringify(hashes)) };
  report.snapshots ||= []; report.snapshots.push(result);
  await writeJSON(`${name}-digests.json`, result);
  return destination;
}
async function test(name, body) {
  const at = Date.now();
  try { const detail = await body(); const status = detail?.skipped ? "skipped" : "pass"; report.features.push({ name, status, ms: Date.now() - at, detail }); console.log(`${status.toUpperCase()} ${name}`); }
  catch (error) {
    report.features.push({ name, status: "fail", ms: Date.now() - at, error: error.stack });
    console.log(`FAIL ${name}: ${error.message}`);
    if (page && !page.isClosed()) await screenshot(`failure-${report.features.length}`).catch(() => {});
  }
  await writeJSON("feature-results.json", report);
}
function skip(name, reason) { report.features.push({ name, status: "skipped", reason }); }
async function screenshot(name, target = page) {
  const filename = path.join(output, `${name}.png`);
  await target.screenshot({ path: filename, timeout: 8000 }); report.artifacts.push(filename); return filename;
}
function observePage(p) {
  p.on("pageerror", (e) => report.errors.push({ kind: "pageerror", url: p.url(), message: String(e) }));
  p.on("console", (m) => { if (["error", "warning"].includes(m.type())) report.errors.push({ kind: m.type(), url: p.url(), message: m.text() }); });
}
async function launch(extension, profile, locale = "en-US") {
  const ctx = await pw.chromium.launchPersistentContext(path.join(output, profile), {
    executablePath: report.executable, headless: false, locale, viewport: { width: 900, height: 700 },
    timeout: 30000, ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      `--proxy-server=http://127.0.0.1:${proxy.port}`, "--proxy-bypass-list=<-loopback>",
      "--disable-quic", "--disable-background-networking", "--disable-component-update", "--no-first-run", `--lang=${locale}`,
    ],
  });
  contexts.add(ctx);
  ctx.setDefaultTimeout(8000);
  ctx.pages().forEach(observePage); ctx.on("page", observePage);
  ctx.on("console", (m) => { if (m.type() === "error") report.errors.push({ kind: "context-console", message: m.text() }); });
  return ctx;
}
async function close(ctx) { if (ctx) { await ctx.close(); contexts.delete(ctx); } }
async function getWorker(ctx) {
  return ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 15000 });
}
async function message(action, data = {}, timeout = 22000) {
  return page.evaluate(({ action, data, timeout }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Message ${action} exceeded ${timeout}ms`)), timeout);
    chrome.runtime.sendMessage({ action, ...data }, (r) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve(r);
    });
  }), { action, data, timeout });
}
async function openUI(ctx = context, id = extensionId, query = "") {
  const url = `chrome-extension://${id}/popup.html${query}`;
  const sw = ctx.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${id}/`));
  assert.ok(sw, "Installed extension worker must exist before opening its UI");
  const opened = ctx.waitForEvent("page", { timeout: 10000 });
  await sw.evaluate((url) => chrome.tabs.create({ url }), url);
  const p = await opened;
  await p.waitForURL(url, { timeout: 10000 });
  await p.waitForFunction(() => document.querySelector("#srvDot")?.classList.contains("ok") || document.querySelector("#srvDot")?.classList.contains("bad"), null, { timeout: 20000 });
  return p;
}
async function pane(name) {
  await page.locator(`[data-pane="${name}"]`).click();
  await page.locator(`#pane-${name}`).waitFor({ state: "visible" });
}
async function refreshUI() { await page.reload(); await page.waitForFunction(() => document.querySelector("#srvDot")?.classList.contains("ok")); }
async function restartWorker() {
  const cdp = await context.newCDPSession(page);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await cdp.detach();
  const r = await message("getSettings");
  worker = await getWorker(context); return r;
}
async function snapshotGeometry(target = page) {
  return target.evaluate(() => {
    const rect = (s) => { const e = document.querySelector(s), r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right, scrollHeight: e.scrollHeight, scrollWidth: e.scrollWidth, clientHeight: e.clientHeight, clientWidth: e.clientWidth }; };
    return { viewport: [innerWidth, innerHeight], body: rect("body"), app: rect(".app"), main: rect(".main"), footer: rect(".ftr"), scroll: rect("#scroll") };
  });
}
async function preflight() {
  direct = await sentinel(); proxy = await fixture(direct.origin);
  const probe = path.join(output, "isolation-probe-extension"); await fs.mkdir(probe);
  await fs.writeFile(path.join(probe, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Synthetic isolation probe", version: "1.0", host_permissions: ["http://127.0.0.1/*"], background: { service_worker: "worker.js" } }));
  await fs.writeFile(path.join(probe, "worker.js"), "chrome.runtime.onInstalled.addListener(() => {});\n");
  const ctx = await launch(probe, "profile-preflight");
  report.browser = ctx.browser()?.version();
  const sw = await getWorker(ctx), p = await ctx.newPage();
  await p.goto(`${direct.origin}/fixture/page`);
  const fetchProbe = async (url) => { try { const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5000) }); return { status: r.status, text: await r.text() }; } catch (e) { return { error: String(e) }; } };
  const pageUp = await p.evaluate(fetchProbe, `${direct.origin}/fixture/page-fetch`);
  const workerUp = await sw.evaluate(fetchProbe, `${direct.origin}/fixture/worker`);
  assert.match(pageUp.text || "", /synthetic-proxy/); assert.match(workerUp.text || "", /synthetic-proxy/);
  assert.equal(direct.hits.length, 0);
  await proxy.close();
  const pageDown = await p.evaluate(fetchProbe, `${direct.origin}/fixture/page-down`);
  const workerDown = await sw.evaluate(fetchProbe, `${direct.origin}/fixture/worker-down`);
  assert.ok(pageDown.error, "Page must fail closed with unavailable proxy");
  assert.ok(workerDown.error, "Extension worker must fail closed with unavailable proxy");
  assert.equal(direct.hits.length, 0, "Sentinel must receive zero direct requests even with proxy unavailable");
  report.isolation = { pass: true, sentinelOrigin: direct.origin, directHits: direct.hits, pageUp, workerUp, pageDown, workerDown, launchProxy: `http://127.0.0.1:${proxy.port}`, bypass: "<-loopback>", forwarding: false };
  await close(ctx); await proxy.restart();
  await writeJSON("isolation.json", report.isolation);
}
try {
  await preflight();
  console.log("PASS launch-time isolation for page and extension worker, including unavailable proxy");
  report.extension = await snapshotExtension(report.extension, "extension-snapshot");
  context = await launch(report.extension, "profile-extension"); worker = await getWorker(context);
  report.workerManifest = await worker.evaluate(() => ({ url: self.location.href, manifest: chrome.runtime.getManifest(), popup: chrome.runtime.getURL("popup.html") }));
  extensionId = worker.url().split("/")[2]; report.extensionId = extensionId;
  await worker.evaluate(() => chrome.storage.local.set({ settings: { sweep: false, notify: false, nightly: false, autoRepair: false, autoPark: false, persistSessions: true, theme: "light", sweepMin: 15, sweepSkip: [] } }));
  await context.addCookies([
    { name: "__Secure-authjs.session-token", value: "synthetic-session-one", domain: ".perplexity.ai", path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "fixture_admin", value: "synthetic-admin-session", url: "http://127.0.0.1:20128", httpOnly: true, sameSite: "Lax" },
  ]);
  page = await openUI();
  await test("startup messaging, worker and gateway page MAIN-world routing", async () => {
    assert.equal((await message("ping")).ok, true);
    assert.equal((await message("connections")).unreachable, false);
    assert.ok(proxy.state.journal.some((r) => r.url.endsWith("/api/providers") && r.cookie.includes("fixture_admin=")), "MAIN-world request carries synthetic HttpOnly dashboard session");
    return { worker: worker.url(), browser: report.browser, manifest: await worker.evaluate(() => chrome.runtime.getManifest().version) };
  });
  await test("issue-1 existing HttpOnly cookie detection on popup open", async () => {
    const r = await message("getAll"); assert.ok(r.caps["perplexity-web"], "Existing cookie must appear without requiring a new provider XHR");
    assert.equal(r.caps["perplexity-web"].cookie, undefined); return r.caps["perplexity-web"];
  });
  await test("all eight panes and accessible rail", async () => {
    const labels = [];
    for (const name of ["dash", "wizard", "web", "key", "oauth", "table", "chat", "set"]) {
      await pane(name); const tab = page.locator(`[data-pane="${name}"]`);
      assert.equal(await tab.getAttribute("aria-selected"), "true");
      assert.ok(await tab.getAttribute("aria-label")); labels.push(await tab.getAttribute("aria-label"));
      await screenshot(`pane-${name}`);
    }
    assert.equal(await page.locator('.pane:not(.hide)').count(), 1); return labels;
  });
  await test("global search across web, API-key and OAuth", async () => {
    await pane("web"); // The preceding pane tour ends on Settings, where search is intentionally hidden.
    await page.locator("#globalSearch").fill("definitely-no-fixture-provider");
    await page.waitForFunction(() => document.querySelector("#keySearch").value === "definitely-no-fixture-provider");
    for (const name of ["web", "key", "oauth"]) { await pane(name); assert.equal(await page.locator(`#${name}Search`).inputValue(), "definitely-no-fixture-provider"); }
    assert.equal(await page.locator("#keyList .keyrow").count(), 0);
    assert.equal(await page.locator("#oauthList .card").count(), 0);
    await page.locator("#globalSearch").fill("openai"); await pane("key");
    await page.locator("#keyList .keyrow").first().waitFor();
    await page.locator("#globalSearch").fill("");
  });
  await test("compact/wide/large sizing, footer and inner scroll", async () => {
    await pane("set"); const results = {};
    for (const [s, w, h] of [["s", 420, 560], ["m", 560, 600], ["l", 760, 600]]) {
      await page.setViewportSize({ width: w, height: h }); await page.locator("#setSize").selectOption(s);
      const g = await snapshotGeometry(); results[s] = g;
      assert.equal(g.body.width, w); assert.equal(g.body.height, h);
      assert.ok(g.footer.bottom <= h + 1, "Footer must fit the requested panel");
      assert.ok(g.main.right <= w + 1, "Main content must not extend horizontally");
      assert.ok(g.scroll.scrollHeight > g.scroll.clientHeight, "Long settings content scrolls internally");
      await page.locator("#scroll").evaluate((e) => { e.scrollTop = e.scrollHeight; });
      assert.ok(await page.locator("#scroll").evaluate((e) => e.scrollTop > 0));
      await screenshot(`size-${s}`);
    }
    await page.setViewportSize({ width: 900, height: 700 }); await page.locator("#setSize").selectOption("s"); return results;
  });
  await test("light, dark and system themes persist", async () => {
    await pane("set");
    for (const theme of ["dark", "light", "auto"]) {
      await page.locator("#setTheme").selectOption(theme);
      await page.waitForFunction((t) => t === "auto" ? !document.documentElement.dataset.theme : document.documentElement.dataset.theme === t, theme);
      assert.equal((await message("getSettings")).settings.theme, theme);
    }
  });
  await test("cookie-store refresh, credential add/update and no foreign overwrite", async () => {
    const refresh = await message("refreshSessions", { keys: ["perplexity-web"] });
    assert.equal(refresh.results["perplexity-web"].state, "ok");
    const mine = proxy.state.connections.find((c) => c.provider === "perplexity-web"); assert.ok(mine);
    const foreign = proxy.state.create({ provider: "perplexity-web", name: "Foreign synthetic account", apiKey: "synthetic-foreign-session" });
    await context.addCookies([{ name: "__Secure-authjs.session-token", value: "synthetic-session-two", domain: ".perplexity.ai", path: "/", secure: true, httpOnly: true }]);
    const again = await message("refreshSessions", { keys: ["perplexity-web"] });
    assert.equal(again.results["perplexity-web"].updated, true);
    assert.equal(proxy.state.connections.filter((c) => c.provider === "perplexity-web").length, 2);
    assert.match(mine.apiKey, /synthetic-session-two/); assert.equal(foreign.apiKey, "synthetic-foreign-session");
    const cap = (await message("getAll")).caps["perplexity-web"]; assert.ok(cap); assert.equal(cap.cookie, undefined);
    return again;
  });
  await test("API key form add and same-key update", async () => {
    await pane("key"); await page.locator("#globalSearch").fill("openai");
    const row = page.locator(".keyrow").filter({ has: page.locator(".kname", { hasText: /^OpenAI$/ }) });
    await row.locator(".keyrow-h").click();
    await row.locator('input[type="password"]').fill("synthetic-api-key-one");
    await row.locator(".actions button").first().click();
    await row.locator(".res.ok").waitFor();
    const c = proxy.state.connections.find((x) => x.provider === "openai"); assert.ok(c);
    const n = proxy.state.connections.filter((x) => x.provider === "openai").length;
    assert.equal((await message("addApiKey", { slug: "openai", apiKey: "synthetic-api-key-one" })).ok, true);
    assert.equal(proxy.state.connections.filter((x) => x.provider === "openai").length, n);
  });
  await test("required API-key extras block an incomplete import", async () => {
    const supported = await page.evaluate(() => !!self.OMNI_APIKEY_MAP?.["google-pse-search"]);
    if (!supported) return { skipped: "google-pse-search is absent from the shipped 21 web / 252 API-key / 23 OAuth catalog; catalog coverage belongs to the separate generator change." };
    await pane("key");
    await page.locator("#globalSearch").fill("google-pse-search");
    await page.waitForFunction(() => document.querySelector("#keySearch").value === "google-pse-search");
    await page.locator(".keyrow-h").first().click();
    await page.locator('.keyform input[type="password"]').fill("synthetic-search-key");
    const before = proxy.state.journal.filter((r) => r.method === "POST").length;
    await page.locator(".keyform .actions button").first().click(); await page.locator(".keyform .res.bad").waitFor();
    assert.equal(proxy.state.journal.filter((r) => r.method === "POST").length, before);
    await page.locator("#globalSearch").fill("");
  });
  for (const mode of ["success", "partial", "failure"]) await test(`bulk API keys: ${mode} result is honest`, async () => {
    proxy.state.bulk = mode;
    const r = await message("bulkAddApiKey", { slug: "openai", keys: ["synthetic-bulk-one", "synthetic-bulk-two"] });
    const expected = mode === "success" ? 2 : mode === "partial" ? 1 : 0;
    assert.equal(r.added, expected, `Expected ${expected} actual additions, got ${JSON.stringify(r)}`);
    if (mode !== "success") assert.ok(r.ok === false || r.partial === true || r.failed > 0, "Failures must not be presented as full success");
    return r;
  });
  proxy.state.bulk = "success";
  await test("models, chat, probe and health sweep through synthetic worker requests", async () => {
    const models = await message("models"); assert.ok(models.models.some((m) => m.id === "openai/fixture-model"));
    const chat = await message("chat", { model: "openai/fixture-model", messages: [{ role: "user", content: "Synthetic test only" }] }); assert.equal(chat.text, "Synthetic fixture reply");
    assert.equal((await message("probe", { slug: "openai" })).alive, true);
    assert.equal((await message("sweepNow")).ok, true);
    assert.ok((await message("getProbes")).probes.openai);
    await message("clearProbes"); assert.equal(Object.keys((await message("getProbes")).probes).length, 0);
  });
  await test("OAuth device flow UI, slow_down backoff and cancel", async () => {
    await pane("oauth"); await page.locator("#globalSearch").fill("github"); proxy.state.oauthPoll = "slow_down";
    await page.locator('[data-slug="github"] button').first().click();
    // The pending card first renders an ellipsis while device-code is still in flight.
    await page.waitForFunction(() => document.querySelector('[data-slug="github"] .code')?.textContent === "TEST-ONLY", null, { timeout: 8000 });
    assert.equal(await page.locator('[data-slug="github"] .code').innerText(), "TEST-ONLY");
    const r = await message("oauthState"); assert.equal(r.states.github.interval, 10);
    const n = proxy.state.journal.filter((j) => j.url.endsWith("/github/poll")).length;
    await message("oauthState"); await message("oauthState");
    assert.equal(proxy.state.journal.filter((j) => j.url.endsWith("/github/poll")).length, n);
    await page.locator('[data-slug="github"] .cancel').click();
    assert.equal((await message("oauthState")).states.github, undefined);
    await page.locator("#globalSearch").fill("");
  });
  await test("OAuth device success and redirect connection-count completion", async () => {
    proxy.state.oauthPoll = "success"; assert.equal((await message("oauthStart", { provider: "github" })).ok, true);
    assert.equal((await message("oauthState")).states.github.status, "success"); await message("oauthCancel", { provider: "github" });
    assert.equal((await message("oauthConnect", { provider: "codex" })).ok, true);
    proxy.state.create({ provider: "codex", name: "Synthetic redirect completed" });
    // The popup also polls; a fixed sleep can land inside the worker's nextPollAt/memo window.
    await page.waitForFunction(async () => (await chrome.runtime.sendMessage({ action: "oauthState" })).states?.codex?.status === "success", null, { polling: 500, timeout: 15000 });
    await message("oauthCancel", { provider: "codex" });
  });
  await test("OAuth manual token, credential blob and synthetic local import", async () => {
    assert.equal((await message("oauthImport", { provider: "cursor", token: "short" })).ok, false);
    assert.equal((await message("oauthImport", { provider: "cursor", token: "synthetic-token-manual" })).ok, true);
    assert.equal((await message("oauthImport", { provider: "cursor", token: "omniroute-cred-v1.synthetic-only" })).ok, true);
    proxy.state.autoFound = false; assert.equal((await message("oauthAutoImport", { provider: "cursor" })).ok, false);
    proxy.state.autoFound = true; assert.equal((await message("oauthAutoImport", { provider: "cursor" })).ok, true);
  });
  for (const mode of ["partial", "failure"]) await test(`OAuth ZIP ${mode} result is honest`, async () => {
    proxy.state.zip = mode;
    const r = await message("zipImport", { provider: "claude", b64: Buffer.from("synthetic archive bytes, fixture extraction only").toString("base64") });
    assert.equal(r.added, mode === "partial" ? 1 : 0, JSON.stringify(r));
    assert.ok(r.ok === false || r.partial === true || r.failed > 0, "ZIP failures must be reported"); return r;
  });
  await test("settings, export without secrets, roster import and management confirmation", async () => {
    await refreshUI(); await pane("set"); await page.locator("#setNotify").check();
    assert.equal((await message("getSettings")).settings.notify, true);
    const downloaded = page.waitForEvent("download"); await page.locator("#exportBtn").click();
    const download = await downloaded, file = path.join(output, "synthetic-roster.json"); await download.saveAs(file);
    report.artifacts.push(file); const text = await fs.readFile(file, "utf8"); assert.ok(!text.includes("synthetic-session-two")); assert.ok(!text.includes("synthetic-api-key-one"));
    await page.locator("#importFile").setInputFiles({ name: "synthetic-import.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ connections: [{ provider: "gemini" }] })) });
    await page.waitForFunction(async () => (await chrome.storage.local.get("wiz_import")).wiz_import?.includes("gemini"));
    await pane("table"); await page.locator(".manage-head").click();
    const row = page.locator("#manageSection .prob").filter({ hasText: "Synthetic redirect completed" });
    const name = await row.locator(".prob-name").innerText(); const id = proxy.state.connections.find((c) => c.name === name).id;
    const del = row.locator("button.danger"); await del.click(); assert.ok(proxy.state.connections.some((c) => c.id === id));
    await del.click(); await page.waitForFunction((n) => ![...document.querySelectorAll("#manageSection .prob-name")].some((e) => e.textContent === n), name);
    assert.ok(!proxy.state.connections.some((c) => c.id === id));
  });
  await test("worker restart retains settings and captures; disabling persistence purges disk", async () => {
    const r = await restartWorker(); assert.equal(r.settings.notify, true);
    assert.ok((await message("getAll")).caps["perplexity-web"]);
    await message("setSettings", { settings: { persistSessions: false } });
    assert.equal((await worker.evaluate(() => chrome.storage.local.get("cap_perplexity-web")))["cap_perplexity-web"], undefined);
    assert.ok((await message("getAll")).caps["perplexity-web"]);
    await message("clear", { providerKey: "perplexity-web" });
  });
  for (const mode of ["unauthenticated", "wrong", "offline"]) await test(`gateway ${mode}: no green success or credential writes`, async () => {
    proxy.state.mode = mode; await restartWorker();
    const ping = await message("ping", {}, 16000);
    const start = proxy.state.journal.length;
    const add = await message("addApiKey", { slug: "openai", apiKey: "synthetic-must-not-write" }, 16000);
    assert.equal(add.ok, false, `Credential add must fail: ${JSON.stringify(add)}`);
    if (mode !== "unauthenticated") assert.equal(proxy.state.journal.slice(start).filter((r) => r.method === "POST").length, 0);
    if (mode === "unauthenticated") assert.ok(ping.authenticated === false || ping.state === "unauthenticated" || ping.ok === false, `Auth required must be differentiated: ${JSON.stringify(ping)}`);
    else assert.equal(ping.ok, false, `Wrong/offline gateway must not be green: ${JSON.stringify(ping)}`);
    return { ping, add };
  });
  proxy.state.mode = "online"; await restartWorker();
  await test("hung gateway ping has a bounded response", async () => {
    proxy.state.mode = "hanging"; const t = Date.now();
    try { const r = await message("ping", {}, 16000); assert.equal(r.ok, false); return { elapsed: Date.now() - t, result: r }; }
    finally { proxy.state.mode = "online"; proxy.server.closeAllConnections(); }
  });
  await test("full-tab and detached-window rendering", async () => {
    const full = await openUI(context, extensionId, "?full=1");
    assert.ok(await full.locator("body").evaluate((e) => e.classList.contains("full")));
    const g = await snapshotGeometry(full); assert.equal(g.body.width, g.viewport[0]); await screenshot("full-tab", full); await full.close();
    const detached = await openUI(context, extensionId, "?window=1");
    const d = await snapshotGeometry(detached); assert.equal(d.body.width, d.viewport[0]); await screenshot("window-mode-tab", detached); await detached.close();
    return { full: g, windowMode: d, note: "window=1 page rendering, not native detached window chrome" };
  });
  await test("actual toolbar action popup negotiation", async () => {
    await page.bringToFront();
    const opened = context.waitForEvent("page", { timeout: 5000 });
    await worker.evaluate(() => chrome.action.openPopup());
    let popup;
    try { popup = await opened; } catch { return { skipped: "chrome.action.openPopup was invoked but Playwright did not expose its target; extension-tab rendering does not establish toolbar size negotiation" }; }
    await popup.waitForLoadState(); assert.ok(popup.url().includes("popup.html"));
    await screenshot("toolbar-popup", popup); const g = await snapshotGeometry(popup);
    assert.ok(g.footer.bottom <= g.viewport[1] + 1); return g;
  });
  skip("real provider sign-in, external XHR capture, live quota and Firefox containers", "All external CONNECT requests deliberately denied; synthetic cookie-store path tested instead. No provider-real success claims.");
  skip("cold browser restart recovery", "Worker restart tested; cold profile restart not included in bounded feature pass.");
  await close(context); context = null;
  // Chrome i18n is selected at browser launch, not by replacing chrome.i18n or the page dictionary.
  await test("Russian browser locale labels", async () => {
    const ru = await launch(report.extension, "profile-ru", "ru-RU");
    try {
      const rw = await getWorker(ru); const id = rw.url().split("/")[2];
      const rp = await openUI(ru, id); const locale = await rp.evaluate(() => chrome.i18n.getUILanguage());
      const label = await rp.locator("#settingsBtn").getAttribute("aria-label");
      assert.match(label, /Настройки/); await screenshot("russian", rp); return { locale, label };
    } finally { await close(ru); }
  });
  if (args.package) await test("packaged Chrome extension startup and messaging smoke", async () => {
    const packaged = await snapshotExtension(path.resolve(args.package), "package-snapshot"); const pc = await launch(packaged, "profile-package");
    try {
      const w = await getWorker(pc); const p = await openUI(pc, w.url().split("/")[2]);
      assert.equal(await p.locator("[role=tab]").count(), 8);
      const result = await p.evaluate(() => chrome.runtime.sendMessage({ action: "ping" })); assert.equal(result.ok, true);
      await screenshot("packaged-smoke", p); return { packaged, result };
    } finally { await close(pc); }
  });
  else skip("packaged smoke", "Pass --package <rebuilt Chrome output> after manager finishes build.");
} catch (e) {
  report.blocked = String(e.stack); console.error(report.blocked);
  if (!report.features.length) skip("extension feature pass", "Blocked before UI startup; no cookie, sizing, gateway or provider success is established.");
  if (context) {
    report.pagesAtFailure = context.pages().map((p) => p.url());
    for (const [index, p] of context.pages().entries()) await screenshot(`blocked-page-${index}`, p).catch(() => {});
  }
} finally {
  for (const ctx of [...contexts]) await close(ctx).catch((e) => report.errors.push({ kind: "cleanup", message: String(e) }));
  if (proxy) { report.network = { count: proxy.state.journal.length, deniedConnect: proxy.state.journal.filter((r) => r.method === "CONNECT").length }; await writeJSON("network.json", proxy.state.journal); await proxy.close().catch(() => {}); }
  if (direct) { report.isolation.finalDirectHits = direct.hits; await closeServer(direct.server); }
  report.finishedAt = new Date().toISOString(); report.summary = Object.fromEntries(["pass", "fail", "skipped"].map((s) => [s, report.features.filter((f) => f.status === s).length]));
  report.testHashes = {};
  for (const name of ["test-browser.mjs", "test-browser-fixture.mjs"]) report.testHashes[name] = digest(await fs.readFile(path.join(root, name)));
  report.artifactHashes = {};
  for (const file of report.artifacts) report.artifactHashes[file] = digest(await fs.readFile(file));
  report.artifactHashes[path.join(output, "network.json")] = digest(await fs.readFile(path.join(output, "network.json")).catch(() => Buffer.from("")));
  await writeJSON("feature-results.json", report);
  console.log(JSON.stringify({ output, browser: report.browser, summary: report.summary, blocked: report.blocked || null }));
}
process.exitCode = report.blocked || report.features.some((f) => f.status === "fail") ? 1 : 0;
