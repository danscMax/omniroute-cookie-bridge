// Shipped catalog/report/adapter contract. All credential values below are synthetic; no network.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
// Load the real adapter: testing copied credential helpers would miss bugs in the shipped code.
globalThis.self = globalThis;
const gen = require("./providers.gen.js");
require("./providers.js");
const { omniAccountId, omniAccountIdStable, omniBuildCredential, omniHasSession, omniCookieValue,
  OMNI_CATALOG, OMNI_CATALOG_MAP, OMNI_WEB_MAP, OMNI_CAPTURE_WEB, OMNI_APIKEY_MAP, OMNI_OAUTH_MAP } = globalThis;
for (const fn of [omniAccountId, omniAccountIdStable, omniBuildCredential, omniHasSession, omniCookieValue]) assert.equal(typeof fn, "function");
const coverage = JSON.parse(readFileSync(new URL("./provider-coverage.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const hash = (text) => createHash("sha256").update(text).digest("hex");
const ids = (rows) => rows.map((p) => p.slug);
const pinnedRef = "e3c1531afd07d5e06f7ffab658584a7ae2e3627e";
const sections = [
  ["NOAUTH_PROVIDERS", "no-auth", 10], ["OAUTH_PROVIDERS", "oauth", 31],
  ["APIKEY_PROVIDERS", "apikey", 262], ["WEB_COOKIE_PROVIDERS", "web-cookie", 37],
  ["LOCAL_PROVIDERS", "local", 15], ["SEARCH_PROVIDERS", "search", 21],
  ["AUDIO_ONLY_PROVIDERS", "audio", 12], ["UPSTREAM_PROXY_PROVIDERS", "upstream-proxy", 2],
  ["CLOUD_AGENT_PROVIDERS", "cloud-agent", 3], ["SYSTEM_PROVIDERS", "system", 1],
];

// These counts are tied to the pinned source, not lower bounds that silently permit lost registries.
assert.equal(gen.provenance.ref, pinnedRef);
assert.deepEqual(gen.provenance, coverage.provenance, "runtime and committed evidence have identical provenance");
assert.deepEqual(coverage.sections.map(({ name, category, count }) => [name, category, count]), sections);
assert.equal(coverage.total, 394);
assert.equal(coverage.sections.reduce((n, s) => n + s.count, 0), coverage.total);
for (const [kind, count] of Object.entries({ all: 394, web: 37, apikey: 313, oauth: 32, other: 24 })) {
  assert.equal(gen[kind].length, count, `${kind}: pinned list size (lists may overlap)`);
  assert.equal(new Set(ids(gen[kind])).size, count, `${kind}: unique IDs`);
  assert.deepEqual(ids(gen[kind]), ids(gen[kind]).sort(), `${kind}: deterministic order`);
}
assert.deepEqual(ids(gen.all), ids(coverage.providers), "all registered IDs appear exactly once in the evidence report");
assert.equal(hash(JSON.stringify(gen.all.map(({ slug, category }) => [slug, category]))),
  "84dfcf0d8a2d9bdd17fc0658700490ccfaa7da2ae87314495242c25b64ec1663",
  "pinned ID/category inventory: replacing a provider cannot pass by preserving the counts");
assert.deepEqual(ids(OMNI_CATALOG), ids(gen.all), "directory adapter preserves every registered ID");
assert.deepEqual(Object.keys(OMNI_CATALOG_MAP).sort(), ids(gen.all));
assert.deepEqual([...new Set([gen.web, gen.apikey, gen.oauth, gen.other].flatMap(ids))].sort(), ids(gen.all), "onboarding lists cover the directory without adding IDs");
assert.deepEqual(ids(gen.web), ids(gen.all.filter((p) => p.category === "web-cookie")));
assert.deepEqual(ids(gen.apikey), ids(coverage.providers.filter((p) => p.keySetup)));
assert.deepEqual(ids(gen.oauth), ids(coverage.providers.filter((p) => p.oauthSetup)));
assert.deepEqual(ids(gen.other), ids(gen.all.filter((p) => p.onboarding === "dashboard")));
for (const [kind, map] of [["web", OMNI_WEB_MAP], ["apikey", OMNI_APIKEY_MAP], ["oauth", OMNI_OAUTH_MAP]]) {
  assert.deepEqual(Object.keys(map).sort(), ids(gen[kind]), `${kind}: adapter membership`);
}
const byId = new Map(gen.all.map((p) => [p.slug, p]));
for (const kind of ["web", "apikey", "oauth", "other"]) for (const p of gen[kind]) assert.equal(p, byId.get(p.slug), "overlaps share the same source record");
for (const [, category, count] of sections) assert.equal(gen.all.filter((p) => p.category === category).length, count, category);

assert.equal(gen.provenance.sha256, hash(JSON.stringify(gen.provenance.files)), "aggregate source hash matches its file list");
assert.equal(gen.provenance.capabilitiesSha256,
  hash(readFileSync(new URL("./provider-capabilities.mjs", import.meta.url), "utf8").replaceAll("\r\n", "\n")),
  "reviewed capabilities match the generated hash independently of checkout line endings");
const sourceFiles = new Set(gen.provenance.files.map((p) => p.file));
assert.equal(sourceFiles.size, gen.provenance.files.length);
assert.deepEqual([...sourceFiles], [...sourceFiles].sort());
for (const p of gen.provenance.files) {
  assert.match(p.file, /^(src|open-sse)\//, "portable source-relative path");
  assert.ok(!p.file.split("/").includes(".."));
  assert.match(p.sha256, /^[a-f0-9]{64}$/);
}
const checkSource = (source) => {
  assert.ok(source && sourceFiles.has(source.file), `source is hashed: ${source?.file}`);
  assert.ok(Number.isInteger(source.line) && source.line > 0, "one-based source location");
};
for (const s of coverage.sections) checkSource(s.source);
for (const p of coverage.excludedExtraction) {
  assert.ok(!OMNI_WEB_MAP[p.slug], `${p.slug}: excluded extraction is not a web connection`);
  assert.ok(p.reason); checkSource(p.source);
}

for (const row of coverage.providers) {
  const p = byId.get(row.slug), adapted = OMNI_CATALOG_MAP[row.slug];
  assert.match(p.slug, /^[a-z0-9][a-z0-9_-]*$/);
  assert.ok(typeof p.label === "string" && p.label.trim(), `${p.slug}: real display label`);
  assert.ok(["web", "apikey", "oauth", "dashboard"].includes(p.onboarding));
  assert.equal(typeof p.free, "boolean");
  assert.equal(typeof p.keyOptional, "boolean");
  for (const field of ["category", "onboarding", "source", "keySetup", "oauthSetup", "capture", "captureReason", "captureEvidence"]) {
    if (field in row || field in p) assert.deepEqual(row[field], p[field], `${p.slug}: report ${field}`);
  }
  if (p.keySetup) assert.equal(row.bulk, p.bulk, `${p.slug}: bulk policy in evidence`);
  assert.deepEqual(row.metadata, ["website", "authHint", "apiHint", "notice", "freeNote"].filter((field) => !!p[field]), `${p.slug}: upstream guidance presence`);
  // The adapter may improve a homepage to a key-console URL; every other source field is preserved.
  for (const field of Object.keys(p).filter((field) => !["get", "deepLink"].includes(field))) {
    assert.deepEqual(adapted[field], p[field], `${p.slug}: adapter preserves ${field}`);
  }
  if (p.deepLink) assert.equal(adapted.get, p.get, `${p.slug}: explicit upstream key link wins`);
  for (const field of ["website", "get", "signupUrl"]) if (adapted[field]) {
    const url = new URL(adapted[field]);
    assert.ok(["http:", "https:"].includes(url.protocol), `${p.slug}.${field}`);
    assert.equal(url.username + url.password, "");
  }
  checkSource(p.source);
  if (p.flowSource) checkSource(p.flowSource);
  if (p.extractionSource) checkSource(p.extractionSource);
  for (const source of p.captureEvidence || []) checkSource(source);
}

const captureCounts = { cookie: 0, token: 0, dashboard: 0 };
for (const w of gen.web) {
  assert.ok(Object.hasOwn(captureCounts, w.capture), `${w.slug}: explicit capture outcome`);
  captureCounts[w.capture]++;
  const p = OMNI_WEB_MAP[w.slug], re = p.hostRe;
  assert.equal(p.cred.t, w.capture);
  assert.equal(p.cred.name, w.valueCookie || "");
  assert.equal(re.source, new RegExp(w.hostReSrc).source);
  assert.ok(w.captureReason && w.captureEvidence.length, `${w.slug}: setup reason/evidence`);
  if (w.capture === "dashboard") {
    for (const field of ["captureUrls", "capturePerms", "perms", "sources", "cookieGroups"]) assert.deepEqual(w[field], [], `${w.slug}.${field}`);
    assert.equal(w.host, "");
    for (const url of [w.site, "https://example.test/", ...gen.web.flatMap((p) => p.captureUrls)]) assert.equal(re.test(url), false, `${w.slug}: dashboard cannot match ${url}`);
    assert.equal(omniHasSession(p, { cookie: "sessionKey=synthetic; __client=synthetic", token: "synthetic-token" }), false);
    assert.equal(omniBuildCredential(p, { cookie: "sessionKey=synthetic", token: "synthetic-token" }), "");
    continue;
  }
  assert.ok(w.captureUrls.length, `${w.slug}: reviewed request hosts`);
  const hosts = [...new Set(w.captureUrls.map((url) => new URL(url).hostname))].sort();
  assert.ok(hosts.includes(w.host));
  const requestPerms = hosts.map((host) => `https://${host}/*`);
  const site = new URL(w.site);
  assert.equal(site.protocol, "https:");
  assert.equal(site.port + site.username + site.password, "");
  assert.deepEqual(w.capturePerms, requestPerms, `${w.slug}: listener filters only exact reviewed request hosts`);
  assert.deepEqual(w.perms, [...new Set([...requestPerms, `${site.origin}/*`])].sort(), `${w.slug}: permissions cover request hosts and the exact initiator site`);
  for (const url of w.captureUrls) {
    const u = new URL(url);
    assert.equal(u.protocol, "https:"); assert.equal(u.port + u.username + u.password, "");
    assert.ok(re.test(url), `${w.slug}: matches reviewed URL ${url}`);
    assert.ok(re.test(`https://${u.hostname}/api/synthetic`), `${w.slug}: matches requests on the reviewed host`);
    for (const wrong of [`http://${u.hostname}/`, `https://extra.${u.hostname}/`, `https://${u.hostname}.wrong.test/`, `https://${u.hostname}:9443/`, `https://${u.hostname}@wrong.test/`, `https://${u.hostname.replaceAll(".", "-")}/`]) {
      assert.equal(re.test(wrong), false, `${w.slug}: rejects wrong host ${wrong}`);
    }
  }
  assert.equal(re.test(w.site), hosts.includes(new URL(w.site).hostname), `${w.slug}: homepage grants no extra capture access`);
  assert.equal(omniHasSession(p, { cookie: "_ga=synthetic" }), false, `${w.slug}: analytics are not a session`);
  if (w.capture === "token") {
    assert.deepEqual(w.sources, [{ type: "header", name: "Authorization" }]);
    for (const cap of [{ cookie: "session=synthetic" }, { token: "  ", cookie: "session=synthetic" }]) assert.equal(omniBuildCredential(p, cap), "", `${w.slug}: no Cookie fallback for Bearer`);
    assert.equal(omniBuildCredential(p, { token: "  synthetic-bearer  ", cookie: "unrelated=synthetic" }), "synthetic-bearer");
  } else {
    assert.ok(w.cookieGroups.length && w.cookieGroups.every((group) => group.length), `${w.slug}: nonempty AND-of-OR requirements`);
    const pairs = w.cookieGroups.map((group, i) => [group[0], `synthetic-${i}==`]);
    const header = (values) => "_ga=synthetic; " + values.map(([name, value]) => `${name}=${value}`).join("; ");
    assert.equal(omniHasSession(p, { cookie: header(pairs) }), true, `${w.slug}: complete session`);
    assert.equal(omniBuildCredential(p, { cookie: header(pairs) }), w.valueCookie ? new Map(pairs).get(w.valueCookie) : header(pairs), `${w.slug}: value-only vs Cookie-header import`);
    for (let i = 0; i < pairs.length; i++) {
      assert.equal(omniBuildCredential(p, { cookie: header(pairs.filter((_, j) => i !== j)), token: "synthetic-bearer" }), "", `${w.slug}: missing required group ${i} cannot use Bearer fallback`);
      for (const alias of w.cookieGroups[i]) {
        const alternative = pairs.map((pair, j) => i === j ? [alias, pair[1]] : pair);
        assert.equal(omniHasSession(p, { cookie: header(alternative) }), true, `${w.slug}: accepts alias ${alias} within its required group`);
      }
    }
  }
}
const captureInventory = {
  cookie: ["adapta-web", "blackbox-web", "claude-web", "conol-web", "gemini-web", "grok-web", "huggingchat", "notion-web", "notrack-web", "perplexity-web", "poe-web", "v0-vercel-web", "venice-web", "yuanbao-web", "zenmux-free"],
  token: ["chatplayground", "copilot-web", "deepseek-web", "kimi-web", "promptql", "syntx"],
  dashboard: ["adobe-firefly", "chatgpt-web", "chatgpt-web-codex", "copilot-m365-web", "doubao-web", "hyperagent", "inner-ai", "lmarena", "maxai", "muse-spark-web", "t3-web", "tencent-aistudio-web", "tinycms-web", "twinmind", "uc", "zai-web"],
};
for (const [mode, expected] of Object.entries(captureInventory)) {
  assert.deepEqual(ids(gen.web.filter((p) => p.capture === mode)), expected, `${mode}: pinned reviewed capability inventory`);
}
assert.deepEqual(ids(OMNI_CAPTURE_WEB), ids(gen.web.filter((p) => p.capture !== "dashboard")));
const fixedHosts = ["http://127.0.0.1/*", "https://aistudio.google.com/*"];
assert.deepEqual(manifest.host_permissions, [...fixedHosts, ...[...new Set(gen.web.flatMap((p) => p.perms))].filter((p) => !fixedHosts.includes(p)).sort()], "manifest and validated capture permissions agree");
for (const slug of ["adapta-web", "chatplayground", "promptql", "syntx", "venice-web"]) {
  const p = OMNI_WEB_MAP[slug], initiator = `${new URL(p.site).origin}/*`;
  assert.ok(p.perms.includes(initiator), `${slug}: Chrome can observe requests initiated by the app`);
  assert.ok(!p.capturePerms.includes(initiator), `${slug}: the app permission does not broaden the request filter`);
  assert.equal(p.hostRe.test(p.site), false, `${slug}: app traffic is not the reviewed credential source`);
}
assert.equal(OMNI_WEB_MAP["chatgpt-web"].cred.t, "dashboard", "registered ChatGPT uses native storage-state setup");
assert.equal(OMNI_WEB_MAP["perplexity-web"].cred.name, "__Secure-next-auth.session-token");

// Cookie chunk reconstruction must start at zero and be contiguous within a single supplied header.
const named = OMNI_WEB_MAP["perplexity-web"], name = named.cred.name;
assert.equal(omniBuildCredential(named, { cookie: `${name}.1=tail==; _ga=synthetic; ${name}.0=head-` }), "head-tail==");
for (const cookie of [`${name}.1=tail`, `${name}.0=head; ${name}.2=tail`, `${name}.0=; ${name}.1=tail`, `${name}.extra=synthetic`]) {
  assert.equal(omniBuildCredential(named, { cookie }), "", `invalid chunk sequence: ${cookie}`);
}
assert.equal(omniCookieValue(`${name}=whole==; ${name}.0=ignored`, name), "whole==", "a complete named value wins and preserves '=' padding");
assert.equal(omniCookieValue(`prefix-${name}=synthetic`, name), "", "cookie names are exact");
assert.equal(omniBuildCredential(named, { cookie: "__Secure-authjs.session-token=synthetic-other-format" }), "", "Perplexity accepts the reviewed next-auth cookie, not an inferred Auth.js alias");

const kinds = { device_code: "device", authorization_code: "redirect", authorization_code_pkce: "redirect", import_token: "import" };
const split = { device: 0, redirect: 0, import: 0 };
for (const o of gen.oauth) {
  assert.ok(Object.hasOwn(kinds, o.flowType), `${o.slug}: recognized flow`);
  assert.ok(["inline", "dashboard"].includes(o.oauthSetup));
  assert.equal(typeof o.tokenImport, "boolean", `${o.slug}: source route import capability`);
  assert.equal(OMNI_OAUTH_MAP[o.slug].kind, kinds[o.flowType]);
  assert.equal(OMNI_OAUTH_MAP[o.slug].dashboardOnly, o.oauthSetup === "dashboard");
  if (o.flowType === "import_token" && o.oauthSetup === "inline") assert.equal(o.tokenImport, true);
  split[kinds[o.flowType]]++;
}
for (const kind of Object.keys(split)) assert.ok(split[kind] > 0, `shipped OAuth includes ${kind}`);
assert.deepEqual(ids(gen.oauth.filter((p) => p.tokenImport)), ["agy", "antigravity", "claude", "devin-cli", "devin-desktop", "grok-cli"], "pinned upstream token-import action set");
assert.deepEqual(ids(gen.oauth.filter((p) => p.flowType === "import_token" && p.oauthSetup === "inline")), ["devin-cli", "devin-desktop"], "a registered import flow is not necessarily supported inline");
assert.deepEqual(ids(gen.oauth.filter((p) => p.flowType.startsWith("authorization_code") && p.oauthSetup === "inline")), ["codex", "openference", "xai-oauth"], "inline redirects require an allowed callback endpoint");
for (const a of gen.apikey) {
  assert.ok(typeof a.family === "string" && a.family.trim(), `${a.slug}: family label`);
  assert.ok(["inline", "dashboard"].includes(a.keySetup));
  assert.equal(OMNI_APIKEY_MAP[a.slug].dashboardOnly, a.keySetup === "dashboard");
}
for (const p of gen.all.filter((p) => ["no-auth", "local"].includes(p.category))) assert.equal(p.keyOptional, true, p.slug);
assert.equal(OMNI_APIKEY_MAP["google-pse-search"].bulk, false, "upstream excludes PSE from bulk import");
assert.ok(OMNI_APIKEY_MAP["google-pse-search"].extra.some((f) => f.key === "cx" && f.required));
assert.ok(OMNI_APIKEY_MAP["cloudflare-ai"].extra.some((f) => f.key === "accountId" && f.required));
assert.equal(OMNI_APIKEY_MAP["cloudflare-ai"].bulk, true);
assert.equal(OMNI_APIKEY_MAP["azure-openai"].dashboardOnly, true);
for (const slug of ["heroku", "databricks", "snowflake"]) assert.equal(OMNI_APIKEY_MAP[slug].dashboardOnly, true, `${slug}: required resource/endpoint configuration cannot use a bare-key form`);
assert.equal(OMNI_OAUTH_MAP.cursor.dashboardOnly, true);
assert.equal(OMNI_CATALOG_MAP.cline.keySetup, "inline");
assert.equal(OMNI_CATALOG_MAP.cline.oauthSetup, "dashboard");
assert.equal(Object.hasOwn(OMNI_CATALOG_MAP.cline, "dashboardOnly"), false, "directory metadata keeps method-specific capabilities instead of a merged gating flag");
for (const p of gen.all.filter((p) => ["search", "audio", "cloud-agent", "system"].includes(p.category))) {
  assert.equal(p.probeKind, "dashboard", `${p.slug}: specialized services are not verified by a chat probe`);
}
for (const slug of ["openai", "claude-web", "cloudflare-ai"]) {
  assert.ok(byId.get(slug).serviceKinds.includes("llm"));
  assert.equal(byId.get(slug).probeKind, "chat", `${slug}: upstream llm services remain probeable`);
}
const freeCount = gen.apikey.filter((a) => a.free).length;
assert.ok(freeCount > 0 && freeCount < gen.apikey.length, "free-tier flags remain a meaningful subset");

// Stable account ID checks continue to exercise the shipped implementation.
const jwt = "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify({ sub: "user-42!!" })).toString("base64").replace(/\+/g, "-").replace(/\//g, "_") + ".sig";
assert.equal(omniAccountId(jwt), "user42", "accountId from JWT sub, sanitized");
assert.equal(omniAccountId("abc"), omniAccountId("abc"), "accountId stable");
assert.notEqual(omniAccountId("abc"), omniAccountId("abd"), "accountId distinguishes credentials");
assert.equal(omniAccountIdStable(jwt), true);
assert.equal(omniAccountIdStable("synthetic-opaque-cookie"), false, "credential hash is not proof of account identity");

// Optional source-to-artifact verification is explicit and local-only. The ordinary suite needs no
// OmniRoute checkout, global npm discovery or running gateway; --ref reads the local Git object only.
if (process.env.OMNI_ROOT) {
  const { ProviderSource } = await import("./provider-source.mjs");
  const { generateCatalog } = await import("./gen-providers.mjs");
  const source = generateCatalog(new ProviderSource(process.env.OMNI_ROOT, { ref: pinnedRef }));
  assert.deepEqual(gen.all, source.all, "every shipped source field matches the selected pinned checkout");
  assert.deepEqual(coverage, { provenance: source.provenance, ...source.coverage }, "coverage report matches the pinned source");
  for (const kind of ["web", "apikey", "oauth", "other"]) assert.deepEqual(ids(gen[kind]), ids(source[kind]), `${kind}: source membership`);
}

console.log(`catalog OK — ${gen.all.length} unique providers, ${coverage.sections.length} sections, report/adapter parity; capture=${JSON.stringify(captureCounts)}, OAuth=${JSON.stringify(split)}`);
