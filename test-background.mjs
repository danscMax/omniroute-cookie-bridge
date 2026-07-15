// Behaviour tests for the REAL background.js (service worker) under a stubbed browser.
// `node --check` proves it parses; test-render proves the popup boots. Neither covers the riskiest
// code in the extension: capturing secrets, mirroring them to disk, and re-pushing them on startup.
// This suite loads the shipped background.js and FIRES its real listeners. Run: `npm run test:bg`.
import assert from "node:assert/strict";
import { makeChrome, makeSandbox, runFiles, tick } from "./test-harness.mjs";

// ── boot the real SW ────────────────────────────────────────────────────────
// `dash` lets a test answer each runInDash injection by the injected function's NAME, which is how the
// SW talks to the dashboard tab (chrome.scripting.executeScript with `func`).
function boot({ dash = {}, settings } = {}) {
  const chrome = makeChrome();
  chrome.scripting.executeScript = ({ func, args }) => {
    const reply = dash[func.name];
    return Promise.resolve([{ result: typeof reply === "function" ? reply(...(args || [])) : (reply ?? { ok: true }) }]);
  };
  if (settings) chrome.storage.local.set({ settings });
  const sandbox = makeSandbox({ chrome });
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
  fireCapture(chrome, xhr("https://chatgpt.com/backend-api/conversation", "session=abc123; other=1"));
  await tick();
  assert.deepEqual(capsIn(chrome.storage.session), ["cap_chatgpt-web"], "capture stored in session");
  assert.deepEqual(capsIn(chrome.storage.local), ["cap_chatgpt-web"], "capture MIRRORED to disk (persistSessions default on)");
  const disk = chrome.storage.local._dump()["cap_chatgpt-web"];
  assert.equal(disk.cookie, "session=abc123; other=1", "disk copy carries the credential");
  assert.ok(disk.accountId, "disk copy carries a stable accountId");
}

// ── 2. persistSessions OFF → nothing is written to disk ─────────────────────────────────────────
{
  const { chrome } = boot({ settings: { sweep: true, sweepMin: 15, notify: true, theme: "auto", persistSessions: false } });
  fireCapture(chrome, xhr("https://chatgpt.com/x", "session=abc"));
  await tick();
  assert.deepEqual(capsIn(chrome.storage.session), ["cap_chatgpt-web"], "capture still kept in memory");
  assert.deepEqual(capsIn(chrome.storage.local), [], "NOTHING mirrored to disk when the toggle is off");
}

// ── 3. turning persistSessions OFF purges the copies already on disk ────────────────────────────
{
  const { chrome, sandbox } = boot();
  fireCapture(chrome, xhr("https://chatgpt.com/x", "session=abc"));
  await tick();
  assert.equal(capsIn(chrome.storage.local).length, 1, "precondition: a copy is on disk");
  await sandbox.applySettings({ persistSessions: false });
  assert.deepEqual(capsIn(chrome.storage.local), [], "disabling the toggle wipes the disk copies (no secret left behind)");
  assert.equal(capsIn(chrome.storage.session).length, 1, "in-memory capture is untouched");
}

// ── 4. "clear" removes the capture from BOTH stores ─────────────────────────────────────────────
{
  const { chrome } = boot();
  fireCapture(chrome, xhr("https://chatgpt.com/x", "session=abc"));
  await tick();
  const onMessage = chrome._listeners.message[0];
  await new Promise((done) => onMessage({ action: "clear", providerKey: "chatgpt-web" }, {}, done));
  assert.deepEqual(capsIn(chrome.storage.session), [], "cleared from memory");
  assert.deepEqual(capsIn(chrome.storage.local), [], "cleared from disk too");
}

// ── 5. restartRecovery: rehydrates disk → session and re-pushes ONLY connections OmniRoute still has ──
{
  const pushed = [];
  const { chrome, sandbox } = boot({
    dash: {
      // OmniRoute knows chatgpt-web; perplexity-web was deleted in the dashboard.
      readConnectionsInPage: () => ({ ok: true, connections: [{ provider: "chatgpt-web", id: "c1", name: "ChatGPT Web · acc", testStatus: "error" }] }),
      postProviderInPage: (slug, name) => { pushed.push(slug); return { ok: true, id: "c1" }; },
      gatewayProbeInPage: () => ({ ok: true, status: 401, ct: "application/json" }),
    },
  });
  // Disk survived a browser restart; session storage is empty (as it is on a cold start).
  await chrome.storage.local.set({
    "cap_chatgpt-web": { provider: "chatgpt-web", slug: "chatgpt-web", label: "ChatGPT Web", cookie: "s=1", token: "", cookieCount: 1, at: Date.now(), accountId: "acc" },
    "cap_perplexity-web": { provider: "perplexity-web", slug: "perplexity-web", label: "Perplexity Web", cookie: "s=2", token: "", cookieCount: 1, at: Date.now(), accountId: "acc2" },
  });
  await sandbox.restartRecovery();
  assert.deepEqual(
    capsIn(chrome.storage.session).sort(),
    ["cap_chatgpt-web", "cap_perplexity-web"],
    "both disk captures rehydrated into session"
  );
  assert.deepEqual(pushed, ["chatgpt-web"], "re-pushed the connection OmniRoute still has — and did NOT resurrect the deleted one");
}

// ── 6. restartRecovery is a no-op when persistence is off (no secrets to restore) ────────────────
{
  const pushed = [];
  const { chrome, sandbox } = boot({
    settings: { sweep: true, sweepMin: 15, notify: true, theme: "auto", persistSessions: false },
    dash: { postProviderInPage: (slug) => { pushed.push(slug); return { ok: true }; } },
  });
  await chrome.storage.local.set({ "cap_chatgpt-web": { provider: "chatgpt-web", slug: "chatgpt-web", cookie: "s=1", at: Date.now() } });
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
  await chrome.storage.local.set({ "cap_chatgpt-web": { provider: "chatgpt-web", slug: "chatgpt-web", cookie: "s=1", at: Date.now(), accountId: "acc" } });
  await sandbox.restartRecovery();
  assert.deepEqual(pushed, [], "can't verify what exists → push nothing rather than recreate blindly");
}

console.log("background OK — capture→disk mirror, toggle purge, clear, restartRecovery (rehydrate / no-resurrect / offline-safe)");
