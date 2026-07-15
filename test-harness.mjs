// Shared test harness: an in-memory `chrome.*` stub + a vm sandbox that runs the REAL extension files.
// Used by BOTH test-render.mjs (popup, under linkedom) and test-background.mjs (service worker), so the
// two suites can't drift apart on what "the browser" looks like — extracted from test-render.mjs, which
// grew the original stub. Nothing here is extension code: it only emulates the browser surface.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export const EXT = dirname(fileURLToPath(import.meta.url));

// One chrome.storage area. Mirrors the real dual API: get/set/remove work as promises AND callbacks
// (background.js uses `SEC.set({...}, updateBadge)` callback-style and `await LOC.get(null)` promise-style).
export function area(seed = {}) {
  const m = { ...seed };
  return {
    _dump: () => ({ ...m }), // test-only peek
    get: (k) =>
      Promise.resolve(
        k == null
          ? { ...m }
          : typeof k === "string"
            ? { [k]: m[k] }
            : Array.isArray(k)
              ? Object.fromEntries(k.map((x) => [x, m[x]]))
              : { ...m }
      ),
    set: (o, cb) => {
      Object.assign(m, o);
      cb && cb();
      return Promise.resolve();
    },
    remove: (k, cb) => {
      (Array.isArray(k) ? k : [k]).forEach((x) => delete m[x]);
      cb && cb();
      return Promise.resolve();
    },
    onChanged: { addListener: () => {} },
  };
}

// Captures the listeners the extension registers so a test can FIRE them (webRequest capture,
// onStartup recovery, onMessage handlers) instead of only asserting they exist.
export function makeChrome(overrides = {}) {
  const listeners = { webRequest: [], startup: [], message: [], alarm: [] };
  const base = {
    _listeners: listeners,
    storage: { local: area(), session: area() },
    runtime: {
      sendMessage: () => Promise.resolve({ ok: true }),
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      getURL: (x) => x,
      getManifest: () => ({ version: "dev" }),
    },
    webRequest: {
      OnBeforeSendHeadersOptions: { EXTRA_HEADERS: "extraHeaders" },
      onBeforeSendHeaders: { addListener: (fn) => listeners.webRequest.push(fn) },
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1, url: "http://127.0.0.1:20128/home" }]),
      create: () => Promise.resolve({ id: 1 }),
      reload: () => Promise.resolve(),
      onUpdated: { addListener: () => {}, removeListener: () => {} },
    },
    scripting: { executeScript: () => Promise.resolve([{ result: { ok: true } }]) },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    alarms: {
      create: () => {},
      clear: () => {},
      get: (n, cb) => cb(null),
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    notifications: { create: () => {} },
    windows: { create: () => {} },
  };
  return { ...base, ...overrides };
}

// A vm context that looks enough like a browser/SW global for the real files to run.
export function makeSandbox({ chrome, extra = {} } = {}) {
  const sandbox = {
    chrome,
    console,
    Promise, JSON, Math, Date, Object, Array, String, Number, RegExp, Set, Map, Boolean, parseInt, Error,
    URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    AbortController,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    fetch: () => Promise.reject(new TypeError("NetworkError: no fetch stub configured")),
    ...extra,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

// Run the REAL extension files in the sandbox, collecting load errors instead of throwing.
export function runFiles(sandbox, files) {
  const errors = [];
  for (const f of files) {
    try {
      vm.runInContext(readFileSync(join(EXT, f), "utf8"), sandbox, { filename: f });
    } catch (e) {
      errors.push(f + ": " + e.message);
    }
  }
  return errors;
}

export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
