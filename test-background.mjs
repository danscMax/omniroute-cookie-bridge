// Behaviour tests for the REAL background.js (service worker) under a stubbed browser.
// `node --check` proves it parses; test-render proves the popup boots. Neither covers the riskiest
// code in the extension: capturing secrets, mirroring them to disk, and re-pushing them on startup.
// This suite loads the shipped background.js and FIRES its real listeners. Run: `npm run test:bg`.
import assert from "node:assert/strict";
import { makeChrome, makeSandbox, runFiles, tick } from "./test-harness.mjs";

// ── boot the real SW ────────────────────────────────────────────────────────
// `dash` lets a test answer each runInDash injection by the injected function's NAME, which is how the
// SW talks to the dashboard tab (chrome.scripting.executeScript with `func`).
function boot({ dash = {}, settings, fetch } = {}) {
  const chrome = makeChrome();
  chrome.scripting.executeScript = ({ func, args }) => {
    const reply = dash[func.name];
    return Promise.resolve([{ result: typeof reply === "function" ? reply(...(args || [])) : (reply ?? { ok: true }) }]);
  };
  if (settings) chrome.storage.local.set({ settings });
  // No importScripts in node → CAN_DIRECT_FETCH is false → the SW behaves like Firefox (tab path). A test
  // can pass a hanging `fetch` to prove the direct path is never awaited in that mode.
  const sandbox = makeSandbox({ chrome, extra: fetch ? { fetch } : {} });
  const errors = runFiles(sandbox, ["providers.gen.js", "providers.js", "background.js"]);
  assert.deepEqual(errors, [], `background.js load errors: ${JSON.stringify(errors)}`);
  return { chrome, sandbox };
}

// A realistic captured request for a web provider (the SW reads the Cookie header off an XHR).
function xhr(url, cookie, extra = []) {
  return { url, requestHeaders: [{ name: "Cookie", value: cookie }, ...extra] };
}
const fireCapture = (chrome, req) => chrome._listeners.webRequest[0](req);
const capsIn = (store) => Object.keys(store._dump()).filter((k) => k.startsWith("cap_"));

// ── 1. capture lands in session, and is mirrored to disk when persistSessions is on ─────────────
{
  const { chrome } = boot();
  fireCapture(chrome, xhr("https://claude.ai/backend-api/conversation", "session=abc123; other=1"));
  await tick();
  assert.deepEqual(capsIn(chrome.storage.session), ["cap_claude-web"], "capture stored in session");
  assert.deepEqual(capsIn(chrome.storage.local), ["cap_claude-web"], "capture MIRRORED to disk (persistSessions default on)");
  const disk = chrome.storage.local._dump()["cap_claude-web"];
  assert.equal(disk.cookie, "session=abc123; other=1", "disk copy carries the credential");
  assert.ok(disk.accountId, "disk copy carries a stable accountId");
}

// ── 2. persistSessions OFF → nothing is written to disk ─────────────────────────────────────────
{
  const { chrome } = boot({ settings: { sweep: true, sweepMin: 15, notify: true, theme: "auto", persistSessions: false } });
  fireCapture(chrome, xhr("https://claude.ai/x", "session=abc"));
  await tick();
  assert.deepEqual(capsIn(chrome.storage.session), ["cap_claude-web"], "capture still kept in memory");
  assert.deepEqual(capsIn(chrome.storage.local), [], "NOTHING mirrored to disk when the toggle is off");
}

// ── 3. turning persistSessions OFF purges the copies already on disk ────────────────────────────
{
  const { chrome, sandbox } = boot();
  fireCapture(chrome, xhr("https://claude.ai/x", "session=abc"));
  await tick();
  assert.equal(capsIn(chrome.storage.local).length, 1, "precondition: a copy is on disk");
  await sandbox.applySettings({ persistSessions: false });
  assert.deepEqual(capsIn(chrome.storage.local), [], "disabling the toggle wipes the disk copies (no secret left behind)");
  assert.equal(capsIn(chrome.storage.session).length, 1, "in-memory capture is untouched");
}

// ── 4. "clear" removes the capture from BOTH stores ─────────────────────────────────────────────
{
  const { chrome } = boot();
  fireCapture(chrome, xhr("https://claude.ai/x", "session=abc"));
  await tick();
  const onMessage = chrome._listeners.message[0];
  await new Promise((done) => onMessage({ action: "clear", providerKey: "claude-web" }, {}, done));
  assert.deepEqual(capsIn(chrome.storage.session), [], "cleared from memory");
  assert.deepEqual(capsIn(chrome.storage.local), [], "cleared from disk too");
}

// ── 5. restartRecovery: rehydrates disk → session and re-pushes ONLY connections OmniRoute still has ──
{
  const pushed = [];
  const { chrome, sandbox } = boot({
    dash: {
      // OmniRoute knows claude-web; perplexity-web was deleted in the dashboard.
      readConnectionsInPage: () => ({ ok: true, connections: [{ provider: "claude-web", id: "c1", name: "Claude Web · acc", testStatus: "error" }] }),
      postProviderInPage: (slug) => { pushed.push(slug); return { ok: true, id: "c1" }; },
      gatewayProbeInPage: () => ({ ok: true, status: 401, ct: "application/json" }),
    },
  });
  // Disk survived a browser restart; session storage is empty (as it is on a cold start).
  await chrome.storage.local.set({
    "cap_claude-web": { provider: "claude-web", slug: "claude-web", label: "Claude Web", cookie: "s=1", token: "", cookieCount: 1, at: Date.now(), accountId: "acc" },
    "cap_perplexity-web": { provider: "perplexity-web", slug: "perplexity-web", label: "Perplexity Web", cookie: "s=2", token: "", cookieCount: 1, at: Date.now(), accountId: "acc2" },
  });
  await sandbox.restartRecovery();
  assert.deepEqual(
    capsIn(chrome.storage.session).sort(),
    ["cap_claude-web", "cap_perplexity-web"],
    "both disk captures rehydrated into session"
  );
  assert.deepEqual(pushed, ["claude-web"], "re-pushed the connection OmniRoute still has — and did NOT resurrect the deleted one");
  // It runs unattended at launch: without a record the user cannot tell whether it did anything.
  const rec = chrome.storage.local._dump().last_recovery;
  assert.ok(rec, "restartRecovery leaves a record the popup can show");
  assert.equal(rec.restored, 1, "record counts what was actually restored");
  assert.equal(rec.unreachable, false, "record knows the server was reachable");
}

// ── 6. restartRecovery is a no-op when persistence is off (no secrets to restore) ────────────────
{
  const pushed = [];
  const { chrome, sandbox } = boot({
    settings: { sweep: true, sweepMin: 15, notify: true, theme: "auto", persistSessions: false },
    dash: { postProviderInPage: (slug) => { pushed.push(slug); return { ok: true }; } },
  });
  await chrome.storage.local.set({ "cap_claude-web": { provider: "claude-web", slug: "claude-web", cookie: "s=1", at: Date.now() } });
  await sandbox.restartRecovery();
  assert.deepEqual(pushed, [], "persistence off → restartRecovery pushes nothing");
}

// ── 7. restartRecovery must not blind-recreate when OmniRoute is unreachable ─────────────────────
{
  const pushed = [];
  const { chrome, sandbox } = boot({
    dash: {
      readConnectionsInPage: () => ({ ok: false, error: "HTTP 500" }), // server down / unreadable
      postProviderInPage: (slug) => { pushed.push(slug); return { ok: true }; },
    },
  });
  await chrome.storage.local.set({ "cap_claude-web": { provider: "claude-web", slug: "claude-web", cookie: "s=1", at: Date.now(), accountId: "acc" } });
  await sandbox.restartRecovery();
  assert.deepEqual(pushed, [], "can't verify what exists → push nothing rather than recreate blindly");
}

// ── 8. a capture past the disk TTL is buried, not restored ──────────────────────────────────────
{
  const pushed = [];
  const { chrome, sandbox } = boot({
    dash: {
      readConnectionsInPage: () => ({ ok: true, connections: [
        { provider: "claude-web", id: "c1", name: "Claude Web · a", testStatus: "error" },
        { provider: "perplexity-web", id: "c2", name: "Perplexity Web · b", testStatus: "error" },
      ] }),
      postProviderInPage: (slug) => { pushed.push(slug); return { ok: true }; },
      gatewayProbeInPage: () => ({ ok: true, status: 401, ct: "application/json" }),
    },
  });
  const DAY = 24 * 60 * 60 * 1000;
  await chrome.storage.local.set({
    "cap_claude-web": { provider: "claude-web", slug: "claude-web", label: "Claude Web", cookie: "fresh", token: "", at: Date.now() - 2 * DAY, accountId: "a" },
    "cap_perplexity-web": { provider: "perplexity-web", slug: "perplexity-web", label: "Perplexity Web", cookie: "corpse", token: "", at: Date.now() - 8 * DAY, accountId: "b" },
  });
  await sandbox.restartRecovery();
  assert.deepEqual(capsIn(chrome.storage.local), ["cap_claude-web"], "capture older than the 7d TTL is purged from disk");
  assert.deepEqual(capsIn(chrome.storage.session), ["cap_claude-web"], "the corpse is never hydrated into memory");
  assert.deepEqual(pushed, ["claude-web"], "only the still-plausible capture is re-pushed");
}

// ── 9. probeAll: real verdicts, and each one persisted AS IT LANDS ──────────────────────────────
// Also the only test that runs probeAll's full body — the batch-write refactor shipped a ReferenceError
// past `node --check` and every other test here, because they all exit before the loop.
{
  const { chrome, sandbox } = boot({
    dash: {
      fetchModelsInPage: () => ({ fetched: true, ok: true, models: [{ id: "claude-web/gpt-x" }, { id: "kimi-web/k2" }] }),
      chatProbeInPage: (modelId) =>
        modelId.startsWith("claude-web/")
          ? { fetched: true, ok: true, status: 200, msg: "" }
          : { fetched: true, ok: false, status: 401, msg: "unauthorized" },
    },
  });
  const { results } = await sandbox.probeAll(["claude-web", "kimi-web"], false);
  assert.equal(results["claude-web"].alive, true, "200 → alive");
  assert.equal(results["kimi-web"].alive, false, "401 → dead (a real auth verdict)");
  const stored = chrome.storage.local._dump();
  assert.ok(stored["probe_claude-web"] && stored["probe_kimi-web"], "every verdict persisted as it landed (an SW kill mid-sweep can't erase the run)");
}

// ── 10. a 429 is throttling, not death — never mark the account dead on it ──────────────────────
{
  const { sandbox } = boot({
    dash: {
      fetchModelsInPage: () => ({ fetched: true, ok: true, models: [{ id: "kimi-web/k2" }] }),
      chatProbeInPage: () => ({ fetched: true, ok: false, status: 429, msg: "rate limited" }),
    },
  });
  const { results } = await sandbox.probeAll(["kimi-web"], false);
  assert.equal(results["kimi-web"].alive, null, "429 → unknown, NOT dead (the account is authenticated, just throttled)");
}

// ── 11b. everything expired → still report it (burying corpses IS what the run did) ─────────────
{
  const { chrome, sandbox } = boot();
  await chrome.storage.local.set({
    "cap_claude-web": { provider: "claude-web", slug: "claude-web", cookie: "corpse", at: Date.now() - 30 * 24 * 60 * 60 * 1000, accountId: "a" },
  });
  await sandbox.restartRecovery();
  assert.deepEqual(capsIn(chrome.storage.local), [], "the corpse is gone");
  const rec = chrome.storage.local._dump().last_recovery;
  assert.ok(rec, "a run that only purged still leaves a record (popup must not say 'ещё не запускалось')");
  assert.equal(rec.restored, 0, "nothing restored");
  assert.equal(rec.purged, 1, "and it says how many corpses it buried");
}

// ── 11. sweepSkip: the unattended sweep must not spend a request on an opted-out provider ───────
{
  const probed = [];
  const { chrome, sandbox } = boot({
    settings: { sweep: true, sweepMin: 15, notify: true, theme: "auto", persistSessions: true, sweepSkip: ["kimi-web"] },
    dash: {
      fetchModelsInPage: () => ({ fetched: true, ok: true, models: [{ id: "claude-web/gpt-x" }, { id: "kimi-web/k2" }] }),
      chatProbeInPage: (modelId) => { probed.push(modelId.split("/")[0]); return { fetched: true, ok: true, status: 200, msg: "" }; },
    },
  });
  await chrome.storage.local.set({ conn_slugs: ["claude-web", "kimi-web"], last_active: Date.now() });
  await sandbox.healthSweep(true);
  assert.deepEqual(probed, ["claude-web"], "opted-out provider is never probed by the background sweep");
  assert.ok(!chrome.storage.local._dump()["probe_kimi-web"], "and gets no stale verdict written for it");
}

// ── 12. reachability never hangs on the Firefox direct-fetch trap ────────────────────────────────
// In Firefox a direct fetch to the http loopback HANGS (doesn't reject). CAN_DIRECT_FETCH is false
// without importScripts (this node sandbox, and Firefox's background page), so pingGateway must go
// straight to the tab and never await the hanging fetch — the regression that showed the server as
// "недоступен". A never-resolving fetch simulates the hang.
{
  const { sandbox } = boot({
    dash: { gatewayProbeInPage: () => ({ ok: true, status: 401, ct: "application/json" }) },
    fetch: () => new Promise(() => {}), // never resolves — the Firefox loopback hang
  });
  const r = await Promise.race([sandbox.pingGateway(), tick(600).then(() => "HUNG")]);
  assert.notEqual(r, "HUNG", "pingGateway resolves via the tab without awaiting the hanging direct fetch");
  assert.equal(r.ok, true, "and reports the server reachable");
}

// ── 13. probes don't hang either (fetchModels/chatProbe go to the tab in Firefox) ────────────────
{
  const { sandbox } = boot({
    dash: {
      fetchModelsInPage: () => ({ fetched: true, ok: true, models: [{ id: "claude-web/gpt-x" }] }),
      chatProbeInPage: () => ({ fetched: true, ok: true, status: 200, msg: "" }),
    },
    fetch: () => new Promise(() => {}), // hang the direct path
  });
  const { results } = await Promise.race([sandbox.probeAll(["claude-web"], false), tick(800).then(() => ({ results: "HUNG" }))]);
  assert.notEqual(results, "HUNG", "probeAll completes via the tab without awaiting the hanging direct fetch");
  assert.equal(results["claude-web"].alive, true, "and still returns the real verdict");
}

// ── unattended pushes require the provider's real session cookie (a logged-out site sends junk) ──
{
  const { sandbox } = boot();
  const claude = sandbox.OMNI_WEB_MAP["claude-web"];
  assert.equal(sandbox.hasSession(claude, { cookie: "_ga=1; cf_clearance=x" }), false, "analytics-only cookies are NOT a session");
  assert.equal(sandbox.hasSession(claude, { cookie: "_ga=1; sessionKey=sk-abc" }), true, "the named session cookie is");
  assert.equal(sandbox.hasSession(claude, { cookie: "sessionKey=" }), false, "an emptied session cookie is not");
  assert.equal(sandbox.hasSession(claude, null), false, "no capture → no session");
}

console.log("background OK — capture→disk mirror, toggle purge, clear, TTL burial, restartRecovery (rehydrate/no-resurrect/offline-safe), probeAll verdicts + per-slug persistence, 429≠dead, sweepSkip honoured, no direct-fetch hang (Firefox)");
