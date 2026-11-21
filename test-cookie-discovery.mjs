// Focused offline regressions for URL-scoped cookie discovery. All cookies are synthetic;
// the real worker runs in the shared VM harness without a browser, profile or network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeChrome, makeSandbox, runFiles } from "./test-harness.mjs";

const NAME = "__Secure-next-auth.session-token";
const URL = "https://www.perplexity.ai/";
const BROWSERS = ["chrome", "firefox"];
const CHUNK_NAMES = Array.from({ length: 17 }, (_, i) => NAME + "." + i);
const cookie = (name, extra = {}) => ({
  name, value: "synthetic-" + name, domain: ".perplexity.ai", path: "/",
  secure: true, httpOnly: true, hostOnly: false, storeId: "0", ...extra,
});
function boot({ browser = "firefox", getAll = async () => [], get = async () => null, tabs = [], extra = {} } = {}) {
  const chrome = makeChrome();
  chrome.cookies = { getAll, get, onChanged: { addListener() {} } };
  chrome.tabs.query = async () => tabs;
  // runFiles loads the catalog first; importScripts only selects the Chrome worker path here.
  const sandbox = makeSandbox({ chrome, extra: { ...extra, importScripts: browser === "chrome" ? () => {} : undefined } });
  assert.deepEqual(runFiles(sandbox, ["providers.gen.js", "providers.js", "background.js"]), []);
  const scan = () => ({ tabs, queries: new Map(), until: sandbox.Date.now() + 4000 });
  return { chrome, sandbox, scan, provider: (slug = "perplexity-web") => sandbox.OMNI_WEB_MAP[slug] };
}

for (const browser of BROWSERS) {
  test(`${browser}: empty parent-domain enumeration uses the permitted URL and coalesces named reads`, async () => {
    const calls = [];
    const api = boot({
      browser,
      getAll: async (q) => {
        calls.push({ method: "getAll", ...structuredClone(q) });
        if (browser === "chrome" && "firstPartyDomain" in q) throw new Error("Synthetic Chromium unsupported option");
        return []; // Parent .perplexity.ai is not itself an allowed host for enumeration.
      },
      get: async (q) => {
        calls.push({ method: "get", ...structuredClone(q) });
        return cookie(NAME);
      },
    });
    const scan = api.scan(), p = api.provider();
    const candidates = await Promise.all(Array.from({ length: 5 }, () => api.sandbox.cookieCandidateFor(p, scan)));
    // Compare realm-neutral arguments outside the stub: cookie API errors are caught by the worker.
    const expected = [
      { method: "getAll", url: URL, firstPartyDomain: null, partitionKey: {} },
      ...(browser === "chrome" ? [{ method: "getAll", url: URL, partitionKey: {} }] : []),
      { method: "get", url: URL, ...(browser === "firefox" ? { firstPartyDomain: "" } : {}), name: NAME },
    ];
    assert.deepEqual(calls, expected, "a whole cookie needs no chunk probes or wildcard named-query context");
    for (const candidate of candidates) {
      assert.ok(candidate);
      assert.equal(candidate.cookie, NAME + "=synthetic-" + NAME);
      assert.equal(candidate.storeId, "0");
      assert.equal(candidate.cookieContext, "");
      assert.equal(api.sandbox.omniBuildCredential(p, candidate), "synthetic-" + NAME);
    }
    const captures = await Promise.all(Array.from({ length: 3 }, () => api.sandbox.captureFromStore(p, scan)));
    assert.deepEqual(calls, expected, "capture reuses the same scan's enumerated and named queries");
    assert.equal(captures[0].cookie, candidates[0].cookie);
    assert.equal(api.chrome.storage.session._dump()["cap_" + p.key].cookie, candidates[0].cookie);
    assert.equal(api.chrome.storage.local._dump()["cap_" + p.key].cookie, candidates[0].cookie);
    assert.ok((await api.sandbox.getCaptures(false)).caps[p.key]);
    assert.equal(JSON.stringify(await api.sandbox.getCaptures(false)).includes("synthetic-"), false);
  });

  test(`${browser}: named reads preserve the reviewed URL and explicit store`, async () => {
    const calls = [];
    const url = "https://www.perplexity.ai/account/session/?view=synthetic";
    const storeId = browser === "firefox" ? "firefox-container-1" : "1";
    const api = boot({ browser, tabs: [{ url, cookieStoreId: storeId, active: true }], get: async (q) => {
      calls.push(structuredClone(q));
      return q.storeId === storeId ? cookie(NAME, { storeId, path: "/account", firstPartyDomain: "", partitionKey: {} }) : null;
    } });
    const p = { ...api.provider(), captureUrls: [url] };
    const candidate = await api.sandbox.cookieCandidateFor(p, api.scan());
    assert.ok(candidate);
    assert.equal(candidate.storeId, storeId);
    assert.equal(candidate.cookieContext, "");
    assert.deepEqual(calls, [{ url, storeId, ...(browser === "firefox" ? { firstPartyDomain: "" } : {}), name: NAME }]);
  });
}

test("named fallback requires every AND group and supports reviewed aliases", async () => {
  for (const complete of [false, true]) {
    const calls = [];
    const api = boot({ get: async (q) => {
      calls.push(q);
      return q.name === "sso" || (complete && q.name === "sso-rw") ? cookie(q.name, { domain: "grok.com" }) : null;
    } });
    const candidate = await api.sandbox.cookieCandidateFor(api.provider("grok-web"), api.scan());
    assert.equal(!!candidate, complete, "sso alone cannot satisfy sso AND sso-rw");
    assert.deepEqual(calls.map((q) => q.name).sort(), complete ? ["sso", "sso-rw"] : ["sso", "sso-rw", "sso-rw.0"]);
  }
  const api = boot({ get: async (q) => q.name === "next-auth.session-token"
    ? cookie(q.name, { domain: "app.blackbox.ai" }) : null });
  const p = api.provider("blackbox-web");
  const candidate = await api.sandbox.cookieCandidateFor(p, api.scan());
  assert.ok(candidate);
  assert.equal(api.sandbox.hasSession(p, candidate), true);
});

test("aliases can satisfy each AND-of-OR group without querying unrelated source names", async () => {
  const left = ["synthetic-left", "synthetic-left-alias"], right = ["synthetic-right", "synthetic-right-alias"];
  for (const available of [[left[1]], [right[1]], [left[1], right[1]]]) {
    const calls = [];
    const api = boot({ get: async (q) => {
      calls.push(q.name);
      return available.includes(q.name) ? cookie(q.name, { domain: "grok.com" }) : null;
    } });
    const p = { ...api.provider("grok-web"), cookieGroups: [left, right],
      sources: [...left, ...right, "synthetic-unrelated"].map((name) => ({ type: "cookie", name })) };
    const candidate = await api.sandbox.cookieCandidateFor(p, api.scan());
    assert.equal(!!candidate, available.length === 2, available.join(", "));
    assert.equal(calls.some((name) => name.startsWith("synthetic-unrelated")), false);
    if (candidate) {
      assert.equal(candidate.cookie, available.map((name) => name + "=synthetic-" + name).join("; "));
      assert.equal(api.sandbox.hasSession(p, candidate), true);
    }
  }
});

test("invalid aliases cannot poison alternatives, erase complete groups or satisfy missing AND groups", async () => {
  const legacy = "synthetic-legacy", current = "synthetic-current";
  const kept = "synthetic-kept", later = "synthetic-later";
  const cases = [
    { label: "chunk gap", chunks: [[0, {}], [2, {}]], stop: 2 },
    { label: "empty head", chunks: [[0, { value: "" }]], stop: 0 },
    { label: "empty tail", chunks: [[0, {}], [1, { value: "" }]], stop: 1 },
    { label: "overflow", chunks: Array.from({ length: 17 }, (_, i) => [i, {}]), stop: 16 },
    { label: "whole query error", error: legacy, stop: -1 },
    { label: "head query error", error: legacy + ".0", stop: 0 },
    { label: "tail query error", chunks: [[0, {}]], error: legacy + ".1", stop: 1 },
    { label: "whole context mismatch", whole: { firstPartyDomain: "synthetic-context.test" }, stop: -1 },
    { label: "head context mismatch", chunks: [[0, { partitionKey: { topLevelSite: "https://synthetic-context.test" } }]], stop: 0 },
    { label: "tail context mismatch", chunks: [[0, {}], [1, { firstPartyDomain: "synthetic-context.test" }]], stop: 1 },
    { label: "tail store mismatch", chunks: [[0, {}], [1, { storeId: "1" }]], stop: 1 },
  ];
  const requirements = [
    { label: "later OR alias", groups: [[legacy, current]], complete: true },
    { label: "retained and later AND groups", groups: [[kept], [legacy, current], [later]], complete: true },
    { label: "unsatisfied AND group", groups: [[kept], [legacy], [current], [later]], complete: false },
  ];
  for (const { label, chunks = [], whole, error, stop } of cases) {
    const invalid = new Map(chunks.map(([i, extra]) => [legacy + "." + i,
      cookie(legacy + "." + i, { value: "synthetic-discard-" + i, ...extra })]));
    if (whole) invalid.set(legacy, cookie(legacy, { value: "synthetic-discard-whole", ...whole }));
    const probes = [legacy, ...Array.from({ length: stop + 1 }, (_, i) => legacy + "." + i)];
    for (const { label: requirement, groups, complete } of requirements) {
      const calls = [], names = [...new Set(groups.flat())];
      const validNames = names.filter((name) => name !== legacy);
      const api = boot({ get: async (q) => {
        calls.push(q.name);
        if (q.name === error) throw new Error("Synthetic unreadable alias");
        return validNames.includes(q.name) ? cookie(q.name) : invalid.get(q.name) || null;
      } });
      const p = { ...api.provider(), cred: { t: "cookie" }, cookieGroups: groups,
        sources: names.map((name) => ({ type: "cookie", name })) };
      const candidate = await api.sandbox.cookieCandidateFor(p, api.scan());
      const detail = label + ": " + requirement;
      assert.deepEqual(calls, names.flatMap((name) => name === legacy ? probes : [name]), detail);
      assert.equal(!!candidate, complete, detail);
      if (complete) {
        const expected = validNames.map((name) => name + "=synthetic-" + name).join("; ");
        assert.equal(candidate.cookie, expected, detail + ": discard every partial cookie from the invalid alias");
        assert.equal(api.sandbox.omniBuildCredential(p, candidate), expected, detail);
      } else {
        assert.equal(candidate, null, detail);
        assert.equal(api.sandbox.omniBuildCredential(p, candidate), "", detail + ": a partial head cannot satisfy its own AND group");
      }
    }
  }
});

test("a later alias cannot complete a retained AND group from another store or context", async () => {
  const kept = "synthetic-kept", legacy = "synthetic-legacy", current = "synthetic-current";
  const contexts = [
    { label: "another store", extra: { storeId: "1" } },
    { label: "first-party isolation", extra: { firstPartyDomain: "synthetic-context.test" } },
    { label: "partition", extra: { partitionKey: { topLevelSite: "https://synthetic-context.test" } } },
    { label: "ancestor context", extra: { partitionKey: { hasCrossSiteAncestor: false } } },
  ];
  for (const { label, extra } of contexts) {
    const calls = [];
    const api = boot({ get: async (q) => {
      calls.push(q.name);
      if (q.name === current) return cookie(q.name, extra);
      return [kept, legacy + ".0", legacy + ".2"].includes(q.name) ? cookie(q.name) : null;
    } });
    const p = { ...api.provider(), cred: { t: "cookie" }, cookieGroups: [[kept], [legacy, current]],
      sources: [kept, legacy, current].map((name) => ({ type: "cookie", name })) };
    const candidate = await api.sandbox.cookieCandidateFor(p, api.scan());
    assert.deepEqual(calls, [kept, legacy, legacy + ".0", legacy + ".1", legacy + ".2", current], label);
    assert.equal(candidate, null, label + ": discarding a bad family does not relax candidate isolation");
    assert.equal(api.sandbox.omniBuildCredential(p, candidate), "", label);
  }
});

test("named reads never assemble required cookies from different URLs or stores", async () => {
  const urls = ["https://grok.com/first/", "https://grok.com/second/"];
  const api = boot({ get: async (q) =>
    (q.url === urls[0] && q.name === "sso") || (q.url === urls[1] && q.name === "sso-rw")
      ? cookie(q.name, { domain: "grok.com" }) : null });
  const p = { ...api.provider("grok-web"), captureUrls: urls };
  assert.equal(await api.sandbox.cookieCandidateFor(p, api.scan()), null);

  const calls = [];
  const tabs = [
    { url: "https://grok.com/", cookieStoreId: "firefox-container-1", active: true },
    { url: "https://grok.com/", cookieStoreId: "firefox-container-2" },
  ];
  const stores = boot({ tabs, get: async (q) => {
    calls.push(q);
    return (q.storeId === "firefox-container-1" && q.name === "sso")
      || (q.storeId === "firefox-container-2" && q.name === "sso-rw")
      ? cookie(q.name, { domain: "grok.com", storeId: q.storeId }) : null;
  } });
  assert.equal(await stores.sandbox.cookieCandidateFor(stores.provider("grok-web"), stores.scan()), null);
  assert.deepEqual([...new Set(calls.map((q) => q.storeId))], ["firefox-container-1", "firefox-container-2", undefined]);
});

test("fallback metadata preserves store, partition, ancestor and first-party isolation", async () => {
  const contexts = [
    [{ storeId: "0" }, { storeId: "1" }],
    [{ firstPartyDomain: "synthetic-a.test" }, { firstPartyDomain: "synthetic-b.test" }],
    [{}, { partitionKey: { topLevelSite: "https://synthetic-a.test" } }],
    [{ partitionKey: { topLevelSite: "https://synthetic-a.test" } }, { partitionKey: { topLevelSite: "https://synthetic-b.test" } }],
    [{ partitionKey: { topLevelSite: "https://synthetic-a.test", hasCrossSiteAncestor: false } },
      { partitionKey: { topLevelSite: "https://synthetic-a.test", hasCrossSiteAncestor: true } }],
  ];
  for (const [first, second] of contexts) {
    const api = boot({ get: async (q) => cookie(q.name, { domain: "grok.com", ...(q.name === "sso" ? first : second) }) });
    assert.equal(await api.sandbox.cookieCandidateFor(api.provider("grok-web"), api.scan()), null, JSON.stringify([first, second]));
  }
  // The normal enumeration path also retains the complete non-default context for slot matching.
  const context = { storeId: "firefox-container-1", firstPartyDomain: "synthetic-a.test",
    partitionKey: { topLevelSite: "https://synthetic-b.test", hasCrossSiteAncestor: true } };
  const api = boot({ getAll: async () => [cookie("sso", { domain: "grok.com", ...context }), cookie("sso-rw", { domain: "grok.com", ...context })] });
  const candidate = await api.sandbox.cookieCandidateFor(api.provider("grok-web"), api.scan());
  assert.equal(candidate.storeId, context.storeId);
  assert.deepEqual(JSON.parse(candidate.cookieContext), [context.storeId, context.firstPartyDomain, context.partitionKey.topLevelSite, true]);
});

test("an explicit store cannot adopt another store's named cookie", async () => {
  const api = boot({
    tabs: [{ url: URL, cookieStoreId: "firefox-container-1", active: true }],
    get: async (q) => q.storeId ? cookie(q.name, { storeId: "firefox-container-2" }) : null,
  });
  assert.equal(await api.sandbox.cookieCandidateFor(api.provider(), api.scan()), null);
});

test("only incomplete enumerated chunks retry the reviewed whole name and chunk head", async () => {
  for (const [suffixes, valid] of [[[".0", ".1"], true], [[".0", ".2"], false], [[".1"], false]]) {
    const named = [];
    const api = boot({
      getAll: async () => suffixes.map((suffix) => cookie(NAME + suffix)),
      get: async (q) => { named.push(q.name); return null; },
    });
    assert.equal(!!(await api.sandbox.cookieCandidateFor(api.provider(), api.scan())), valid);
    assert.deepEqual(named, valid ? [] : [NAME, NAME + ".0"], "an absent named head stops further suffix probes");
  }
  const calls = [];
  const api = boot({ get: async (q) => { calls.push(q.name); return cookie(q.name + ".0"); } });
  assert.equal(await api.sandbox.cookieCandidateFor(api.provider(), api.scan()), null);
  assert.deepEqual(calls, [NAME], "a returned chunk does not match the requested whole-cookie name");
});

for (const browser of BROWSERS) {
  test(`${browser}: complete parent-domain chunks preserve values and coalesce every suffix through the overflow guard`, async () => {
    const cases = [
      { whole: null, values: ["synthetic%2Fhead=+_", "synthetic.tail==%3D"] },
      { whole: "", values: ["synthetic-single=="] },
      { whole: null, values: Array.from({ length: 16 }, (_, i) => `synthetic-${i}%2F=+_`) },
    ];
    for (const { whole, values } of cases) {
      const calls = [];
      const api = boot({ browser, get: async (q) => {
        calls.push(structuredClone(q));
        if (q.name === NAME) return whole === null ? null : cookie(NAME, { value: whole });
        const index = CHUNK_NAMES.indexOf(q.name);
        return index >= 0 && index < values.length ? cookie(q.name, { value: values[index] }) : null;
      } });
      const scan = api.scan(), p = api.provider();
      const candidates = await Promise.all(Array.from({ length: 3 }, () => api.sandbox.cookieCandidateFor(p, scan)));
      assert.deepEqual(calls, [NAME, ...CHUNK_NAMES].map((name) => ({
        url: URL, ...(browser === "firefox" ? { firstPartyDomain: "" } : {}), name,
      })), "read each suffix once, including absent tails and .16, but never .17");
      for (const candidate of candidates) {
        assert.ok(candidate);
        assert.equal(candidate.cookie, values.map((value, i) => CHUNK_NAMES[i] + "=" + value).join("; "));
        assert.equal(api.sandbox.omniBuildCredential(p, candidate), values.join(""), "do not decode, reorder or drop equals signs");
        assert.equal(candidate.storeId, "0");
        assert.equal(candidate.cookieContext, "");
      }
    }
  });
}

test("named chunk discovery rejects missing or empty heads, gaps, empty tails and .16 overflow", async () => {
  const cases = [
    { label: "missing head", chunks: [[1, "synthetic-orphan"]], stop: 0 },
    { label: "empty head", chunks: [[0, ""]], stop: 0 },
    { label: "gap", chunks: [[0, "synthetic-head"], [2, "synthetic-gap"]], stop: 2 },
    { label: "late gap", chunks: [[0, "synthetic-head"], [15, "synthetic-late"]], stop: 15 },
    { label: "empty tail", chunks: [[0, "synthetic-head"], [1, ""]], stop: 1 },
    { label: "overflow", chunks: Array.from({ length: 17 }, (_, i) => [i, "synthetic-" + i]), stop: 16 },
  ];
  for (const { label, chunks, stop } of cases) {
    const calls = [];
    const cookies = new Map(chunks.map(([i, value]) => [CHUNK_NAMES[i], cookie(CHUNK_NAMES[i], { value })]));
    const api = boot({ get: async (q) => { calls.push(q.name); return cookies.get(q.name) || null; } });
    assert.equal(await api.sandbox.cookieCandidateFor(api.provider(), api.scan()), null, label);
    assert.deepEqual(calls, [NAME, ...CHUNK_NAMES.slice(0, stop + 1)], label);
  }
});

test("named responses must match the reviewed URL and default unpartitioned context", async () => {
  const reviewed = "https://www.perplexity.ai/account/session/?view=synthetic";
  const cases = [
    { label: "parent-domain root", extra: {}, valid: true },
    { label: "case-insensitive parent and path boundary", extra: { domain: ".PERPLEXITY.AI", path: "/account" }, valid: true },
    { label: "exact host-only path", extra: { domain: "www.perplexity.ai", hostOnly: true, path: "/account/session/" }, valid: true },
    { label: "empty context metadata", extra: { firstPartyDomain: "", partitionKey: {} }, valid: true },
    { label: "unrelated domain", extra: { domain: ".synthetic.test" }, valid: false },
    { label: "domain suffix lookalike", extra: { domain: ".plexity.ai" }, valid: false },
    { label: "sibling host", extra: { domain: "api.perplexity.ai" }, valid: false },
    { label: "host-only parent", extra: { domain: "perplexity.ai", hostOnly: true }, valid: false },
    { label: "different path", extra: { path: "/login/" }, valid: false },
    { label: "longer path", extra: { path: "/account/session/private/" }, valid: false },
    { label: "path prefix without a boundary", extra: { path: "/account/sess" }, valid: false },
    { label: "case-sensitive path", extra: { path: "/Account" }, valid: false },
    { label: "secure cookie on HTTP", url: "http://www.perplexity.ai/account/session/", extra: {}, valid: false },
    { label: "first-party isolation", extra: { firstPartyDomain: "synthetic-context.test" }, valid: false },
    { label: "partitioned cookie", extra: { partitionKey: { topLevelSite: "https://synthetic-context.test", hasCrossSiteAncestor: false } }, valid: false },
  ];
  for (const { label, url = reviewed, extra, valid } of cases) {
    const calls = [];
    const api = boot({ get: async (q) => { calls.push(structuredClone(q)); return cookie(NAME, extra); } });
    const p = { ...api.provider(), captureUrls: [url] };
    const candidate = await api.sandbox.cookieCandidateFor(p, api.scan());
    assert.equal(!!candidate, valid, label);
    assert.deepEqual(calls, [{ url, firstPartyDomain: "", name: NAME }], label + ": neither widen the URL nor reinterpret a mismatched response as absence");
  }
});

test("mismatched chunk responses cannot certify a shorter token, including after an absent suffix", async () => {
  const cases = [
    { label: "wrong name", extra: { name: "synthetic-other" } },
    { label: "non-string value", extra: { value: 42 } },
    { label: "sibling host", extra: { domain: "api.perplexity.ai" } },
    { label: "host-only parent", extra: { domain: "perplexity.ai", hostOnly: true } },
    { label: "different path", extra: { path: "/login/" } },
    { label: "another store", extra: { storeId: "1" } },
    { label: "first-party domain", extra: { firstPartyDomain: "synthetic-context.test" } },
    { label: "partition", extra: { partitionKey: { topLevelSite: "https://synthetic-context.test" } } },
    { label: "ancestor context", extra: { partitionKey: { hasCrossSiteAncestor: false } } },
  ];
  for (const index of [1, 3]) for (const { label, extra } of cases) {
    const calls = [];
    const api = boot({ get: async (q) => {
      calls.push(q.name);
      if (q.name === CHUNK_NAMES[0]) return cookie(q.name);
      return q.name === CHUNK_NAMES[index] ? cookie(q.name, extra) : null;
    } });
    assert.equal(await api.sandbox.cookieCandidateFor(api.provider(), api.scan()), null, label + " at ." + index);
    assert.deepEqual(calls, [NAME, ...CHUNK_NAMES.slice(0, index + 1)], label);
  }
});

test("failed tail queries are cached failures rather than evidence of absent chunks", async () => {
  for (const index of [1, 16]) {
    const calls = [];
    const api = boot({ get: async (q) => {
      calls.push(q.name);
      if (q.name === CHUNK_NAMES[index]) throw new Error("Synthetic unreadable tail");
      return q.name === CHUNK_NAMES[0] ? cookie(q.name) : null;
    } });
    const scan = api.scan(), p = api.provider();
    assert.equal(await api.sandbox.cookieCandidateFor(p, scan), null);
    assert.deepEqual(calls, [NAME, ...CHUNK_NAMES.slice(0, index + 1)]);
    assert.equal(await api.sandbox.cookieCandidateFor(p, scan), null);
    assert.deepEqual(calls, [NAME, ...CHUNK_NAMES.slice(0, index + 1)], "do not retry a failed suffix in the same scan");
  }
});

for (const browser of BROWSERS) {
  test(`${browser}: analytics-only enumeration cannot hide a URL-readable parent-domain session`, async () => {
    const calls = [];
    const api = boot({
      browser,
      getAll: async () => [cookie("_ga", { domain: "www.perplexity.ai" })],
      get: async (q) => { calls.push(structuredClone(q)); return cookie(NAME); },
    });
    const candidate = await api.sandbox.cookieCandidateFor(api.provider(), api.scan());
    assert.deepEqual(calls, [{ url: URL, ...(browser === "firefox" ? { firstPartyDomain: "" } : {}), name: NAME }]);
    assert.ok(candidate);
    assert.equal(candidate.cookie, NAME + "=synthetic-" + NAME);
    assert.equal(candidate.cookie.includes("_ga"), false, "named reads are an independent candidate");
  });
}

test("incomplete enumeration and named lookups never complete each other's session", async () => {
  for (const complete of [false, true]) {
    const api = boot({
      getAll: async () => [cookie("sso", { domain: "grok.com", value: "synthetic-enumerated-account" })],
      get: async (q) => (q.name === "sso-rw" || complete)
        ? cookie(q.name, { domain: "grok.com", value: "synthetic-named-account" }) : null,
    });
    const candidate = await api.sandbox.cookieCandidateFor(api.provider("grok-web"), api.scan());
    assert.equal(!!candidate, complete);
    if (candidate) {
      assert.equal(candidate.cookie, "sso=synthetic-named-account; sso-rw=synthetic-named-account");
      assert.equal(candidate.cookie.includes("synthetic-enumerated-account"), false);
    }
  }
});

test("incomplete enumerated chunks neither fill named gaps nor contaminate a complete named candidate", async () => {
  for (const complete of [false, true]) {
    const values = ["synthetic-named-head%2F", "synthetic-named-tail=="];
    const api = boot({
      getAll: async () => [
        cookie(CHUNK_NAMES[0], { value: "synthetic-enumerated-head" }),
        cookie(CHUNK_NAMES[2], { value: "synthetic-enumerated-tail" }),
      ],
      get: async (q) => {
        if (q.name === CHUNK_NAMES[0] && complete) return cookie(q.name, { value: values[0] });
        return q.name === CHUNK_NAMES[1] ? cookie(q.name, { value: values[1] }) : null;
      },
    });
    const p = api.provider();
    const candidate = await api.sandbox.cookieCandidateFor(p, api.scan());
    assert.equal(!!candidate, complete, "the enumerated .0/.2 and named .1 cannot complete each other");
    if (candidate) {
      assert.equal(candidate.cookie, values.map((value, i) => CHUNK_NAMES[i] + "=" + value).join("; "));
      assert.equal(api.sandbox.omniBuildCredential(p, candidate), values.join(""));
      assert.equal(candidate.cookie.includes("synthetic-enumerated-"), false);
    }
  }
});

test("unavailable or denied enumeration does not turn into named discovery", async () => {
  let named = 0;
  const api = boot({
    getAll: async () => { throw new Error("Synthetic host access denied"); },
    get: async (q) => { named++; return cookie(q.name); },
  });
  assert.equal(await api.sandbox.cookieCandidateFor(api.provider(), api.scan()), null);
  assert.equal(named, 0);
  const unsupported = boot({ get: undefined });
  delete unsupported.chrome.cookies.get;
  assert.equal(await unsupported.sandbox.cookieCandidateFor(unsupported.provider(), unsupported.scan()), null);
});

function clock() {
  let now = 1000, id = 0;
  const timers = new Map();
  return {
    advance: (ms) => { now += ms; }, timers,
    extra: {
      Date: class extends Date { static now() { return now; } },
      setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
  };
}

test("named queries share the scan deadline and query timeout, ignoring late results", async () => {
  for (const budget of [100, 4000]) {
    const time = clock();
    let enter, resolve, named = 0;
    const entered = new Promise((r) => { enter = r; });
    const delayed = new Promise((r) => { resolve = r; });
    const api = boot({ extra: time.extra, get: () => { named++; enter(); return delayed; } });
    const scan = api.scan(); scan.until = time.extra.Date.now() + budget;
    const pending = Promise.all(Array.from({ length: 3 }, () => api.sandbox.cookieCandidateFor(api.provider(), scan)));
    await entered;
    assert.equal(named, 1);
    assert.equal(time.timers.size, 1);
    const timer = [...time.timers.values()][0];
    assert.equal(timer.ms, Math.min(800, budget));
    time.advance(timer.ms); timer.fn();
    assert.deepEqual(await pending, [null, null, null]);
    resolve(cookie(NAME));
    assert.equal(await api.sandbox.cookieCandidateFor(api.provider(), scan), null, "a late response cannot revive a timed-out cached query");
    assert.equal(named, 1);
    assert.equal(time.timers.size, 0);
  }
});

for (const browser of BROWSERS) {
  test(`${browser}: timed-out trailing chunks share the remaining budget and cannot certify a shorter token`, async () => {
    for (const budget of [100, 4000]) for (const index of [1, 16]) {
      const time = clock(), calls = [];
      let enter, resolve;
      const entered = new Promise((r) => { enter = r; });
      const delayed = new Promise((r) => { resolve = r; });
      const api = boot({ browser, extra: time.extra,
        getAll: async () => { time.advance(20); return []; },
        get: (q) => {
          calls.push(q.name);
          if (q.name === CHUNK_NAMES[index]) { enter(); return delayed; }
          time.advance(2); // Earlier enumeration and suffix reads consume the same scan budget.
          return Promise.resolve(q.name === CHUNK_NAMES[0] ? cookie(q.name) : null);
        },
      });
      const p = api.provider(), scan = api.scan();
      scan.until = time.extra.Date.now() + budget;
      const pending = Promise.all([
        ...Array.from({ length: 3 }, () => api.sandbox.cookieCandidateFor(p, scan)),
        api.sandbox.captureFromStore(p, scan),
      ]);
      await entered;
      const expected = [NAME, ...CHUNK_NAMES.slice(0, index + 1)];
      assert.deepEqual(calls, expected, "concurrent discovery and capture coalesce every suffix query");
      assert.equal(time.timers.size, 1);
      const timer = [...time.timers.values()][0];
      assert.equal(timer.ms, Math.min(800, budget - 20 - 2 * (index + 1)));
      time.advance(timer.ms); timer.fn();
      assert.deepEqual(await pending, [null, null, null, null], "an unread tail is not an absent tail");
      assert.equal(api.chrome.storage.session._dump()["cap_" + p.key], undefined);
      assert.equal(api.chrome.storage.local._dump()["cap_" + p.key], undefined);
      resolve(null);
      assert.equal(await api.sandbox.cookieCandidateFor(p, scan), null, "late absence cannot revive a cached timeout");
      assert.deepEqual(calls, expected, "do not retry timed-out suffixes in the same scan");
      assert.equal(time.timers.size, 0);
    }
  });
}

test("a timed-out alias yields to a later alternative only within the original shared deadline", async () => {
  const kept = "synthetic-kept", legacy = "synthetic-legacy", current = "synthetic-current";
  for (const browser of BROWSERS) for (const budget of [100, 4000]) {
    const time = clock(), calls = [];
    let enter, resolve;
    const entered = new Promise((r) => { enter = r; });
    const delayed = new Promise((r) => { resolve = r; });
    const api = boot({ browser, extra: time.extra,
      getAll: async () => { time.advance(20); return []; },
      get: (q) => {
        calls.push(q.name);
        if (q.name === legacy + ".1") { enter(); return delayed; }
        time.advance(2);
        return Promise.resolve([kept, current, legacy + ".0"].includes(q.name) ? cookie(q.name) : null);
      },
    });
    const p = { ...api.provider(), cred: { t: "cookie" }, cookieGroups: [[kept], [legacy, current]],
      sources: [kept, legacy, current].map((name) => ({ type: "cookie", name })) };
    const scan = api.scan(); scan.until = time.extra.Date.now() + budget;
    const pending = Promise.all(Array.from({ length: 3 }, () => api.sandbox.cookieCandidateFor(p, scan)));
    await entered;
    const beforeTimeout = [kept, legacy, legacy + ".0", legacy + ".1"];
    assert.deepEqual(calls, beforeTimeout);
    assert.equal(time.timers.size, 1);
    const timer = [...time.timers.values()][0];
    assert.equal(timer.ms, Math.min(800, budget - 26), "enumeration and earlier names consume the original budget");
    time.advance(timer.ms); timer.fn();
    const candidates = await pending;
    const complete = budget === 4000;
    const expectedCalls = complete ? [...beforeTimeout, current] : beforeTimeout;
    assert.deepEqual(calls, expectedCalls, "a later alias is queried once, and never after the scan deadline");
    for (const candidate of candidates) {
      assert.equal(!!candidate, complete, browser + ": " + budget);
      if (complete) {
        const expected = [kept, current].map((name) => name + "=synthetic-" + name).join("; ");
        assert.equal(candidate.cookie, expected, "retain the earlier complete group but discard the timed-out family's head");
        assert.equal(api.sandbox.omniBuildCredential(p, candidate), expected);
      } else assert.equal(candidate, null);
    }
    resolve(cookie(legacy + ".1", { value: "synthetic-late-ignored" }));
    assert.deepEqual(await api.sandbox.cookieCandidateFor(p, scan), candidates[0], "late chunks cannot revive a rejected alias");
    assert.deepEqual(calls, expectedCalls, "coalesced failures remain cached across discovery calls");
    assert.equal(time.timers.size, 0);
  }
});

test("a completed whole-cookie or trailing read after the scan deadline cannot publish a capture", async () => {
  for (const delayedName of [NAME, CHUNK_NAMES[16]]) {
    const time = clock(), calls = [];
    let enter, resolve;
    const entered = new Promise((r) => { enter = r; });
    const delayed = new Promise((r) => { resolve = r; });
    const api = boot({ extra: time.extra, get: (q) => {
      calls.push(q.name);
      if (q.name === delayedName) { enter(); return delayed; }
      return Promise.resolve(q.name === CHUNK_NAMES[0] ? cookie(q.name) : null);
    } });
    const scan = api.scan(); scan.until = time.extra.Date.now() + 100;
    const pending = api.sandbox.captureFromStore(api.provider(), scan);
    await entered;
    assert.deepEqual(calls, delayedName === NAME ? [NAME] : [NAME, ...CHUNK_NAMES]);
    time.advance(101); resolve(delayedName === NAME ? cookie(NAME) : null); // Settle before the timer callback.
    assert.equal(await pending, null);
    assert.equal(api.chrome.storage.session._dump()["cap_perplexity-web"], undefined);
    assert.equal(api.chrome.storage.local._dump()["cap_perplexity-web"], undefined);
    assert.equal(time.timers.size, 0);
  }
});
