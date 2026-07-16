// gen-providers.mjs — generate providers.gen.js from the installed OmniRoute source.
// Single source of truth: OmniRoute's own provider registries. Re-run after upgrading OmniRoute
// (whether npm-global OR a git-clone+rebuild under <SCRIPTS_ROOT>\External\OmniRoute).
//   node gen-providers.mjs            # auto-locate: OMNI_ROOT → npm global → External/OmniRoute
//   OMNI_ROOT=/path node gen-providers.mjs
//
// Parses three registries:
//   web    ← open-sse/services/tokenExtractionConfig.ts   (config(...) calls)
//   apikey ← src/shared/constants/providers/apikey/*.ts    (APIKEY_PROVIDERS_* objects)
//   oauth  ← src/lib/oauth/providers/*.ts                  (flowType + id)
// Output: providers.gen.js (consumed by background.js + popup.js).
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// A real OmniRoute root has the source trees we parse — validates a candidate regardless of whether
// it's an npm global, a git-clone under External/, or a junction to one.
function isOmniRoot(p) {
  return !!p && existsSync(join(p, "src/lib/oauth/providers")) && existsSync(join(p, "open-sse/services/tokenExtractionConfig.ts"));
}
function locateOmni() {
  const scriptsRoot = process.env.SCRIPTS_ROOT || "E:/Scripts";
  const candidates = [];
  if (process.env.OMNI_ROOT) candidates.push(process.env.OMNI_ROOT);
  try { candidates.push(join(execSync("npm root -g", { encoding: "utf8" }).trim(), "omniroute")); } catch { /* npm not on PATH */ }
  candidates.push(
    join(scriptsRoot, "External", "OmniRoute"),   // git-clone under External/ (current install method)
    "E:/Scripts/External/OmniRoute",
    "C:/Scripts/External/OmniRoute",              // MiniPC layout
    "C:/Users/User/AppData/Roaming/npm/node_modules/omniroute",
    join(process.env.APPDATA || "", "npm/node_modules/omniroute"),
  );
  for (const c of candidates) if (isOmniRoot(c)) return c;                // prefer a structurally-valid root
  for (const c of candidates) if (c && existsSync(c)) return c;          // else any existing dir
  throw new Error("Cannot locate OmniRoute (npm global, git-clone under External/, or OMNI_ROOT). Set OMNI_ROOT.");
}

// ── host helpers ────────────────────────────────────────────────────────────
function hostOf(url) { try { return new URL(url).host; } catch { return ""; } }
// registrable-ish base (last two labels) for a wildcard subdomain permission
function baseDomain(host) {
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  return parts.slice(-2).join(".");
}
// Shared multi-tenant bases we MUST NOT wildcard (would grant Gmail, Outlook, Teams, …).
// For these, scope to the exact provider host only. cloud.microsoft is M365's consolidated
// domain (outlook/teams.cloud.microsoft); tencent.com spans far more than Yuanbao.
const SHARED_BASES = new Set(["google.com", "microsoft.com", "cloud.microsoft", "tencent.com"]);
function permsFor(host) {
  const base = baseDomain(host);
  if (SHARED_BASES.has(base)) return [`https://${host}/*`];
  const set = new Set([`https://${host}/*`, `https://*.${base}/*`, `https://${base}/*`]);
  return [...set];
}
// a RegExp SOURCE string (not object) so it can be JSON-embedded and rebuilt in the extension
function hostReSrc(host) {
  const base = baseDomain(host);
  if (SHARED_BASES.has(base)) return `^https://${host.replace(/\./g, "\\.")}/`;
  return `^https://([\\w-]+\\.)?${base.replace(/\./g, "\\.")}/`;
}

// Web slugs present in tokenExtractionConfig but REJECTED by POST /api/providers ("Invalid provider").
// Verified by a live accept-sweep 2026-07-13 — re-check after `npm i -g omniroute@latest`.
const WEB_REJECTED = new Set(["duckduckgo-web", "t3-chat-web", "veoaifree-web", "chatglm-web", "xiaomimimo-web", "manus-web"]);

// Web providers ACCEPTED by POST /api/providers but NOT in tokenExtractionConfig (only in open-sse
// executors) — so the config parser misses them. Hosts from executors/known sites; capture = full
// Cookie header (OmniRoute extracts). Verified accepted via live sweep 2026-07-13.
const WEB_EXTRA = [
  { slug: "huggingchat", label: "HuggingChat", homeUrl: "https://huggingface.co", loginUrl: "https://huggingface.co/chat" },
  { slug: "lmarena", label: "LMArena", homeUrl: "https://lmarena.ai", loginUrl: "https://lmarena.ai" },
  { slug: "zenmux-free", label: "ZenMux (Free)", homeUrl: "https://zenmux.ai", loginUrl: "https://zenmux.ai" },
  { slug: "inner-ai", label: "InnerAI", homeUrl: "https://app.innerai.com", loginUrl: "https://app.innerai.com" },
  { slug: "yuanbao-web", label: "Tencent Yuanbao", homeUrl: "https://yuanbao.tencent.com", loginUrl: "https://yuanbao.tencent.com" },
  { slug: "copilot-m365-web", label: "MS Copilot (M365)", homeUrl: "https://m365.cloud.microsoft", loginUrl: "https://m365.cloud.microsoft" },
];

// ── WEB providers ───────────────────────────────────────────────────────────
function parseWeb(omni) {
  const file = join(omni, "open-sse/services/tokenExtractionConfig.ts");
  const src = readFileSync(file, "utf8");
  const out = [];
  // config( "id", "name", "loginUrl", "homeUrl", [ ...sources... ], "instructions" ...)
  const re = /config\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*(\[[\s\S]*?\])\s*,\s*(?:"|\n\s*")/g;
  let m;
  while ((m = re.exec(src))) {
    const [, id, name, loginUrl, homeUrl, sourcesRaw] = m;
    if (WEB_REJECTED.has(id)) continue; // OmniRoute's API rejects these — don't offer them
    const sources = [];
    const sre = /\{\s*type:\s*"([^"]+)"\s*,\s*(?:name|key):\s*"([^"]+)"(?:\s*,\s*domain:\s*"([^"]+)")?\s*\}/g;
    let s;
    while ((s = sre.exec(sourcesRaw))) sources.push({ type: s[1], name: s[2], domain: s[3] || undefined });
    const host = hostOf(homeUrl);
    out.push({ slug: id, label: name, site: homeUrl, loginUrl, host, perms: permsFor(host), hostReSrc: hostReSrc(host), sources });
  }
  for (const e of WEB_EXTRA) {
    const host = hostOf(e.homeUrl);
    out.push({ slug: e.slug, label: e.label, site: e.homeUrl, loginUrl: e.loginUrl, host, perms: permsFor(host), hostReSrc: hostReSrc(host), sources: [] });
  }
  return out;
}

// ── APIKEY providers ────────────────────────────────────────────────────────
const APIKEY_FAMILY = {
  "gateways": "Шлюзы и агрегаторы", "frontier-labs": "Frontier-лаборатории",
  "inference-hosts": "Inference-хосты", "enterprise-cloud": "Enterprise / облака",
  "regional": "Региональные", "specialty-media": "Медиа и спец",
};
function parseApikey(omni) {
  const dir = join(omni, "src/shared/constants/providers/apikey");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts");
  const out = [];
  const seen = new Set();
  for (const f of files) {
    const family = APIKEY_FAMILY[f.replace(/\.ts$/, "")] || "Прочее";
    const src = readFileSync(join(dir, f), "utf8");
    // anchor on `id: "X"`, then grab a bounded slice for the sibling fields
    const idRe = /id:\s*"([^"]+)"/g;
    let m;
    while ((m = idRe.exec(src))) {
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const slice = src.slice(m.index, m.index + 900);
      const name = (slice.match(/name:\s*"([^"]+)"/) || [])[1] || id;
      const website = (slice.match(/website:\s*"([^"]+)"/) || [])[1] || "";
      const hasFree = /hasFree:\s*true/.test(slice);
      out.push({ slug: id, label: name, get: website, free: hasFree, family });
    }
  }
  return out;
}

// ── OAUTH providers ─────────────────────────────────────────────────────────
function parseOauth(omni) {
  const dir = join(omni, "src/lib/oauth/providers");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts");
  const out = [];
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    const flow = (src.match(/flowType:\s*"([^"]+)"/) || [])[1];
    if (!flow) continue; // helper file, not a provider
    const id = f.replace(/\.ts$/, "");
    out.push({ slug: id, label: id, flowType: flow });
  }
  return out;
}

// ── emit ────────────────────────────────────────────────────────────────────
const omni = locateOmni();
const web = parseWeb(omni);
const apikey = parseApikey(omni);
const oauth = parseOauth(omni);

const banner = `// AUTO-GENERATED by gen-providers.mjs from OmniRoute source. Do NOT edit by hand.
// Regenerate: node gen-providers.mjs   (after upgrading OmniRoute — npm global or git-clone under External/)
// web=${web.length}  apikey=${apikey.length}  oauth=${oauth.length}`;
const body = `${banner}
const OMNI_GEN = {
  web: ${JSON.stringify(web, null, 1)},
  apikey: ${JSON.stringify(apikey, null, 1)},
  oauth: ${JSON.stringify(oauth, null, 1)},
};
if (typeof self !== "undefined") self.OMNI_GEN = OMNI_GEN;
if (typeof module !== "undefined") module.exports = OMNI_GEN;
`;
writeFileSync(join(process.cwd(), "providers.gen.js"), body);

// keep manifest host_permissions in sync with the generated web list
// 127.0.0.1 only — the extension talks to the gateway exclusively over the IPv4 loopback literal
// (OMNI_BASE, tabs.query/create). "localhost" would be a permission we never exercise: a headless
// `node serve` binds 0.0.0.0 (IPv4), while browsers resolve localhost to ::1 first — so that host
// never even connects. Don't ask for what you can't use.
const FIXED_HOSTS = ["http://127.0.0.1:20128/*", "https://aistudio.google.com/*"];
const webHosts = new Set(web.flatMap((w) => w.perms));
const hostPerms = [...FIXED_HOSTS, ...[...webHosts].filter((h) => !FIXED_HOSTS.includes(h)).sort()];
const manifestPath = join(process.cwd(), "manifest.json");
if (existsSync(manifestPath)) {
  const mf = JSON.parse(readFileSync(manifestPath, "utf8"));
  mf.host_permissions = hostPerms;
  writeFileSync(manifestPath, JSON.stringify(mf, null, 2) + "\n");
  console.log(`patched manifest.json host_permissions (${hostPerms.length} hosts)`);
}

console.log(`generated providers.gen.js  web=${web.length} apikey=${apikey.length} oauth=${oauth.length}`);
console.log("web:", web.map((w) => w.slug).join(", "));
console.log("oauth:", oauth.map((o) => `${o.slug}(${o.flowType})`).join(", "));
