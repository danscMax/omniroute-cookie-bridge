// Generate the bridge catalog from OmniRoute's registered sections, without executing its code.
// OMNI_ROOT=/path/to/OmniRoute node gen-providers.mjs [--ref <commit>] [--check]
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ProviderSource } from "./provider-source.mjs";
import { DASHBOARD_KEY_PROVIDERS, reviewedWebCapability, WEB_CAPABILITIES } from "./provider-capabilities.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROVIDERS = "src/shared/constants/providers.ts";
const CATALOG = "src/lib/providers/catalog.ts";
const EXTRACTION = "open-sse/services/tokenExtractionConfig.ts";
const OAUTH = "src/lib/oauth/providers/index.ts";
const OAUTH_ROUTE = "src/app/api/oauth/[provider]/[action]/route.ts";
const FAMILIES = {
  gateways: "Шлюзы и агрегаторы", "frontier-labs": "Frontier-лаборатории",
  "inference-hosts": "Inference-хосты", "enterprise-cloud": "Enterprise / облака",
  regional: "Региональные", "specialty-media": "Медиа и спец",
};
const METADATA = ["id", "name", "alias", "website", "apiKeyUrl", "authHint", "apiHint", "notice", "hasFree", "freeNote", "serviceKinds", "noAuth", "systemOnly", "localDefault", "oauthProviderId"];
const FLOWS = new Set(["device_code", "authorization_code", "authorization_code_pkce", "import_token"]);

function isOmniRoot(path) {
  return !!path && [PROVIDERS, CATALOG, EXTRACTION, OAUTH, OAUTH_ROUTE].every((file) => existsSync(join(path, file)));
}
export function locateOmni(env = process.env) {
  // An explicit source is authoritative; a typo must not silently regenerate from another install.
  if (env.OMNI_ROOT) {
    if (!isOmniRoot(env.OMNI_ROOT)) throw new Error("OMNI_ROOT must contain the OmniRoute provider, catalog, extraction and OAuth registries");
    return resolve(env.OMNI_ROOT);
  }
  const candidates = [];
  try { candidates.push(join(execSync("npm root -g", { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim(), "omniroute")); } catch { /* npm-global source is optional */ }
  if (env.SCRIPTS_ROOT) candidates.push(join(env.SCRIPTS_ROOT, "External", "OmniRoute"));
  candidates.push(join(ROOT, "..", "OmniRoute"), "E:/Scripts/External/OmniRoute", "C:/Scripts/External/OmniRoute");
  const found = candidates.find(isOmniRoot);
  if (!found) throw new Error("Cannot locate OmniRoute source. Set OMNI_ROOT explicitly.");
  return resolve(found);
}

function webUrl(value, label) {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string") throw new Error(`${label}: URL must be a string`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label}: invalid URL`); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error(`${label}: expected an http(s) URL without credentials`);
  return value;
}
const sorted = (rows) => rows.sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
function stringSet(source, file, name) {
  const values = source.value(source.binding(file, name));
  if (!Array.isArray(values) || values.some((v) => typeof v !== "string")) throw new Error(`${name}: expected a set of provider IDs`);
  return new Set(values);
}

export function readExtraction(source) {
  const file = source.file(EXTRACTION);
  const result = new Map();
  for (const ref of source.items(source.binding(file, "RAW_CONFIGS"))) {
    const { file: owner, node } = source.dereference(ref);
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "config" || node.arguments.length < 6) source.fail(node, "Expected a token extraction config call");
    const values = node.arguments.slice(0, 6).map((arg) => source.value({ file: owner, node: arg }));
    const [slug, label, loginUrl, site, sources, instructions] = values;
    if (typeof slug !== "string" || !slug || result.has(slug)) source.fail(node, "Invalid or duplicate extraction provider ID");
    if (!Array.isArray(sources)) source.fail(node, "Token sources must be an array");
    for (const s of sources) if (!s || !["cookie", "header", "localStorage", "sessionStorage"].includes(s.type) || typeof (s.name || s.key) !== "string") source.fail(node, "Unsupported token source");
    result.set(slug, { slug, label, loginUrl: webUrl(loginUrl, slug), site: webUrl(site, slug),
      sources: sources.map((s) => ({ type: s.type, name: s.name || s.key, ...(s.domain ? { domain: s.domain } : {}) })),
      instructions, source: source.location(ref) });
  }
  return result;
}

// Exact hosts only. Capture access is never inferred from a homepage's last two DNS labels.
function captureHosts(urls) {
  const hosts = [...new Set(urls.filter(Boolean).map((value) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port) throw new Error("Web capture requires an HTTPS host without a custom port");
    return url.hostname;
  }))].sort();
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { host: hosts[0] || "", perms: hosts.map((h) => `https://${h}/*`), hostReSrc: hosts.length ? `^https://(?:${hosts.map(escape).join("|")})(?:/|$)` : "(?!)" };
}

export function generateCatalog(source, { webCapabilities = WEB_CAPABILITIES } = {}) {
  const file = source.file(PROVIDERS);
  const catalogFile = source.file(CATALOG);
  const sectionCategories = new Map();
  const groups = source.properties(source.exported(catalogFile, "STATIC_PROVIDER_CATALOG_GROUPS"));
  for (const [category, ref] of groups) {
    const providerRef = source.properties(ref).get("providers");
    if (!providerRef) throw new Error(`${category}: missing providers registry`);
    const { node } = source.dereference(providerRef);
    sectionCategories.set(node, category);
  }
  const managed = stringSet(source, catalogFile, "MANAGED_PROVIDER_CONNECTION_CATEGORIES");
  const dual = stringSet(source, file, "DUAL_AUTH_PROVIDER_IDS");
  const freeKeys = stringSet(source, file, "FREE_APIKEY_PROVIDER_IDS");
  const optional = stringSet(source, file, "EXPLICIT_OPTIONAL_APIKEY_PROVIDER_IDS");
  const bulkExcluded = stringSet(source, file, "BULK_API_KEY_EXCLUDED");
  const extraction = readExtraction(source);
  const oauthRoute = source.file(OAUTH_ROUTE);
  const callbackProviders = stringSet(source, oauthRoute, "PKCE_CALLBACK_PROVIDERS");
  const tokenImports = stringSet(source, oauthRoute, "IMPORT_TOKEN_PROVIDERS");
  const all = [], sections = [], bySlug = new Map();
  for (const section of source.items(source.binding(file, "_PROVIDER_SECTIONS"))) {
    const resolved = source.dereference(section);
    const name = source.unwrap(section.node).text;
    const category = sectionCategories.get(resolved.node) || (name === "SYSTEM_PROVIDERS" ? "system" : "other");
    const rows = source.properties(section);
    sections.push({ name, category, count: rows.size, source: source.location(section) });
    for (const [id, ref] of rows) {
      const data = source.fields(ref, METADATA);
      if (typeof data.id !== "string" || data.id !== id || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`${name}: invalid provider ID ${id}`);
      if (bySlug.has(id)) throw new Error(`Provider ${id} occurs in multiple catalog sections`);
      if (typeof data.name !== "string" || !data.name.trim()) throw new Error(`${id}: missing display name`);
      const website = webUrl(data.website, id);
      const keyUrl = webUrl(data.notice?.apiKeyUrl || data.apiKeyUrl, id);
      const signupUrl = webUrl(data.notice?.signupUrl, id);
      const entry = { slug: id, label: data.name, category, website, get: keyUrl || website,
        deepLink: !!keyUrl, signupUrl, authHint: data.authHint || "", apiHint: data.apiHint || "",
        notice: data.notice?.text || "", free: data.hasFree === true, freeNote: data.freeNote || "",
        alias: data.alias || "", serviceKinds: data.serviceKinds || [], source: source.location(ref),
        keyOptional: category === "local" || category === "no-auth" || optional.has(id),
        probeKind: ["search", "audio", "cloud-agent", "system"].includes(category) || (data.serviceKinds?.length && !data.serviceKinds.includes("llm") && !data.serviceKinds.includes("chat")) ? "dashboard" : "chat",
        bulk: (managed.has(category) || dual.has(id)) && category !== "local" && !bulkExcluded.has(id) && !(data.alias && bulkExcluded.has(data.alias)),
      };
      if (data.localDefault) entry.localDefault = webUrl(data.localDefault, id);
      if (data.oauthProviderId) entry.oauthProviderId = data.oauthProviderId;
      all.push(entry); bySlug.set(id, entry);
    }
  }
  if (!all.length) throw new Error("The source provider catalog is empty");
  for (const p of all) {
    p.onboarding = p.category === "web-cookie" ? "web" : "dashboard";
  }
  const oauth = [];
  for (const [slug, ref] of source.properties(source.exported(OAUTH, "PROVIDERS"))) {
    const flowType = source.flow(ref);
    if (!FLOWS.has(flowType)) throw new Error(`${slug}: unsupported OAuth flow ${flowType}`);
    const entry = bySlug.get(slug);
    if (!entry) throw new Error(`${slug}: OAuth route is absent from the provider catalog`);
    if (entry.onboarding !== "web") entry.onboarding = "oauth";
    Object.assign(entry, { flowType, flowSource: source.location(ref), tokenImport: tokenImports.has(slug) });
    entry.oauthSetup = (flowType === "device_code" && slug !== "ghe-copilot") || (flowType === "import_token" && tokenImports.has(slug)) || (flowType.startsWith("authorization_code") && callbackProviders.has(slug)) ? "inline" : "dashboard";
    entry.oauthReason = entry.oauthSetup === "dashboard"
      ? "This provider requires dashboard-specific parameters, token import or callback handling."
      : "Uses the registered OmniRoute device, callback-server or token-import endpoint.";
    oauth.push(entry);
  }
  const apikey = all.filter((p) => (managed.has(p.category) && !["web-cookie", "local"].includes(p.category)) || dual.has(p.slug) || freeKeys.has(p.slug))
    .map((p) => {
      if (p.onboarding === "dashboard") p.onboarding = "apikey";
      p.family = FAMILIES[basename(p.source.file, ".ts")] || p.category;
      p.keySetup = DASHBOARD_KEY_PROVIDERS.has(p.slug) || p.category === "cloud-agent" ? "dashboard" : "inline";
      return p;
    });
  const web = all.filter((p) => p.category === "web-cookie").map((p) => {
    const config = extraction.get(p.slug);
    const capability = reviewedWebCapability(source, p, webCapabilities);
    const site = p.website || config?.site;
    const loginUrl = config?.loginUrl && new URL(config.loginUrl).hostname === new URL(site).hostname ? config.loginUrl : site;
    const requestHosts = captureHosts(capability.captureUrls);
    // Chrome observes a subresource only with permission for BOTH its URL and initiator.
    // Keep the request filter narrow: granting the app origin must not capture its unrelated tokens.
    const initiatorPerms = capability.capture === "dashboard" ? [] : captureHosts([site]).perms;
    Object.assign(p, { site, loginUrl, instructions: p.authHint || config?.instructions || "",
      upstreamSources: config?.sources || [], extractionSource: config?.source || null,
      ...capability, ...requestHosts, capturePerms: requestHosts.perms,
      perms: [...new Set([...requestHosts.perms, ...initiatorPerms])].sort() });
    return p;
  });
  const webSlugs = new Set(web.map((p) => p.slug));
  const other = all.filter((p) => p.onboarding === "dashboard");
  const excludedExtraction = [...extraction.values()].filter((p) => !webSlugs.has(p.slug)).map((p) => ({ slug: p.slug, source: p.source,
    reason: bySlug.has(p.slug) ? `Registered as ${bySlug.get(p.slug).category}; not a web-cookie connection` : "Not registered in the provider catalog" }));
  const files = [...source.texts].map(([path, text]) => ({ file: relative(source.root, path).replaceAll("\\", "/"), sha256: createHash("sha256").update(text).digest("hex") })).sort((a, b) => a.file < b.file ? -1 : 1);
  const provenance = { ref: source.ref, sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files,
    capabilitiesSha256: createHash("sha256").update(readFileSync(join(ROOT, "provider-capabilities.mjs"), "utf8").replaceAll("\r\n", "\n")).digest("hex") };
  const coverage = { total: all.length, sections, excludedExtraction,
    providers: sorted(all.map((p) => ({ slug: p.slug, category: p.category, onboarding: p.onboarding, source: p.source,
      metadata: ["website", "authHint", "apiHint", "notice", "freeNote"].filter((field) => !!p[field]),
      ...(p.keySetup ? { keySetup: p.keySetup, bulk: p.bulk } : {}),
      ...(p.oauthSetup ? { oauthSetup: p.oauthSetup } : {}),
      ...(webSlugs.has(p.slug) ? { capture: p.capture, captureReason: p.captureReason, captureEvidence: p.captureEvidence } : {}) }))) };
  return { provenance, all: sorted(all), web: sorted(web), apikey: sorted(apikey), oauth: sorted(oauth), other: sorted(other), coverage };
}

export function emitCatalog(catalog, output, check = false) {
  const { coverage, ...runtime } = catalog;
  const banner = `// AUTO-GENERATED by gen-providers.mjs. Do NOT edit by hand.\n// total=${runtime.all.length} web=${runtime.web.length} apikey=${runtime.apikey.length} oauth=${runtime.oauth.length} dashboard=${runtime.other.length}\n`;
  const data = { ...runtime };
  for (const kind of ["web", "apikey", "oauth", "other"]) data[kind] = runtime[kind].map((p) => p.slug);
  // Dual-auth providers share one metadata record; the browser still receives the existing list shapes.
  const body = `${banner}const OMNI_GEN = ${JSON.stringify(data, null, 1)};\n{\n const bySlug = new Map(OMNI_GEN.all.map((p) => [p.slug, p]));\n for (const kind of ["web", "apikey", "oauth", "other"]) OMNI_GEN[kind] = OMNI_GEN[kind].map((slug) => bySlug.get(slug));\n}\nif (typeof self !== "undefined") self.OMNI_GEN = OMNI_GEN;\nif (typeof module !== "undefined") module.exports = OMNI_GEN;\n`;
  const manifestPath = join(output, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const fixed = ["http://127.0.0.1/*", "https://aistudio.google.com/*"];
  manifest.host_permissions = [...fixed, ...[...new Set(runtime.web.flatMap((p) => p.perms))].filter((p) => !fixed.includes(p)).sort()];
  const outputs = {
    "providers.gen.js": body,
    "provider-coverage.json": JSON.stringify({ provenance: runtime.provenance, ...coverage }, null, 2) + "\n",
    "manifest.json": JSON.stringify(manifest, null, 2) + "\n",
  };
  const stale = Object.entries(outputs).filter(([name, text]) => !existsSync(join(output, name)) || readFileSync(join(output, name), "utf8").replaceAll("\r\n", "\n") !== text);
  if (check && stale.length) throw new Error(`Generated provider files are stale: ${stale.map(([name]) => name).join(", ")}`);
  if (!check) for (const [name, text] of stale) writeFileSync(join(output, name), text);
  return { total: runtime.all.length, web: runtime.web.length, apikey: runtime.apikey.length, oauth: runtime.oauth.length, dashboard: runtime.other.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let ref, check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") check = true;
    else if (args[i] === "--ref" && args[i + 1]) ref = args[++i];
    else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  const catalog = generateCatalog(new ProviderSource(locateOmni(), { ref }));
  console.log(JSON.stringify({ ...(check ? { checked: true } : { generated: true }), ...emitCatalog(catalog, ROOT, check) }));
}
