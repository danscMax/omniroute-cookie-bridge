// Whole-registry fixtures: real source reader/generator, synthetic files, no gateway or credentials.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { generateCatalog, emitCatalog, locateOmni } from "./gen-providers.mjs";
import { ProviderSource } from "./provider-source.mjs";

const REGISTRY = "src/shared/constants/providers.ts";
const OAUTH_ROUTE = "src/app/api/oauth/[provider]/[action]/route.ts";
const PROOF = "open-sse/executors/fixture-web.ts";
const SECTIONS = [
  ["NOAUTH_PROVIDERS", "no-auth", ["anonymous", "free-key"]],
  ["OAUTH_PROVIDERS", "oauth", ["alias", "browser", "browser-alias", "custom", "device", "ghe-copilot", "import-alias", "import-ok", "legacy-browser"]],
  ["APIKEY_PROVIDERS", "apikey", ["aliased-key", "azure-openai", "free", "paid"]],
  ["WEB_COOKIE_PROVIDERS", "web-cookie", ["cookie-web", "manual-web", "named-web", "token-web", "unknown-web"]],
  ["LOCAL_PROVIDERS", "local", ["local"]],
  ["SEARCH_PROVIDERS", "search", ["search"]],
  ["AUDIO_ONLY_PROVIDERS", "audio", ["audio"]],
  ["UPSTREAM_PROXY_PROVIDERS", "upstream-proxy", ["proxy"]],
  ["CLOUD_AGENT_PROVIDERS", "cloud-agent", ["agent"]],
  ["SYSTEM_PROVIDERS", "system", ["auto"]],
];
const slugs = (rows) => rows.map((p) => p.slug);
const find = (c, slug) => { const p = c.all.find((p) => p.slug === slug); assert.ok(p, `Missing ${slug}`); return p; };
const hash = (text) => createHash("sha256").update(text).digest("hex");

function fixture(run) {
  const root = mkdtempSync(join(process.env.BRIDGE_TEST_TMPDIR || tmpdir(), "bridge-generator-"));
  const inputs = new Map();
  const put = (name, text) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
    if (!name.startsWith("extension/")) inputs.set(name, text);
  };
  const replace = (name, from, to) => {
    const text = readFileSync(join(root, name), "utf8");
    assert.ok(text.includes(from), `Fixture replacement must exist: ${from}`);
    put(name, text.replace(from, to));
  };
  try {
    put(REGISTRY, `
      import { APIKEY_PROVIDERS } from './providers/apikey';
      export { APIKEY_PROVIDERS };
      export const WEB_COOKIE_PROVIDERS = {
        'cookie-web': { id: 'cookie-web', name: 'Cookie Web', website: 'https://chat.example.test', authHint: 'Use the session cookie' },
        'named-web': { id: 'named-web', name: 'Named Cookie', website: 'https://named.example.test' },
        'token-web': { id: 'token-web', name: 'Token Web', website: 'https://copilot.microsoft.com' },
        'manual-web': { id: 'manual-web', name: 'Manual Web', website: 'https://manual.example.test', authHint: 'Import storage-state JSON' },
        'unknown-web': { id: 'unknown-web', name: 'Unknown Web', website: 'https://unknown.example.test' }
      };
      export const OAUTH_PROVIDERS = {
        device: { id: 'device', name: 'Device' }, alias: { id: 'alias', name: 'Alias', oauthProviderId: 'device' },
        browser: { id: 'browser', name: 'Browser' }, 'browser-alias': { id: 'browser-alias', name: 'Browser alias', oauthProviderId: 'browser' },
        'legacy-browser': { id: 'legacy-browser', name: 'Legacy Browser' }, custom: { id: 'custom', name: 'Custom sign-in' },
        'import-ok': { id: 'import-ok', name: 'Token import' }, 'import-alias': { id: 'import-alias', name: 'Token alias', oauthProviderId: 'import-ok' },
        'ghe-copilot': { id: 'ghe-copilot', name: 'Enterprise device setup' }
      };
      export const SEARCH_PROVIDERS = { search: { id: 'search', name: 'Search', website: 'https://search.example.test', serviceKinds: ['webSearch'], apiKeyUrl: 'https://search.example.test/old-keys', notice: { apiKeyUrl: 'https://search.example.test/keys', signupUrl: 'https://search.example.test/join', text: 'Source guidance' } } };
      export const AUDIO_ONLY_PROVIDERS = { audio: { id: 'audio', name: 'Audio', website: 'https://audio.example.test', serviceKinds: ['tts'] } };
      export const LOCAL_PROVIDERS = { local: { id: 'local', name: 'Local', localDefault: 'http://localhost:1234/v1' } };
      export const NOAUTH_PROVIDERS = { anonymous: { id: 'anonymous', name: 'Anonymous', noAuth: true }, 'free-key': { id: 'free-key', name: 'Optional free key', noAuth: true, hasFree: true } };
      export const UPSTREAM_PROXY_PROVIDERS = { proxy: { id: 'proxy', name: 'Proxy' } };
      export const CLOUD_AGENT_PROVIDERS = { agent: { id: 'agent', name: 'Agent', authHint: 'Use native project setup' } };
      export const SYSTEM_PROVIDERS = { auto: { id: 'auto', name: 'Auto', systemOnly: true } };
      export const FUTURE_PROVIDERS = { future: { id: 'future', name: 'Future category' } };
      const CORE_SECTIONS = [NOAUTH_PROVIDERS, OAUTH_PROVIDERS, APIKEY_PROVIDERS, WEB_COOKIE_PROVIDERS] as const;
      const EXTRA_SECTIONS = [LOCAL_PROVIDERS, SEARCH_PROVIDERS, AUDIO_ONLY_PROVIDERS, UPSTREAM_PROXY_PROVIDERS, CLOUD_AGENT_PROVIDERS, SYSTEM_PROVIDERS] as const;
      const _PROVIDER_SECTIONS = [...CORE_SECTIONS, ...EXTRA_SECTIONS] as const;
      const DUAL_AUTH_PROVIDER_IDS = new Set(['device', 'cookie-web']);
      export const FREE_APIKEY_PROVIDER_IDS = new Set(['free-key']);
      const EXPLICIT_OPTIONAL_APIKEY_PROVIDER_IDS = new Set(['search']);
      const BULK_API_KEY_EXCLUDED = new Set(['search', 'no-bulk-alias']);
      throw new Error('Never execute registry modules');
    `);
    put("src/shared/constants/providers/apikey/index.ts", `import { rows } from './gateways'; export const APIKEY_PROVIDERS = { ...rows };`);
    put("src/shared/constants/providers/apikey/gateways.ts", `export const rows = {
      paid: { website: 'https://paid.example.test', name: 'Paid', id: 'paid', hasFree: false, serviceKinds: ['llm'], authHint: 'A long hint ' + '${"x".repeat(1100)}', apiHint: 'Endpoint guidance' },
      free: { id: 'free', name: 'Free', website: 'https://free.example.test', hasFree: true, serviceKinds: ['image'], freeNote: 'Limited trial', notice: { apiKeyUrl: 'https://free.example.test/keys' } },
      'aliased-key': { id: 'aliased-key', name: 'Aliased key', alias: 'no-bulk-alias' },
      'azure-openai': { id: 'azure-openai', name: 'Azure resource setup' }
    };`);
    put("src/lib/providers/catalog.ts", `import { NOAUTH_PROVIDERS, OAUTH_PROVIDERS, APIKEY_PROVIDERS, WEB_COOKIE_PROVIDERS, LOCAL_PROVIDERS, SEARCH_PROVIDERS, AUDIO_ONLY_PROVIDERS, UPSTREAM_PROXY_PROVIDERS, CLOUD_AGENT_PROVIDERS } from '@/shared/constants/providers';
      export const STATIC_PROVIDER_CATALOG_GROUPS = {
        'no-auth': { providers: NOAUTH_PROVIDERS }, oauth: { providers: OAUTH_PROVIDERS }, apikey: { providers: APIKEY_PROVIDERS },
        'web-cookie': { providers: WEB_COOKIE_PROVIDERS }, local: { providers: LOCAL_PROVIDERS }, search: { providers: SEARCH_PROVIDERS },
        audio: { providers: AUDIO_ONLY_PROVIDERS }, 'upstream-proxy': { providers: UPSTREAM_PROXY_PROVIDERS }, 'cloud-agent': { providers: CLOUD_AGENT_PROVIDERS }
      };
      const MANAGED_PROVIDER_CONNECTION_CATEGORIES = new Set(['apikey', 'web-cookie', 'local', 'search', 'audio', 'upstream-proxy', 'cloud-agent']);
    `);
    put("open-sse/services/tokenExtractionConfig.ts", `const RAW_CONFIGS = [
      config('cookie-web', 'Cookie Web', 'https://chat.example.test/login', 'https://chat.example.test', [{ name: 'unreviewed_cookie', type: 'cookie', domain: '.example.test' }], 'Cookie instructions'),
      config('token-web', 'Token Web', 'https://copilot.microsoft.com', 'https://copilot.microsoft.com', [{ type: 'header', name: 'Authorization' }], 'Bearer instructions'),
      config('manual-web', 'Manual Web', 'https://unreviewed.example.test/login', 'https://manual.example.test', [{ type: 'localStorage', key: 'browserState' }], 'Composite setup'),
      config('unknown-web', 'Unknown Web', 'https://unknown.example.test/login', 'https://unknown.example.test', [{ type: 'cookie', name: 'session' }], 'Unreviewed extraction'),
      config('orphan-web', 'Orphan', 'https://orphan.example.test', 'https://orphan.example.test', [{ type: 'cookie', name: 'session' }], 'No longer registered'),
      config('free-key', 'Free key', 'https://free.example.test', 'https://free.example.test', [], 'Not a web connection')
    ];`);
    put("src/lib/oauth/providers/index.ts", `import { device, browser, importer, legacyBrowser } from './shared'; export const PROVIDERS = { device, alias: device, browser, 'browser-alias': browser, 'cookie-web': browser, 'ghe-copilot': device, 'import-ok': importer, 'import-alias': importer, 'legacy-browser': legacyBrowser };`);
    put("src/lib/oauth/providers/shared.ts", `export const device = { flowType: 'device_code' as const }; function makeBrowser() { return { flowType: 'authorization_code_pkce' }; } export const browser = makeBrowser(); export const importer = { flowType: 'import_token' }; export const legacyBrowser = { flowType: 'authorization_code' };`);
    put("src/lib/oauth/providers/unregistered.ts", `export const provider = { flowType: 'device_code' }; throw new Error('Not registered');`);
    put(OAUTH_ROUTE, `const CALLBACK_IDS = ['browser', 'legacy-browser', 'cookie-web'] as const;
      const PKCE_CALLBACK_PROVIDERS = new Set([...CALLBACK_IDS]);
      const IMPORT_TOKEN_PROVIDERS = new Set(['import-ok']);
      throw new Error('Never execute OAuth routes');`);
    put(PROOF, [
      'export const COOKIE_URLS = ["https://chat.example.test/", "https://auth.example.test/session"];',
      'export const COOKIE_NAMES = ["session", "session_alt", "client"];',
      'export const NAMED = { url: "https://clerk.named.example.test/", cookie: "__client" };',
      'export const TOKEN = { url: "https://copilot.microsoft.com/", header: "Authorization", scheme: "Bearer " };',
      'export const ORPHAN = { url: "https://orphan.example.test/", cookie: "session" };',
      "throw new Error('Evidence is read, never executed');",
    ].join("\n"));
    const capabilities = {
      "cookie-web": { capture: "cookie", urls: ["https://chat.example.test/", "https://auth.example.test/session", "https://chat.example.test/api"], cookieGroups: [["session", "session_alt"], ["client"]], reason: "Synthetic Cookie header contract", evidence: [{ file: PROOF, line: 1, contains: ['"https://chat.example.test/"', '"https://auth.example.test/session"', '"session"', '"session_alt"', '"client"'] }] },
      "named-web": { capture: "cookie", urls: ["https://clerk.named.example.test/"], cookieGroups: [["__client"]], valueCookie: "__client", reason: "Synthetic named-cookie contract", evidence: [{ file: PROOF, line: 3, contains: ['"https://clerk.named.example.test/"', '"__client"'] }] },
      "token-web": { capture: "token", urls: ["https://copilot.microsoft.com/"], reason: "Synthetic Bearer contract", evidence: [{ file: PROOF, line: 4, contains: ['"https://copilot.microsoft.com/"', '"Authorization"', '"Bearer "'] }] },
      "manual-web": { capture: "dashboard", reason: "Requires browser storage state", evidence: [] },
      "orphan-web": { capture: "cookie", urls: ["https://orphan.example.test/"], cookieGroups: [["session"]], reason: "Not registered", evidence: [{ file: PROOF, line: 5, contains: ['"https://orphan.example.test/"', '"session"'] }] },
    };
    const output = join(root, "extension");
    put("extension/manifest.json", JSON.stringify({ manifest_version: 3, version: "1.0.0", permissions: ["cookies"], host_permissions: ["https://stale.example.test/*"] }));
    return run({ root, put, replace, output, inputs, capabilities, generate: (webCapabilities = capabilities) => generateCatalog(new ProviderSource(root), { webCapabilities }) });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("all ten registered sections retain exact IDs, categories and overlapping onboarding lists", () => fixture(({ generate }) => {
  const c = generate(), expected = SECTIONS.flatMap(([, , ids]) => ids).sort();
  assert.deepEqual(slugs(c.all), expected);
  assert.equal(new Set(slugs(c.all)).size, expected.length);
  assert.equal(c.coverage.total, expected.length);
  assert.deepEqual(c.coverage.sections.map(({ name, category, count }) => [name, category, count]), SECTIONS.map(([name, category, ids]) => [name, category, ids.length]));
  for (const [, category, ids] of SECTIONS) assert.deepEqual(slugs(c.all.filter((p) => p.category === category)), ids);
  assert.deepEqual(slugs(c.coverage.providers), expected);
  assert.deepEqual(slugs(c.apikey), ["agent", "aliased-key", "audio", "azure-openai", "cookie-web", "device", "free", "free-key", "paid", "proxy", "search"]);
  assert.deepEqual(slugs(c.other), ["anonymous", "auto", "custom", "local"]);
  assert.deepEqual([...new Set([...c.web, ...c.apikey, ...c.oauth, ...c.other].map((p) => p.slug))].sort(), expected);
  for (const rows of [c.web, c.apikey, c.oauth, c.other]) for (const p of rows) assert.equal(p, find(c, p.slug), "Overlapping lists share one metadata record");
  assert.equal(find(c, "cookie-web").onboarding, "web");
  assert.equal(find(c, "device").onboarding, "oauth");
  assert.equal(c.all.some((p) => ["future", "orphan-web", "unregistered"].includes(p.slug)), false);
  assert.deepEqual(slugs(c.coverage.excludedExtraction), ["orphan-web", "free-key"]);
  assert.match(c.coverage.excludedExtraction[0].reason, /Not registered/);
  assert.match(c.coverage.excludedExtraction[1].reason, /no-auth/);
}));

test("new registered sections become discoverable without a hardcoded category allowlist", () => fixture(({ replace, generate }) => {
  replace(REGISTRY, "CLOUD_AGENT_PROVIDERS, SYSTEM_PROVIDERS]", "CLOUD_AGENT_PROVIDERS, SYSTEM_PROVIDERS, FUTURE_PROVIDERS]");
  const c = generate();
  assert.equal(c.coverage.sections.length, SECTIONS.length + 1);
  assert.equal(find(c, "future").category, "other");
  assert.equal(find(c, "future").onboarding, "dashboard");
  assert.ok(c.other.includes(find(c, "future")));
}));

test("object-boundary metadata, imported rows, free flags and source guidance survive generation", () => fixture(({ generate }) => {
  const c = generate(), paid = find(c, "paid"), free = find(c, "free"), search = find(c, "search");
  assert.equal(paid.free, false);
  assert.equal(paid.freeNote, "");
  assert.equal(paid.notice, "");
  assert.equal(paid.get, "https://paid.example.test");
  assert.equal(paid.authHint, "A long hint " + "x".repeat(1100));
  assert.equal(paid.apiHint, "Endpoint guidance");
  assert.deepEqual(paid.serviceKinds, ["llm"]);
  assert.equal(paid.probeKind, "chat", "upstream names the chat service kind llm");
  assert.equal(paid.source.file, "src/shared/constants/providers/apikey/gateways.ts");
  assert.equal(free.free, true);
  assert.equal(free.freeNote, "Limited trial");
  assert.equal(free.authHint, "");
  assert.equal(free.get, "https://free.example.test/keys");
  for (const slug of ["free", "search", "audio", "agent", "auto"]) assert.equal(find(c, slug).probeKind, "dashboard", `${slug}: specialized service cannot be checked by chat`);
  assert.equal(search.get, "https://search.example.test/keys");
  assert.equal(search.deepLink, true);
  assert.equal(search.signupUrl, "https://search.example.test/join");
  assert.equal(search.notice, "Source guidance");
  assert.deepEqual(search.serviceKinds, ["webSearch"]);
  assert.equal(find(c, "local").localDefault, "http://localhost:1234/v1");
  assert.equal(find(c, "alias").oauthProviderId, "device");
  assert.equal(find(c, "manual-web").loginUrl, "https://manual.example.test", "Unreviewed cross-host login URL does not replace the registered site");
  assert.equal(find(c, "cookie-web").instructions, "Use the session cookie");
  assert.equal(find(c, "token-web").instructions, "Bearer instructions");
}));

test("optional/no-auth and dual-auth keys are included without granting bulk or generic native setup", () => fixture(({ generate }) => {
  const c = generate();
  for (const slug of ["anonymous", "free-key", "local", "search"]) assert.equal(find(c, slug).keyOptional, true, slug);
  for (const slug of ["paid", "device", "cookie-web"]) assert.equal(find(c, slug).keyOptional, false, slug);
  for (const slug of ["device", "cookie-web", "free-key"]) assert.ok(c.apikey.includes(find(c, slug)), slug);
  for (const slug of ["alias", "anonymous", "local", "token-web"]) assert.ok(!c.apikey.includes(find(c, slug)), slug);
  for (const slug of ["search", "aliased-key", "free-key", "local"]) assert.equal(find(c, slug).bulk, false, slug);
  for (const slug of ["paid", "device", "cookie-web", "proxy"]) assert.equal(find(c, slug).bulk, true, slug);
  assert.equal(find(c, "aliased-key").alias, "no-bulk-alias");
  assert.equal(find(c, "azure-openai").keySetup, "dashboard");
  assert.equal(find(c, "agent").keySetup, "dashboard");
  assert.equal(find(c, "paid").keySetup, "inline");
}));

test("OAuth aliases retain exact IDs and only allowed imports/callbacks are inline", () => fixture(({ generate, put }) => {
  const c = generate();
  assert.deepEqual(c.oauth.map((p) => [p.slug, p.flowType, p.oauthSetup]), [
    ["alias", "device_code", "inline"], ["browser", "authorization_code_pkce", "inline"],
    ["browser-alias", "authorization_code_pkce", "dashboard"], ["cookie-web", "authorization_code_pkce", "inline"],
    ["device", "device_code", "inline"], ["ghe-copilot", "device_code", "dashboard"],
    ["import-alias", "import_token", "dashboard"], ["import-ok", "import_token", "inline"], ["legacy-browser", "authorization_code", "inline"],
  ]);
  assert.equal(find(c, "alias").label, "Alias");
  assert.equal(find(c, "alias").flowSource.file, "src/lib/oauth/providers/shared.ts");
  assert.deepEqual(find(c, "alias").flowSource, find(c, "device").flowSource);
  assert.deepEqual(c.oauth.filter((p) => p.tokenImport).map((p) => p.slug), ["import-ok"], "token import is a separate source action allowlist");
  put(OAUTH_ROUTE, `const PKCE_CALLBACK_PROVIDERS = new Set(['browser-alias']); const IMPORT_TOKEN_PROVIDERS = new Set(['import-alias']);`);
  const changed = generate();
  for (const slug of ["browser", "legacy-browser", "cookie-web", "import-ok"]) assert.equal(find(changed, slug).oauthSetup, "dashboard", slug);
  for (const slug of ["browser-alias", "import-alias"]) assert.equal(find(changed, slug).oauthSetup, "inline", slug);
  assert.deepEqual(changed.oauth.filter((p) => p.tokenImport).map((p) => p.slug), ["import-alias"]);
}));

test("reviewed request filters stay narrow while permissions also cover the exact initiator site", () => fixture(({ generate, output }) => {
  const c = generate(), cookie = find(c, "cookie-web"), named = find(c, "named-web"), token = find(c, "token-web");
  assert.deepEqual(cookie.capturePerms, ["https://auth.example.test/*", "https://chat.example.test/*"]);
  assert.deepEqual(cookie.perms, ["https://auth.example.test/*", "https://chat.example.test/*"]);
  assert.deepEqual(cookie.cookieGroups, [["session", "session_alt"], ["client"]]);
  assert.deepEqual(cookie.sources, ["session", "session_alt", "client"].map((name) => ({ type: "cookie", name })));
  assert.equal(cookie.upstreamSources[0].name, "unreviewed_cookie", "Extraction metadata does not override the reviewed recipe");
  assert.equal(named.valueCookie, "__client");
  assert.deepEqual(named.capturePerms, ["https://clerk.named.example.test/*"]);
  assert.deepEqual(named.perms, ["https://clerk.named.example.test/*", "https://named.example.test/*"]);
  assert.equal(token.capture, "token");
  assert.deepEqual(token.capturePerms, ["https://copilot.microsoft.com/*"]);
  assert.deepEqual(token.perms, token.capturePerms);
  assert.deepEqual(token.sources, [{ type: "header", name: "Authorization" }]);
  assert.deepEqual(token.cookieGroups, []);
  for (const p of [cookie, named, token]) {
    const re = new RegExp(p.hostReSrc, "i");
    for (const url of p.captureUrls) {
      assert.ok(re.test(url), `${p.slug}: ${url}`);
      const host = new URL(url).hostname;
      for (const wrong of [`http://${host}/`, `https://extra.${host}/`, `https://${host}.wrong.test/`, `https://${host}:9443/`, `https://${host}@wrong.test/`]) assert.equal(re.test(wrong), false, wrong);
    }
  }
  assert.equal(new RegExp(named.hostReSrc).test(named.site), false, "initiator permission does not enable capture from the application homepage");
  emitCatalog(c, output);
  const mf = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  assert.deepEqual(mf.host_permissions, ["http://127.0.0.1/*", "https://aistudio.google.com/*", "https://auth.example.test/*", "https://chat.example.test/*", "https://clerk.named.example.test/*", "https://copilot.microsoft.com/*", "https://named.example.test/*"]);
  assert.deepEqual(mf.permissions, ["cookies"]);
}));

test("unknown recipes and explicit dashboard setups cannot capture, even with extraction metadata", () => fixture(({ root, generate }) => {
  const c = generate();
  for (const slug of ["unknown-web", "manual-web"]) {
    const p = find(c, slug);
    assert.equal(p.capture, "dashboard");
    for (const field of ["captureUrls", "capturePerms", "perms", "sources", "cookieGroups"]) assert.deepEqual(p[field], [], `${slug}.${field}`);
    assert.equal(new RegExp(p.hostReSrc).test(p.site), false);
    assert.deepEqual(p.captureEvidence, [p.source]);
  }
  assert.match(find(c, "unknown-web").captureReason, /No reviewed/);
  assert.equal(find(c, "manual-web").captureReason, "Requires browser storage state");
  const defaults = generateCatalog(new ProviderSource(root));
  assert.ok(defaults.web.every((p) => p.capture === "dashboard"), "Production recipes must not infer support for synthetic IDs");
  assert.ok(generate({}).web.every((p) => p.perms.length === 0));
}));

test("a changed evidence marker revokes capture and its permissions without dropping the provider", () => fixture(({ replace, generate, output }) => {
  const before = generate();
  emitCatalog(before, output);
  replace(PROOF, '"__client"', '"different_cookie"');
  const after = generate(), named = find(after, "named-web");
  assert.deepEqual(slugs(after.all), slugs(before.all));
  assert.equal(named.capture, "dashboard");
  assert.match(named.captureReason, /changed|unavailable/);
  assert.deepEqual(named.capturePerms, []);
  assert.deepEqual(named.perms, []);
  assert.equal(find(after, "cookie-web").capture, "cookie");
  assert.equal(find(after, "token-web").capture, "token");
  assert.notEqual(after.provenance.sha256, before.provenance.sha256);
  assert.throws(() => emitCatalog(after, output, true), /stale/);
  emitCatalog(after, output);
  const permissions = JSON.parse(readFileSync(join(output, "manifest.json"))).host_permissions;
  for (const permission of ["https://clerk.named.example.test/*", "https://named.example.test/*"]) {
    assert.ok(!permissions.includes(permission), `invalidated recipe revokes request and initiator permission: ${permission}`);
  }
}));

test("missing evidence files or empty evidence lists fail closed", () => fixture(({ root, generate, capabilities }) => {
  const noProof = { ...capabilities, "named-web": { ...capabilities["named-web"], evidence: [] } };
  assert.equal(find(generate(noProof), "named-web").capture, "dashboard");
  rmSync(join(root, PROOF));
  const c = generate();
  for (const slug of ["cookie-web", "named-web", "token-web"]) {
    assert.equal(find(c, slug).capture, "dashboard", slug);
    assert.deepEqual(find(c, slug).capturePerms, []);
    assert.deepEqual(find(c, slug).perms, []);
  }
}));

test("capture and initiator hosts require HTTPS without a custom port", () => fixture(({ capabilities, generate, replace }) => {
  for (const url of ["http://clerk.named.example.test/", "https://clerk.named.example.test:9443/"]) {
    const invalid = { ...capabilities, "named-web": { ...capabilities["named-web"], urls: [url] } };
    assert.throws(() => generate(invalid), /Web capture requires an HTTPS host without a custom port/, url);
  }
  replace(REGISTRY, "website: 'https://named.example.test'", "website: 'https://named.example.test:9443'");
  assert.throws(generate, /Web capture requires an HTTPS host without a custom port/, "an initiator host cannot widen the allowed transport");
}));

test("source provenance hashes the actual inputs and emitted coverage matches runtime metadata", () => fixture(({ root, inputs, generate, output }) => {
  const c = generate();
  assert.equal(c.provenance.ref, null);
  assert.equal(c.provenance.sha256, hash(JSON.stringify(c.provenance.files)));
  assert.ok(c.provenance.files.some((p) => p.file === OAUTH_ROUTE));
  assert.ok(c.provenance.files.some((p) => p.file === PROOF));
  assert.ok(!c.provenance.files.some((p) => p.file.endsWith("unregistered.ts")));
  for (const p of c.provenance.files) assert.equal(p.sha256, hash(inputs.get(p.file)), p.file);
  for (const p of c.all) assert.ok(Number.isInteger(p.source.line) && p.source.line > 0 && inputs.has(p.source.file), p.slug);
  emitCatalog(c, output);
  assert.deepEqual(JSON.parse(readFileSync(join(output, "provider-coverage.json"), "utf8")), { provenance: c.provenance, ...c.coverage });
  const sandbox = { module: { exports: {} } };
  runInNewContext(readFileSync(join(output, "providers.gen.js"), "utf8"), sandbox, { timeout: 1000 });
  const runtime = sandbox.module.exports;
  assert.deepEqual(Array.from(runtime.all, (p) => p.slug), slugs(c.all));
  for (const kind of ["web", "apikey", "oauth", "other"]) for (const p of runtime[kind]) assert.equal(p, runtime.all.find((a) => a.slug === p.slug));
  for (const [name, text] of inputs) assert.equal(readFileSync(join(root, name), "utf8"), text, `Source preserved: ${name}`);
}));

test("deterministic emission and --check cover all artifacts without rewriting stale or missing files", () => fixture(({ generate, output }) => {
  const paths = ["providers.gen.js", "provider-coverage.json", "manifest.json"];
  const snapshot = () => paths.map((p) => readFileSync(join(output, p), "utf8"));
  emitCatalog(generate(), output);
  const first = snapshot();
  emitCatalog(generate(), output);
  assert.deepEqual(snapshot(), first);
  assert.doesNotThrow(() => emitCatalog(generate(), output, true));
  for (const [i, name] of paths.entries()) {
    const stale = name === "manifest.json" ? JSON.stringify({ ...JSON.parse(first[i]), host_permissions: ["https://unreviewed.example.test/*"] }) : "{}\n";
    writeFileSync(join(output, name), stale);
    const before = snapshot();
    assert.throws(() => emitCatalog(generate(), output, true), (e) => /stale/.test(e.message) && e.message.includes(name));
    assert.deepEqual(snapshot(), before, `--check must not rewrite ${name} or other outputs`);
    writeFileSync(join(output, name), first[i]);
  }
  rmSync(join(output, "provider-coverage.json"));
  assert.throws(() => emitCatalog(generate(), output, true), /provider-coverage\.json/);
  assert.equal(existsSync(join(output, "provider-coverage.json")), false);
}));

test("invalid explicit roots and unknown OAuth flows are errors, not another installation or guessed flow", () => fixture(({ root, replace, generate }) => {
  assert.equal(locateOmni({ OMNI_ROOT: root }), root);
  assert.throws(() => locateOmni({ OMNI_ROOT: join(root, "missing") }), /OMNI_ROOT must contain/);
  replace("src/lib/oauth/providers/shared.ts", "'device_code'", "'new_unknown_flow'");
  assert.throws(generate, /unsupported OAuth flow/);
}));

test("a registry key must equal its exact provider ID", () => fixture(({ replace, generate }) => {
  replace("src/shared/constants/providers/apikey/gateways.ts", "id: 'paid'", "id: 'different-id'");
  assert.throws(generate, /invalid provider ID paid/);
}));

test("duplicate IDs across registered sections fail rather than silently overwriting metadata", () => fixture(({ replace, generate }) => {
  replace(REGISTRY, "anonymous: { id: 'anonymous'", "paid: { id: 'paid'");
  assert.throws(generate, /paid occurs in multiple catalog sections/);
}));

test("OAuth routes cannot invent providers absent from the registered catalog", () => fixture(({ replace, generate }) => {
  replace("src/lib/oauth/providers/index.ts", "PROVIDERS = { device,", "PROVIDERS = { ghost: device, device,");
  assert.throws(generate, /ghost: OAuth route is absent/);
}));
