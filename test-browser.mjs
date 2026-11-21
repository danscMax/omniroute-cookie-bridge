// Real unpacked-extension verification. No browser API mocks and no forwarding proxy.
// node test-browser.mjs --executable <chromium> --playwright <package-dir> --output <new-dir>
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { fixture, sentinel, closeServer } from "./test-browser-fixture.mjs";

const HELP = `Usage: node test-browser.mjs --executable <chromium> --playwright <package-dir> --output <new-dir>

Required:
  --executable <path>  Already-installed extension-capable Chromium executable.
  --playwright <path>  Already-installed Playwright package directory.
  --output <path>      New directory outside Git; its parent must already exist.
Optional:
  --extension <path>   Runtime source to snapshot (default: this repository).
  --package <path>     Rebuilt Chrome output for an additional packaged smoke.
  --help, -h          Show help without loading Playwright or starting services.

Profiles, snapshots and reports are created only inside the new output directory.
All HTTP responses are synthetic; the proxy never forwards and denies CONNECT.
No existing profile, running browser, real gateway or provider is used.
`;
function parseArgs(argv) {
  const result = {};
  const options = new Set(["executable", "playwright", "output", "extension", "package"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    assert.ok(arg.startsWith("--") && options.has(arg.slice(2)), `Unknown option: ${arg}\n${HELP}`);
    const key = arg.slice(2), value = argv[++i];
    assert.ok(value && !value.startsWith("--"), `Missing value for --${key}`);
    assert.equal(result[key], undefined, `Duplicate --${key}`);
    result[key] = value;
  }
  for (const key of ["executable", "playwright", "output"]) assert.ok(result[key], `Required --${key}\n${HELP}`);
  return result;
}
if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) { console.log(HELP); process.exit(0); }
const args = parseArgs(process.argv.slice(2));
const root = path.dirname(fileURLToPath(import.meta.url));
const outputParent = await fs.realpath(path.dirname(path.resolve(args.output)));
const output = path.join(outputParent, path.basename(path.resolve(args.output)));
// Reports contain synthetic credentials and browser profiles; keep them outside every Git checkout.
for (let current = outputParent; ; current = path.dirname(current)) {
  const marker = await fs.lstat(path.join(current, ".git")).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  assert.ok(!marker, `--output must be outside Git: ${current}`);
  if (path.dirname(current) === current) break;
}
const require = createRequire(import.meta.url);
const pw = require(path.resolve(args.playwright));
const pwVersion = require(path.join(path.resolve(args.playwright), "package.json")).version;
assert.ok(pw.chromium?.launchPersistentContext, "The supplied package must expose Playwright Chromium");
assert.ok((await fs.stat(path.resolve(args.executable))).isFile(), "--executable must name a file");
await fs.mkdir(output); // Refuse an existing output/profile instead of attaching to anything.
const PINNED_REF = "e3c1531afd07d5e06f7ffab658584a7ae2e3627e";
const EXPECTED_COUNTS = { all: 394, web: 37, apikey: 313, oauth: 32, other: 24 };
const PANES = ["dash", "wizard", "web", "key", "oauth", "table", "chat", "catalog", "set"];
const PERPLEXITY_COOKIE = "__Secure-next-auth.session-token";
const report = { startedAt: new Date().toISOString(), invocation: process.argv, playwright: pwVersion, executable: path.resolve(args.executable), extension: path.resolve(args.extension || root), features: [], errors: [], artifacts: [], isolation: {}, sources: [
  "https://github.com/microsoft/playwright/blob/main/docs/src/chrome-extensions-js-python.md",
  "https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md"
] };
let context, proxy, direct, worker, page, extensionId;
const contexts = new Set();
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
function expectedNetworkConsoleError(diagnostic, journal, sentinelOrigin) {
  // Browser resource diagnostics have no JS arguments. Never excuse a console.error()
  // or uncaught exception merely because its text mentions a network failure.
  if (diagnostic.argumentCount !== 0 || !diagnostic.message.startsWith("Failed to load resource:")) return "";
  let url;
  try { url = new URL(diagnostic.location.url); } catch { return ""; }
  if (url.protocol === "https:" && diagnostic.message.includes("net::ERR_TUNNEL_CONNECTION_FAILED")) {
    const authority = `${url.hostname}:${url.port || "443"}`;
    if (journal.some((r) => r.method === "CONNECT" && r.url === authority && r.outcome === "denied-no-forwarding")) return "synthetic CONNECT denial";
  }
  if (url.origin === sentinelOrigin && ["/fixture/page-down", "/fixture/worker-down"].includes(url.pathname)
      && diagnostic.message.includes("net::ERR_PROXY_CONNECTION_FAILED")) return "unavailable preflight proxy";
  const request = journal.findLast((r) => r.method !== "CONNECT" && r.url === url.href);
  if (!request) return "";
  if (["synthetic-disconnect", "synthetic-hang"].includes(request.outcome) && /net::ERR_[A-Z_]+/.test(diagnostic.message)) return request.outcome;
  if (request.mode === "unauthenticated" && request.status === 401
      && /^Failed to load resource: the server responded with a status of 401\b/.test(diagnostic.message)) return "synthetic authentication failure";
  return "";
}
function unexpectedBrowserErrors(errors) {
  return errors.filter((e) => e.kind === "pageerror"
    || (e.kind === "context-console" && ["error", "assert"].includes(e.level) && !e.expected));
}
function observeConsole(message) {
  const level = message.type();
  if (!["error", "warning", "assert"].includes(level)) return;
  const diagnostic = { kind: "context-console", level, location: message.location(), message: message.text(), argumentCount: message.args().length };
  const expected = level === "error" ? expectedNetworkConsoleError(diagnostic, proxy?.state.journal || [], direct?.origin || "") : "";
  if (expected) diagnostic.expected = expected;
  report.errors.push(diagnostic);
}
function observePage(p) {
  p.on("pageerror", (e) => report.errors.push({ kind: "pageerror", url: p.url(), message: String(e) }));
}
async function launch(extension, profile, locale = "en-US") {
  const profilePath = path.join(output, profile);
  await fs.mkdir(profilePath); // Each launch owns a new, empty profile; never reopen a user profile.
  const ctx = await pw.chromium.launchPersistentContext(profilePath, {
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
  ctx.on("console", observeConsole); // Includes page console events without recording each twice.
  return ctx;
}
async function close(ctx) { if (ctx) { await ctx.close(); contexts.delete(ctx); } }
async function getWorker(ctx) {
  return ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 15000 });
}
async function message(action, data = {}, timeout = 22000, target = page) {
  return target.evaluate(({ action, data, timeout }) => new Promise((resolve, reject) => {
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
  // Own the page instead of depending on Worker.evaluate's separate script-loaded gate
  // or selecting an unrelated dashboard from concurrent startup page events.
  const deadline = Date.now() + 10000;
  const remaining = () => {
    const ms = deadline - Date.now();
    assert.ok(ms > 0, `Opening extension UI ${url} exceeded 10000ms`);
    return ms;
  };
  let p, stage = "page creation";
  try {
    const opened = ctx.newPage();
    p = await waitForAsyncResult(`owned extension UI page ${url}`, () => opened, remaining());
    stage = "navigation";
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: remaining() });
    assert.equal(p.url(), url, "Navigate once to the exact installed popup URL");
    stage = "extension identity";
    const identity = p.evaluate(() => ({ id: chrome.runtime.id, url: location.href, popup: chrome.runtime.getURL("popup.html") }));
    assert.deepEqual(await waitForAsyncResult(`extension identity ${id}`, () => identity, remaining()),
      { id, url, popup: `chrome-extension://${id}/popup.html` });
    stage = "background messaging";
    const reply = message("getSettings", {}, 10000, p);
    const received = await waitForAsyncResult(`native background response ${id}`, () => reply, 10000);
    assert.ok(received?.settings && typeof received.settings === "object" && !Array.isArray(received.settings), "Installed background must answer the native settings message");
    stage = "popup readiness";
    await p.waitForFunction(() => document.querySelector("#srvDot")?.classList.contains("ok") || document.querySelector("#srvDot")?.classList.contains("bad"), null, { timeout: 20000 });
    return p;
  } catch (error) {
    const details = { expectedUrl: url, stage, pageUrls: ctx.pages().map((p) => p.url()) };
    throw new Error(`openUI failed: ${JSON.stringify(details)}; ${String(error)}`, { cause: error });
  }
}
async function pane(name) {
  await page.locator(`.rail [data-pane="${name}"]`).click();
  await page.locator(`#pane-${name}`).waitFor({ state: "visible" });
}
async function searchFor(value) {
  await page.locator("#globalSearch").fill(value);
  await page.waitForFunction((value) => ["webSearch", "keySearch", "oauthSearch"].every((id) => document.getElementById(id).value === value), value);
}
async function label(key) {
  const result = await page.evaluate((key) => chrome.i18n.getMessage(key), key);
  assert.ok(result, `Missing action label ${key}`); return result;
}
async function waitForAsyncResult(description, read, timeout = 15000) {
  // waitForFunction checks predicate truthiness before awaiting a returned Promise.
  // Await extension messages/storage reads in the runner, then decide whether to retry.
  const deadline = Date.now() + timeout;
  const timedOut = () => new Error(`Timed out waiting for ${description} (${timeout}ms)`);
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timedOut();
    let timer, result;
    try {
      result = await Promise.race([
        read(remaining),
        new Promise((_, reject) => { timer = setTimeout(() => reject(timedOut()), remaining); }),
      ]);
    } finally { clearTimeout(timer); }
    if (result) return result;
    const delay = Math.min(500, deadline - Date.now());
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
async function submitAndObserve(predicate, action) {
  // Imports are fetched in the dashboard's MAIN world, not the popup page. Observe
  // the context so the assertion sees the actual request without replacing fetch.
  const [response] = await Promise.all([
    context.waitForEvent("response", { predicate, timeout: 10000 }),
    action(),
  ]);
  return response;
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
  const parentDomainCases = [
    { label: "Perplexity", slug: "perplexity-web", url: "https://www.perplexity.ai/", cookie: { name: PERPLEXITY_COOKIE, value: "synthetic-session-one", domain: ".perplexity.ai" }, enumeratedNames: [] },
    { label: "Gemini", slug: "gemini-web", url: "https://gemini.google.com/", cookie: { name: "__Secure-1PSID", value: "synthetic-gemini-session", domain: ".google.com" }, enumeratedNames: ["bridge_fixture_analytics"] },
  ];
  // Seed the fresh profile before popup-triggered discovery. Gemini's host-only
  // noise makes enumeration nonempty without satisfying its required cookie group.
  await context.addCookies([
    ...parentDomainCases.map(({ cookie }) => ({ ...cookie, path: "/", secure: true, httpOnly: true, sameSite: "Lax" })),
    { name: "bridge_fixture_analytics", value: "synthetic-non-session", domain: "gemini.google.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "__client", value: "synthetic-clerk-session", domain: "clerk.agent.adapta.one", path: "/", secure: true, httpOnly: true },
    { name: "next-auth.session-token", value: "synthetic-alternative-session", domain: "app.blackbox.ai", path: "/", secure: true, httpOnly: true },
    { name: "sso", value: "synthetic-incomplete-sso", domain: "grok.com", path: "/", secure: true, httpOnly: true },
    { name: "fixture_admin", value: "synthetic-admin-session", url: "http://127.0.0.1:20128", httpOnly: true, sameSite: "Lax" },
  ]);
  page = await openUI();
  await test("startup messaging, worker and gateway page MAIN-world routing", async () => {
    assert.equal((await message("ping")).ok, true);
    assert.equal((await message("connections")).unreachable, false);
    assert.ok(proxy.state.journal.some((r) => r.url.endsWith("/api/providers") && r.cookie.includes("fixture_admin=")), "MAIN-world request carries synthetic HttpOnly dashboard session");
    return { worker: worker.url(), browser: report.browser, manifest: await worker.evaluate(() => chrome.runtime.getManifest().version) };
  });
  for (const { label, slug, url, cookie, enumeratedNames } of parentDomainCases) await test(`${label} parent-domain discovery after ${enumeratedNames.length ? "nonempty incomplete" : "empty"} native getAll`, async () => {
    const native = await page.evaluate(async ({ slug, url, name, parent }) => {
      const origin = new URL(url).origin + "/*", parentOrigin = `https://${parent}/*`, wildcardOrigin = `https://*.${parent}/*`;
      const [enumerated, named, exactGranted, parentGranted, wildcardGranted] = await Promise.all([
        chrome.cookies.getAll({ url }),
        chrome.cookies.get({ url, name }),
        chrome.permissions.contains({ origins: [origin] }),
        chrome.permissions.contains({ origins: [parentOrigin] }),
        chrome.permissions.contains({ origins: [wildcardOrigin] }),
      ]);
      return { urls: self.OMNI_WEB_MAP[slug].captureUrls, manifest: chrome.runtime.getManifest().host_permissions,
        origin, parentOrigin, wildcardOrigin, enumerated, named, exactGranted, parentGranted, wildcardGranted };
    }, { slug, url, name: cookie.name, parent: cookie.domain.slice(1) });
    const describe = (c) => c && ({ name: c.name, domain: c.domain, path: c.path, hostOnly: c.hostOnly, httpOnly: c.httpOnly, secure: c.secure, storeId: c.storeId });
    const evidence = { provider: slug, url, exactGranted: native.exactGranted, parentGranted: native.parentGranted,
      wildcardGranted: native.wildcardGranted, getAll: native.enumerated.map(describe), get: describe(native.named) };
    report.cookieDiscovery ||= {}; report.cookieDiscovery[slug] = evidence;
    assert.deepEqual(native.urls, [url], `${slug}: query the reviewed capture URL`);
    assert.ok(native.manifest.includes(native.origin), `${slug}: exact host is already declared`);
    assert.equal(native.exactGranted, true, `${slug}: exact host is granted`);
    for (const broad of [native.parentOrigin, native.wildcardOrigin]) assert.equal(native.manifest.includes(broad), false, `${slug}: no parent/wildcard permission`);
    assert.equal(native.parentGranted, false, `${slug}: parent host is not granted`);
    assert.equal(native.wildcardGranted, false, `${slug}: wildcard host is not granted`);
    assert.ok(native.named, `${slug}: native URL-scoped get sees the parent-domain cookie`);
    assert.equal(native.named.value, cookie.value, `${slug}: native get reads the newly seeded synthetic value`);
    assert.equal(native.named.domain, cookie.domain);
    assert.equal(native.named.hostOnly, false);
    assert.equal(native.named.httpOnly, true);
    assert.equal(native.named.secure, true);
    assert.deepEqual(native.enumerated.map((c) => c.name).sort(), enumeratedNames, `${slug}: reproduce the native enumeration gap`);
    assert.equal(native.enumerated.some((c) => c.name === cookie.name), false, `${slug}: getAll omits the required parent-domain cookie`);
    const discovered = await message("getAll", { discover: true });
    assert.ok(discovered.caps[slug], `${slug}: discover the fresh cookie without provider XHR`);
    const key = `cap_${slug}`;
    const capture = await worker.evaluate(async (key) => (await chrome.storage.session.get(key))[key], key);
    assert.equal(capture?.cookie, `${cookie.name}=${cookie.value}`, `${slug}: capture the required credential without unrelated enumeration cookies`);
    assert.equal(capture.storeId, native.named.storeId);
    assert.equal(capture.cookieContext, "", `${slug}: preserve the default unpartitioned context`);
    assert.equal(discovered.caps[slug].cookie, undefined, `${slug}: UI summary omits the credential`);
    return evidence;
  });
  await test("existing HttpOnly cookies use reviewed request hosts and complete groups", async () => {
    const r = await message("getAll", { discover: true });
    for (const slug of ["perplexity-web", "adapta-web", "blackbox-web"]) assert.ok(r.caps[slug], `${slug} discovered without provider XHR`);
    assert.equal(r.caps["grok-web"], null, "sso alone does not satisfy the sso AND sso-rw contract");
    assert.equal(JSON.stringify(r).includes("synthetic-"), false, "UI summaries never contain synthetic cookie values");
    const meta = await page.evaluate(() => ({ clerk: self.OMNI_WEB_MAP["adapta-web"], named: self.OMNI_WEB_MAP["perplexity-web"].cred.name }));
    assert.notEqual(new URL(meta.clerk.site).hostname, new URL(meta.clerk.captureUrls[0]).hostname, "Clerk capture is not inferred from the homepage");
    assert.equal(meta.named, PERPLEXITY_COOKIE);
    await context.addCookies([{ name: "sso-rw", value: "synthetic-complete-sso", domain: "grok.com", path: "/", secure: true, httpOnly: true }]);
    await restartWorker();
    const complete = await message("getAll", { discover: true });
    assert.ok(complete.caps["grok-web"], "both required cookies form a complete session");
    return { discovered: ["perplexity-web", "adapta-web", "blackbox-web", "grok-web"], namedCookie: meta.named };
  });
  await test("capture permissions cover reviewed request hosts and their initiators", async () => {
    const permissions = await page.evaluate(async () => ({
      installed: chrome.runtime.getManifest().host_permissions,
      providers: await Promise.all(self.OMNI_WEB.map(async (p) => ({
        slug: p.slug, capture: p.cred.t, site: p.site, urls: p.captureUrls, perms: p.perms,
        requestsMatch: p.captureUrls.every((url) => p.hostRe.test(url)),
        homepageMatches: p.hostRe.test(p.site),
        granted: p.perms.length ? await chrome.permissions.contains({ origins: p.perms }) : false,
      }))),
    }));
    let reviewed = 0, distinctInitiators = 0;
    for (const p of permissions.providers) {
      if (p.capture === "dashboard") {
        assert.deepEqual(p.urls, [], `${p.slug}: no automatic capture URLs`);
        assert.deepEqual(p.perms, [], `${p.slug}: no capture permissions`);
        assert.equal(p.homepageMatches, false, `${p.slug}: homepage is not a capture target`);
        continue;
      }
      reviewed++;
      assert.ok(p.urls.length, `${p.slug}: reviewed request URLs`);
      const origins = [...new Set([...p.urls, p.site].map((url) => new URL(url).origin + "/*"))].sort();
      assert.deepEqual(p.perms, origins, `${p.slug}: exact request and initiator permissions`);
      assert.ok(p.perms.every((permission) => permissions.installed.includes(permission)), p.slug);
      assert.equal(p.granted, true, `${p.slug}: Chromium granted the declared hosts`);
      assert.equal(p.requestsMatch, true, `${p.slug}: capture matcher covers every reviewed request URL`);
      if (!p.urls.some((url) => new URL(url).hostname === new URL(p.site).hostname)) {
        distinctInitiators++;
        assert.equal(p.homepageMatches, false, `${p.slug}: initiator permission does not widen the request matcher`);
      }
    }
    assert.ok(reviewed > 0 && distinctInitiators > 0);
    return { reviewed, distinctInitiators, note: "Permission/matcher checks; authenticated external XHR delivery remains skipped." };
  });
  await test("all nine panes and accessible rail", async () => {
    const labels = [];
    assert.equal(await page.locator(".rail [role=tab]").count(), PANES.length);
    for (const name of PANES) {
      await pane(name); const tab = page.locator(`.rail [data-pane="${name}"]`);
      assert.equal(await tab.getAttribute("aria-selected"), "true");
      assert.ok(await tab.getAttribute("aria-label")); labels.push(await tab.getAttribute("aria-label"));
      await screenshot(`pane-${name}`);
    }
    assert.equal(await page.locator(".pane:not(.hide)").count(), 1); return labels;
  });
  await test("pinned all-provider directory has exact sets, category filters and source guidance", async () => {
    await pane("catalog"); await searchFor("");
    await page.locator("#catalogCategory").selectOption("");
    const catalog = await page.evaluate(() => ({ ref: self.OMNI_GEN.provenance.ref, counts: Object.fromEntries(["all", "web", "apikey", "oauth", "other"].map((k) => [k, self.OMNI_GEN[k].length])), rows: self.OMNI_CATALOG.map((p) => ({ slug: p.slug, category: p.category })), search: self.OMNI_CATALOG_MAP["google-pse-search"] }));
    assert.equal(catalog.ref, PINNED_REF); assert.deepEqual(catalog.counts, EXPECTED_COUNTS);
    const slugs = await page.locator("#catalogList > .directory-entry").evaluateAll((entries) => entries.map((e) => e.dataset.slug));
    assert.deepEqual(slugs.slice().sort(), catalog.rows.map((p) => p.slug).sort());
    assert.equal(new Set(slugs).size, EXPECTED_COUNTS.all);
    assert.equal(await page.locator("#catalogCount").innerText(), `${catalog.rows.length}/${catalog.rows.length}`);
    assert.match(await page.locator("#catalogSource").innerText(), new RegExp(PINNED_REF.slice(0, 12)));
    const categories = [...new Set(catalog.rows.map((p) => p.category))].sort();
    assert.deepEqual((await page.locator("#catalogCategory option").evaluateAll((entries) => entries.map((e) => e.value))).sort(), ["", ...categories].sort());
    for (const category of categories) {
      await page.locator("#catalogCategory").selectOption(category);
      const expected = catalog.rows.filter((p) => p.category === category).map((p) => p.slug).sort();
      assert.deepEqual((await page.locator("#catalogList > .directory-entry").evaluateAll((entries) => entries.map((e) => e.dataset.slug))).sort(), expected, category);
    }
    await page.locator("#catalogCategory").selectOption(""); await searchFor("google-pse-search");
    const entry = page.locator('#catalogList > .directory-entry[data-slug="google-pse-search"]');
    await entry.locator("summary").click(); await entry.locator(".directory-body").waitFor();
    for (const field of ["authHint", "apiHint", "notice", "freeNote"]) if (catalog.search[field]) assert.ok((await entry.locator(".provider-guidance").innerText()).includes(catalog.search[field]), field);
    const sourceUrl = `https://github.com/diegosouzapw/OmniRoute/blob/${PINNED_REF}/${catalog.search.source.file}#L${catalog.search.source.line}`;
    assert.equal(await entry.locator(".source-link").getAttribute("href"), sourceUrl);
    assert.equal(await entry.locator(".source-link").getAttribute("rel"), "noopener noreferrer");
    await screenshot("catalog-source-guidance");
    await searchFor("chatgpt-web");
    const manual = page.locator('#catalogList > .directory-entry[data-slug="chatgpt-web"]');
    await manual.locator("summary").click(); await manual.locator(".directory-body").waitFor();
    const actions = manual.locator(":scope > .directory-body > .setup-actions button");
    assert.equal(await actions.count(), 1, "manual web setup offers only the dashboard action");
    assert.equal(await actions.innerText(), await label("oauth_inDashboard"));
    await searchFor(""); return { counts: catalog.counts, categories, sourceUrl };
  });
  await test("global search filters web, API-key, OAuth and directory panes", async () => {
    await pane("web"); await searchFor("definitely-no-fixture-provider");
    for (const name of ["web", "key", "oauth"]) { await pane(name); assert.equal(await page.locator(`#${name}Search`).inputValue(), "definitely-no-fixture-provider"); }
    assert.equal(await page.locator("#keyList .keyrow").count(), 0);
    assert.equal(await page.locator("#oauthList .card").count(), 0);
    await pane("catalog"); assert.equal(await page.locator("#catalogList > .directory-entry").count(), 0);
    assert.equal(await page.locator("#catalogCount").innerText(), `0/${EXPECTED_COUNTS.all}`);
    await searchFor("openai"); await pane("key"); await page.locator("#keyList .keyrow").first().waitFor();
    await searchFor("");
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
  await test("parent-domain chunked Perplexity cookies are reconstructed and imported", async () => {
    const slug = "perplexity-web", url = "https://www.perplexity.ai/", domain = ".perplexity.ai";
    const original = { name: PERPLEXITY_COOKIE, value: "synthetic-session-one", domain, path: "/", secure: true, httpOnly: true, sameSite: "Lax" };
    const chunks = [
      { name: `${PERPLEXITY_COOKIE}.0`, value: "synthetic-chunked-" },
      { name: `${PERPLEXITY_COOKIE}.1`, value: "perplexity-session" },
    ];
    const chunkNames = chunks.map((c) => c.name), combined = chunks.map((c) => c.value).join("");
    const networkStart = proxy.state.journal.length;
    let connectionId;
    try {
      await context.clearCookies({ name: PERPLEXITY_COOKIE, domain });
      await context.addCookies(chunks.map((cookie) => ({ ...original, ...cookie })));
      const native = await worker.evaluate(async ({ url, domain, name, chunks }) => {
        const [enumerated, whole, ...named] = await Promise.all([
          chrome.cookies.getAll({ url }), chrome.cookies.get({ url, name }),
          ...chunks.map(({ name }) => chrome.cookies.get({ url, name })),
        ]);
        return { getAllNames: enumerated.map((c) => c.name).sort(), wholeAbsent: whole === null,
          namedChunkNames: named.map((c) => c?.name || ""),
          namedChunksMatch: named.every((c, i) => c?.value === chunks[i].value && c.domain === domain
            && c.hostOnly === false && c.path === "/" && c.secure && c.httpOnly && c.storeId === named[0]?.storeId),
          storeId: named[0]?.storeId,
          unpartitioned: named.every((c) => !!c && !c.firstPartyDomain && !Object.keys(c.partitionKey || {}).length) };
      }, { url, domain, name: PERPLEXITY_COOKIE, chunks });
      assert.equal(native.wholeAbsent, true, "The canonical whole cookie must be absent during chunk discovery");
      assert.equal(native.getAllNames.some((name) => name === PERPLEXITY_COOKIE || chunkNames.includes(name)), false, "Native enumeration must hide both parent-domain chunks");
      assert.deepEqual(native.namedChunkNames, chunkNames);
      assert.equal(native.namedChunksMatch, true, "Native named reads must return the fresh parent-domain chunks in one store");
      assert.equal(native.unpartitioned, true);
      const refresh = await message("refreshSessions", { keys: [slug] });
      assert.equal(refresh.results?.[slug]?.state, "ok");
      const imported = proxy.state.connections.filter((c) => c.provider === slug);
      assert.equal(imported.length, 1, "The real worker import must leave exactly one Perplexity connection");
      assert.equal(imported[0].apiKey, combined, "The import receives the complete numeric-order named value");
      connectionId = imported[0].id;
      assert.ok(connectionId, "The imported connection must have a remembered account ID");
      const captured = await worker.evaluate(async (key) => (await chrome.storage.session.get(key))[key], `cap_${slug}`);
      assert.equal(captured?.cookie, chunks.map((c) => `${c.name}=${c.value}`).join("; "), "The stored capture retains the exact chunk header");
      assert.equal(captured.cookieCount, 2);
      assert.equal(captured.cookieContext, "");
      assert.equal(captured.storeId, native.storeId);
      const summary = await message("getAll");
      assert.ok(summary.caps[slug]);
      assert.equal(summary.caps[slug].cookieCount, 2);
      assert.equal(summary.caps[slug].cookie, undefined);
      for (const value of [original.value, ...chunks.map((c) => c.value)]) assert.equal(JSON.stringify(summary).includes(value), false, "UI summaries exclude synthetic cookie values");
      assert.equal(proxy.state.journal.slice(networkStart).some((r) => {
        const host = new URL(r.method === "CONNECT" ? `https://${r.url}` : r.url).hostname;
        return host === "perplexity.ai" || host.endsWith(".perplexity.ai");
      }), false, "Chunked cookie-store import must not request the provider");
    } finally {
      for (const { name } of chunks) await context.clearCookies({ name, domain });
      await context.addCookies([original]);
    }
    const nativeRestored = await worker.evaluate(async ({ url, original, chunkNames }) => {
      const [whole, ...parts] = await Promise.all([
        chrome.cookies.get({ url, name: original.name }), ...chunkNames.map((name) => chrome.cookies.get({ url, name })),
      ]);
      return whole?.value === original.value && whole.domain === original.domain && whole.hostOnly === false && parts.every((c) => c === null);
    }, { url, original: { name: original.name, value: original.value, domain }, chunkNames });
    assert.equal(nativeRestored, true, "Restore the native whole synthetic-session-one cookie and remove both chunks");
    const restored = await message("refreshSessions", { keys: [slug] });
    assert.equal(restored.results[slug].state, "ok");
    assert.equal(restored.results[slug].updated, true);
    const connections = proxy.state.connections.filter((c) => c.provider === slug);
    assert.equal(connections.length, 1);
    assert.equal(connections[0].id, connectionId, "Restoring the whole cookie updates the same remembered account slot");
    assert.equal(connections[0].apiKey, original.value);
    return { chunks: chunkNames, connectionId, restored: true };
  });
  await test("cookie-store refresh sends the named value, updates its slot and preserves foreign accounts", async () => {
    const refresh = await message("refreshSessions", { keys: ["perplexity-web"] });
    assert.equal(refresh.results["perplexity-web"].state, "ok");
    const mine = proxy.state.connections.find((c) => c.provider === "perplexity-web"); assert.ok(mine);
    assert.equal(mine.apiKey, "synthetic-session-one", "named-value recipe must not send a Cookie header");
    const foreign = proxy.state.create({ provider: "perplexity-web", name: "Foreign synthetic account", apiKey: "synthetic-foreign-session" });
    await context.addCookies([{ name: PERPLEXITY_COOKIE, value: "synthetic-session-two", domain: ".perplexity.ai", path: "/", secure: true, httpOnly: true }]);
    const again = await message("refreshSessions", { keys: ["perplexity-web"] });
    assert.equal(again.results["perplexity-web"].updated, true);
    assert.equal(proxy.state.connections.filter((c) => c.provider === "perplexity-web").length, 2);
    assert.equal(mine.apiKey, "synthetic-session-two"); assert.equal(foreign.apiKey, "synthetic-foreign-session");
    const cap = (await message("getAll")).caps["perplexity-web"]; assert.ok(cap); assert.equal(cap.cookie, undefined);
    return again;
  });
  await test("API key form add and same-key update", async () => {
    await pane("key"); await searchFor("openai");
    const row = page.locator("#keyList .keyrow").filter({ has: page.locator(".kname", { hasText: /^OpenAI$/ }) });
    await row.locator(".keyrow-h").click();
    await row.locator('input[type="password"]').fill("synthetic-api-key-one");
    await row.locator(".actions button").first().click(); await row.locator(".res.ok").waitFor();
    const c = proxy.state.connections.find((x) => x.provider === "openai"); assert.ok(c);
    const n = proxy.state.connections.filter((x) => x.provider === "openai").length;
    assert.equal((await message("addApiKey", { slug: "openai", apiKey: "synthetic-api-key-one" })).ok, true);
    assert.equal(proxy.state.connections.filter((x) => x.provider === "openai").length, n);
  });
  await test("PSE and Cloudflare forms require and forward their source-backed extra fields", async () => {
    await pane("key");
    for (const [slug, field] of [["google-pse-search", "cx"], ["cloudflare-ai", "accountId"]]) {
      await searchFor(slug); await page.locator("#keyList .keyrow-h").click();
      const form = page.locator("#keyList .keyform");
      await form.locator('input[type="password"]').fill(`synthetic-${slug}-key`);
      const before = proxy.state.journal.filter((r) => r.method === "POST").length;
      await form.locator(".actions button").first().click(); await form.locator(".res.bad").waitFor();
      assert.equal(proxy.state.journal.filter((r) => r.method === "POST").length, before, `${slug} must reject incomplete input locally`);
      const extra = await page.evaluate(({ slug, field }) => self.OMNI_APIKEY_MAP[slug].extra.find((x) => x.key === field).label, { slug, field });
      await form.getByPlaceholder(extra, { exact: false }).fill(`synthetic-${field}`);
      if (slug === "google-pse-search") assert.equal(await form.locator("textarea").count(), 0, "PSE is excluded from upstream bulk import");
      const posted = await submitAndObserve(
        (r) => r.url() === "http://127.0.0.1:20128/api/providers" && r.request().method() === "POST" && r.request().postDataJSON()?.provider === slug,
        () => form.locator(".actions button").first().click(),
      );
      assert.equal(posted.status(), 201);
      assert.equal(proxy.state.connections.find((c) => c.provider === slug)?.providerSpecificData?.[field], `synthetic-${field}`);
      await page.waitForFunction(() => document.querySelector("#keyList .keyform .actions button")?.disabled === false);
    }
    const before = proxy.state.journal.filter((r) => r.method === "POST").length;
    assert.equal((await message("bulkAddApiKey", { slug: "google-pse-search", keys: ["synthetic-pse-key"], psd: { cx: "synthetic-cx" } })).ok, false);
    assert.equal((await message("bulkAddApiKey", { slug: "cloudflare-ai", keys: ["synthetic-cf-key"] })).ok, false);
    assert.equal(proxy.state.journal.filter((r) => r.method === "POST").length, before);
    const result = await message("bulkAddApiKey", { slug: "cloudflare-ai", keys: ["short", "synthetic-cf-bulk"], psd: { accountId: "synthetic-routing-account" } });
    assert.equal(result.added, 2);
    const body = proxy.state.journal.filter((r) => r.url.endsWith("/api/providers/bulk")).at(-1).body;
    assert.equal(body.providerSpecificData.accountId, "synthetic-routing-account");
    assert.deepEqual(body.entries.map((e) => e.accountId), ["synthetic-routing-account", "synthetic-routing-account"]);
    await searchFor("");
  });
  for (const mode of ["success", "partial", "failure"]) await test(`bulk API keys: ${mode} result is honest`, async () => {
    proxy.state.bulk = mode;
    const r = await message("bulkAddApiKey", { slug: "openai", keys: ["synthetic-bulk-one", "synthetic-bulk-two"] });
    const expected = mode === "success" ? 2 : mode === "partial" ? 1 : 0;
    assert.equal(r.added, expected, `Expected ${expected} actual additions, got ${JSON.stringify(r)}`);
    assert.equal(r.ok, mode === "success"); assert.equal(r.failed, 2 - expected); return r;
  });
  proxy.state.bulk = "success";
  await test("models, chat, probe and health sweep through synthetic worker requests", async () => {
    const models = await message("models"); assert.ok(models.models.some((m) => m.id === "openai/fixture-model"));
    const chat = await message("chat", { model: "openai/fixture-model", messages: [{ role: "user", content: "Synthetic test only" }] }); assert.equal(chat.text, "Synthetic fixture reply");
    assert.equal((await message("probe", { slug: "openai" })).alive, true);
    assert.equal((await message("sweepNow")).ok, true); assert.ok((await message("getProbes")).probes.openai);
    await message("clearProbes"); assert.equal(Object.keys((await message("getProbes")).probes).length, 0);
  });
  await test("OAuth device Connect action, slow_down backoff and cancel", async () => {
    await pane("oauth"); await searchFor("github"); proxy.state.oauthPoll = "slow_down";
    const card = page.locator('#oauthList .card[data-slug="github"]');
    await card.getByRole("button", { name: await label("oauth_connect"), exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#oauthList [data-slug="github"] .code')?.textContent === "TEST-ONLY", null, { timeout: 8000 });
    const r = await message("oauthState"); assert.equal(r.states.github.interval, 10);
    const n = proxy.state.journal.filter((j) => j.url.endsWith("/github/poll")).length;
    await message("oauthState"); await message("oauthState");
    assert.equal(proxy.state.journal.filter((j) => j.url.endsWith("/github/poll")).length, n);
    await card.locator(".cancel").click(); assert.equal((await message("oauthState")).states.github, undefined);
    await searchFor("");
  });
  await test("device success has an id and callback POST completes same-account re-auth without roster growth", async () => {
    proxy.state.oauthPoll = "success"; assert.equal((await message("oauthStart", { provider: "github" })).ok, true);
    const device = (await message("oauthState")).states.github;
    assert.equal(device.status, "success"); assert.equal(device.connId, proxy.state.connections.find((c) => c.provider === "github").id);
    await message("oauthCancel", { provider: "github" });
    const account = proxy.state.create({ provider: "codex", name: "Synthetic callback re-auth account" });
    const before = proxy.state.connections.filter((c) => c.provider === "codex").length;
    assert.equal((await message("oauthConnect", { provider: "codex" })).ok, true);
    assert.equal((await message("oauthState")).states.codex.status, "pending", "an existing account and the synthetic auth page are not success");
    const start = proxy.state.journal.findLastIndex((r) => r.url.endsWith("/codex/start-callback-server"));
    proxy.state.completeCallback("codex", { connectionId: account.id });
    assert.equal(proxy.state.connections.filter((c) => c.provider === "codex").length, before, "callback receipt only stores parameters");
    const result = await waitForAsyncResult("Codex callback success", async (remaining) => {
      const s = (await message("oauthState", {}, remaining)).states?.codex;
      return s?.status === "success" ? s : false;
    });
    assert.equal(result.connId, account.id); assert.equal(proxy.state.connections.filter((c) => c.provider === "codex").length, before);
    const polls = proxy.state.journal.slice(start).filter((r) => r.url.endsWith("/codex/poll-callback"));
    assert.ok(polls.length >= 2, "pending and consuming POSTs both reached the synthetic route");
    for (const poll of polls) { assert.equal(poll.method, "POST"); assert.deepEqual(poll.body, {}); assert.match(poll.contentType, /application\/json/); assert.match(poll.cookie, /fixture_admin=/); }
    assert.equal(polls.at(-1).connectionId, account.id); assert.equal(proxy.state.callbacks.has("codex"), false);
    await message("oauthCancel", { provider: "codex" }); return { id: result.connId, connectionCount: before, callbackPosts: polls.length };
  });
  await test("missing callback server is a terminal result, not successful roster detection", async () => {
    assert.equal((await message("oauthConnect", { provider: "codex" })).ok, true);
    proxy.state.callbacks.delete("codex");
    const result = await waitForAsyncResult("missing callback server error", async (remaining) => {
      const s = (await message("oauthState", {}, remaining)).states?.codex;
      return s?.status === "error" ? s : false;
    });
    assert.match(result.detail, /no_server/);
    await message("oauthCancel", { provider: "codex" });
  });
  await test("inline raw-token import uses Devin CLI; dashboard-only actions forward no credentials", async () => {
    await pane("oauth"); await searchFor("devin-cli");
    const card = page.locator('#oauthList .card[data-slug="devin-cli"]');
    await card.locator('input[type="password"]').fill("synthetic-token-manual");
    const importButton = card.getByRole("button", { name: await label("oauth_import"), exact: true });
    const posted = await submitAndObserve(
      (r) => r.url().endsWith("/api/oauth/devin-cli/import-token") && r.request().method() === "POST",
      () => importButton.click(),
    );
    assert.equal(posted.status(), 200);
    assert.equal(proxy.state.connections.find((c) => c.provider === "devin-cli")?.token, "synthetic-token-manual");
    await page.waitForFunction(() => {
      const input = document.querySelector('#oauthList .card[data-slug="devin-cli"] input[type="password"]');
      return input && input.value === "";
    });
    await searchFor("cursor");
    const cursor = page.locator('#oauthList .card[data-slug="cursor"]');
    assert.equal(await cursor.locator('input[type="password"]').count(), 0);
    assert.equal(await cursor.getByRole("button", { name: await label("oauth_inDashboard"), exact: true }).count(), 1);
    const before = proxy.state.journal.length, pages = context.pages().length;
    for (const [action, data] of [
      ["oauthImport", { provider: "cursor", token: "synthetic-must-not-send" }],
      ["oauthAutoImport", { provider: "cursor" }],
      ["oauthAutoImport", { provider: "devin-cli" }],
      ["oauthImport", { provider: "devin-cli", token: "omniroute-cred-v1.synthetic-only" }],
      ["send", { providerKey: "chatgpt-web" }],
      ["addApiKey", { slug: "azure-openai", apiKey: "synthetic-must-not-send" }],
    ]) { const result = await message(action, data); assert.equal(result.ok, false, action); assert.equal(result.dashboardOnly, true, action); }
    assert.equal(proxy.state.journal.slice(before).filter((r) => ["POST", "PATCH"].includes(r.method) || /\/api\/oauth\//.test(r.url)).length, 0);
    assert.equal(context.pages().length, pages, "blocked worker actions do not open login tabs");
    const dashboardButton = cursor.getByRole("button", { name: await label("oauth_inDashboard"), exact: true });
    const [dashboard] = await Promise.all([
      context.waitForEvent("page", { timeout: 10000 }),
      dashboardButton.click(),
    ]);
    try {
      await dashboard.waitForURL("http://127.0.0.1:20128/dashboard/providers/cursor");
      assert.equal(proxy.state.journal.slice(before).filter((r) => /\/api\/oauth\/cursor\//.test(r.url)).length, 0, "dashboard handoff does not attempt unsupported import endpoints");
    } finally { await dashboard.close(); }
    await page.bringToFront();
    await searchFor("");
  });
  for (const mode of ["partial", "failure"]) await test(`OAuth ZIP ${mode} result is honest`, async () => {
    proxy.state.zip = mode;
    const r = await message("zipImport", { provider: "claude", b64: Buffer.from("synthetic archive bytes, fixture extraction only").toString("base64") });
    assert.equal(r.added, mode === "partial" ? 1 : 0, JSON.stringify(r)); assert.equal(r.ok, false); assert.equal(r.failed, mode === "partial" ? 1 : 2); return r;
  });
  await test("settings, export without secrets, roster import and management confirmation", async () => {
    await refreshUI(); await pane("set"); await page.locator("#setNotify").check();
    assert.equal((await message("getSettings")).settings.notify, true);
    const downloaded = page.waitForEvent("download"); await page.locator("#exportBtn").click();
    const download = await downloaded, file = path.join(output, "synthetic-roster.json"); await download.saveAs(file);
    report.artifacts.push(file); const text = await fs.readFile(file, "utf8");
    for (const secret of ["synthetic-session-two", "synthetic-api-key-one", "synthetic-token-manual"]) assert.ok(!text.includes(secret));
    await page.locator("#importFile").setInputFiles({ name: "synthetic-import.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ connections: [{ provider: "gemini" }] })) });
    await waitForAsyncResult("imported Gemini wizard selection", () => page.evaluate(async () =>
      (await chrome.storage.local.get("wiz_import")).wiz_import?.includes("gemini")), 8000);
    await pane("table"); await page.locator(".manage-head").click();
    const row = page.locator("#manageSection .prob").filter({ hasText: "Synthetic callback re-auth account" });
    const name = await row.locator(".prob-name").innerText(); const id = proxy.state.connections.find((c) => c.name === name).id;
    const del = row.locator("button.danger"); await del.click(); assert.ok(proxy.state.connections.some((c) => c.id === id));
    await del.click(); await page.waitForFunction((n) => ![...document.querySelectorAll("#manageSection .prob-name")].some((e) => e.textContent === n), name);
    assert.ok(!proxy.state.connections.some((c) => c.id === id));
  });
  await test("worker restart retains settings and captures; disabling persistence purges disk", async () => {
    const r = await restartWorker(); assert.equal(r.settings.notify, true); assert.ok((await message("getAll")).caps["perplexity-web"]);
    await message("setSettings", { settings: { persistSessions: false } });
    assert.equal((await worker.evaluate(() => chrome.storage.local.get("cap_perplexity-web")))["cap_perplexity-web"], undefined);
    assert.ok((await message("getAll")).caps["perplexity-web"]); await message("clear", { providerKey: "perplexity-web" });
  });
  for (const mode of ["unauthenticated", "wrong", "offline"]) await test(`gateway ${mode}: no green success or credential writes`, async () => {
    proxy.state.mode = mode; await restartWorker();
    const ping = await message("ping", {}, 16000), start = proxy.state.journal.length;
    const add = await message("addApiKey", { slug: "openai", apiKey: "synthetic-must-not-write" }, 16000);
    assert.equal(add.ok, false, `Credential add must fail: ${JSON.stringify(add)}`);
    assert.equal(proxy.state.journal.slice(start).filter((r) => r.method === "POST").length, 0);
    assert.equal(ping.ok, false); if (mode === "unauthenticated") assert.equal(ping.state, "unauthenticated");
    return { ping, add };
  });
  proxy.state.mode = "online"; await restartWorker();
  await test("hung gateway ping has a bounded response", async () => {
    proxy.state.mode = "hanging"; const t = Date.now();
    try { const r = await message("ping", {}, 16000); assert.equal(r.ok, false); return { elapsed: Date.now() - t, result: r }; }
    finally { proxy.state.mode = "online"; proxy.server.closeAllConnections(); }
  });
  await test("full-tab and detached-window rendering", async () => {
    const full = await openUI(context, extensionId, "?full=1"); assert.ok(await full.locator("body").evaluate((e) => e.classList.contains("full")));
    const g = await snapshotGeometry(full); assert.equal(g.body.width, g.viewport[0]); await screenshot("full-tab", full); await full.close();
    const detached = await openUI(context, extensionId, "?window=1");
    const d = await snapshotGeometry(detached); assert.equal(d.body.width, d.viewport[0]); await screenshot("window-mode-tab", detached); await detached.close();
    return { full: g, windowMode: d, note: "window=1 page rendering, not native detached window chrome" };
  });
  await test("actual toolbar action popup negotiation", async () => {
    await page.bringToFront();
    const opened = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
    await worker.evaluate(() => chrome.action.openPopup());
    const popup = await opened;
    if (!popup) return { skipped: "chrome.action.openPopup was invoked but Playwright did not expose its target; extension-tab rendering does not establish toolbar size negotiation" };
    await popup.waitForLoadState(); assert.ok(popup.url().includes("popup.html"));
    await screenshot("toolbar-popup", popup); const g = await snapshotGeometry(popup);
    assert.ok(g.footer.bottom <= g.viewport[1] + 1); return g;
  });
  skip("real provider sign-in, external XHR capture, live quota and Firefox containers", "All external CONNECT requests deliberately denied; synthetic cookie-store and OAuth route contracts tested instead. No live-provider success claims.");
  skip("cold browser restart recovery", "Worker restart tested; cold profile restart not included in bounded feature pass.");
  await close(context); context = null;
  // Chrome i18n is selected at browser launch, not by replacing chrome.i18n or the page dictionary.
  await test("Russian browser locale labels", async () => {
    const ru = await launch(report.extension, "profile-ru", "ru-RU");
    try {
      const rw = await getWorker(ru); const id = rw.url().split("/")[2];
      const rp = await openUI(ru, id); const locale = await rp.evaluate(() => chrome.i18n.getUILanguage());
      const text = await rp.locator("#settingsBtn").getAttribute("aria-label");
      assert.match(text, /Настройки/); await screenshot("russian", rp); return { locale, label: text };
    } finally { await close(ru); }
  });
  if (args.package) await test("packaged Chrome extension has nine panes, the full catalog and working messaging", async () => {
    const packaged = await snapshotExtension(path.resolve(args.package), "package-snapshot"); const pc = await launch(packaged, "profile-package");
    try {
      const w = await getWorker(pc); const p = await openUI(pc, w.url().split("/")[2]);
      assert.equal(await p.locator(".rail [role=tab]").count(), PANES.length);
      const result = await p.evaluate(() => chrome.runtime.sendMessage({ action: "ping" })); assert.equal(result.ok, true);
      await p.locator('.rail [data-pane="catalog"]').click();
      assert.equal(await p.locator("#catalogList > .directory-entry").count(), EXPECTED_COUNTS.all);
      assert.equal(await p.evaluate(() => self.OMNI_GEN.provenance.ref), PINNED_REF);
      await screenshot("packaged-smoke", p); return { packaged, result };
    } finally { await close(pc); }
  });
  else skip("packaged smoke", "Pass --package <rebuilt Chrome output> to test packaged bytes.");
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
  if (direct) {
    report.isolation.finalDirectHits = direct.hits; await closeServer(direct.server);
    if (direct.hits.length) { report.isolation.pass = false; report.blocked = "Direct sentinel traffic detected during the run"; }
  }
  // Run after closing every context so late page/console failures also affect the exit status.
  await test("browser contexts have no unexpected JavaScript errors", async () => {
    assert.deepEqual(unexpectedBrowserErrors(report.errors), [], "Uncaught page exceptions or unexpected console errors were recorded");
    return { expectedNetworkDiagnostics: report.errors.filter((e) => e.expected).length,
      warnings: report.errors.filter((e) => e.level === "warning").length };
  });
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
