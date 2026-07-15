// providers.js — thin adapter over the generated OMNI_GEN catalog (providers.gen.js).
// Loaded AFTER providers.gen.js (importScripts in the SW; <script> order in the popup).
// Builds runtime shapes (with real RegExp for host matching + credential helpers) and the
// per-type lists the background/popup consume. Data itself is generated — see gen-providers.mjs.
if (typeof OMNI_GEN === "undefined" && typeof importScripts === "function") {
  importScripts("providers.gen.js");
}

// IPv4 loopback literal, NOT "localhost": a headless `node serve` binds 0.0.0.0 (IPv4 only), while
// browsers resolve "localhost" to ::1 (IPv6) first → connection refused → the whole extension reads the
// server as "not running". 127.0.0.1 is always the IPv4 loopback the server listens on. See PR notes.
const OMNI_BASE = "http://127.0.0.1:20128";

// DeepSeek Web wants the Bearer userToken (cookie header → 502). Everyone else: OmniRoute's
// web validators accept the full Cookie header and extract what they need themselves.
const WEB_CRED_TOKEN = new Set(["deepseek-web"]);

// Nicer display names for OAuth providers (source ids are bare slugs).
const OAUTH_LABELS = {
  github: "GitHub Copilot", claude: "Claude (Pro/Max)", codex: "OpenAI Codex",
  qwen: "Qwen (OAuth)", "kimi-coding": "Kimi Coding", kiro: "Kiro", kilocode: "Kilo Code",
  "codebuddy-cn": "CodeBuddy CN", cursor: "Cursor", "gitlab-duo": "GitLab Duo",
  "grok-cli": "Grok CLI", trae: "Trae", windsurf: "Windsurf", zed: "Zed", "zed-hosted": "Zed Hosted",
  antigravity: "Antigravity", cline: "Cline", qoder: "Qoder",
};

// ── web providers (with real RegExp + credential type) ──────────────────────
const OMNI_WEB = (OMNI_GEN.web || []).map((w) => ({
  key: w.slug,
  slug: w.slug,
  label: w.label,
  site: w.site,
  host: w.host,
  perms: w.perms,
  hostRe: new RegExp(w.hostReSrc, "i"),
  sources: w.sources || [],
  cred: { t: WEB_CRED_TOKEN.has(w.slug) ? "token" : "cookie" },
}));
const OMNI_WEB_MAP = {};
for (const p of OMNI_WEB) OMNI_WEB_MAP[p.key] = p;

// ── apikey providers ────────────────────────────────────────────────────────
// Extra provider-specific fields that go into `providerSpecificData` on add. `required` ones the
// provider can't work without (OmniRoute rejects the add) — e.g. google-pse-search needs the Search
// Engine ID (cx). Optional ones (baseUrl override) are power-user extras validated by OmniRoute.
const APIKEY_EXTRA_FIELDS = {
  "google-pse-search": [{ key: "cx", label: "Search Engine ID (cx)", required: true, hint: "Programmable Search Engine ID" }],
};
const OMNI_APIKEY = (OMNI_GEN.apikey || []).map((a) => ({
  slug: a.slug, label: a.label, get: a.get, free: !!a.free, family: a.family || "Прочее",
  extra: APIKEY_EXTRA_FIELDS[a.slug] || null,
}));
const OMNI_APIKEY_MAP = {};
for (const p of OMNI_APIKEY) OMNI_APIKEY_MAP[p.slug] = p;

// ── oauth providers ─────────────────────────────────────────────────────────
// device_code = we can drive it headless (code + poll). Others (authorization_code[_pkce],
// import_token) need a redirect/callback or a CLI token → deep-link to the dashboard.
// device-code providers whose OmniRoute /device-code currently 500s (verified live 2026-07-13).
const OAUTH_BROKEN = new Set(["qwen", "codebuddy-cn"]);
// import providers that expose a local-cred auto-import endpoint (else the "найти локально" button 404s)
const OAUTH_AUTOIMPORT = new Set(["cursor"]);
// providers that support bulk ZIP import of many exported accounts → their `<slug>-auth` endpoint base
const OAUTH_ZIP = { claude: "claude-auth", codex: "codex-auth", antigravity: "agy-auth" };
// Where the user grabs a CLI token for import_token providers (shown as a "где взять" link).
const OAUTH_TOKEN_HINT = {
  windsurf: "https://windsurf.com/show-auth-token",
  zed: "Zed → настройки → скопируй токен из связки ключей ОС",
  cursor: "Cursor → Settings → скопируй сессионный токен",
  "grok-cli": "grok-cli: запусти `grok auth` и скопируй токен",
  trae: "Trae → выйди/зайди, скопируй токен из devtools/конфига",
};
// flowType → how we drive it: device_code = code+poll; import_token = paste a token; everything else
// (authorization_code[_pkce]) = browser redirect completed by OmniRoute's callback server (poll-callback).
const OMNI_OAUTH = (OMNI_GEN.oauth || []).map((o) => ({
  slug: o.slug,
  label: OAUTH_LABELS[o.slug] || o.slug,
  flowType: o.flowType,
  kind: o.flowType === "device_code" ? "device" : o.flowType === "import_token" ? "import" : "redirect",
  deviceFlow: o.flowType === "device_code",
  broken: OAUTH_BROKEN.has(o.slug),
  autoImport: OAUTH_AUTOIMPORT.has(o.slug),
  zipAuth: OAUTH_ZIP[o.slug] || null,
  tokenHint: OAUTH_TOKEN_HINT[o.slug] || "",
}));
const OMNI_OAUTH_MAP = {};
for (const o of OMNI_OAUTH) OMNI_OAUTH_MAP[o.slug] = o;

// ── credential builder ──────────────────────────────────────────────────────
function omniBuildCredential(provider, cap) {
  const t = (provider.cred && provider.cred.t) || "cookie";
  if (t === "token") return cap.token || cap.cookie; // deepseek: Bearer userToken, cookie fallback
  return cap.cookie;                                 // everyone else: full Cookie header
}

// Stable per-account id from the credential (JWT id if present, else short hash). OmniRoute UPSERTS
// by (provider, name) → distinct accounts MUST get distinct-but-stable names.
function omniAccountId(cred) {
  const s = String(cred || "");
  const m = s.match(/eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)/);
  if (m) {
    try {
      const payload = JSON.parse(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")));
      const id = payload.id || payload.sub || payload.user_id || payload.userId || payload.uid;
      if (id) return String(id).replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
    } catch (e) { /* not a readable JWT */ }
  }
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).slice(0, 8);
}

if (typeof self !== "undefined") {
  Object.assign(self, {
    OMNI_BASE, OMNI_WEB, OMNI_WEB_MAP, OMNI_APIKEY, OMNI_APIKEY_MAP, OMNI_OAUTH, OMNI_OAUTH_MAP,
    omniBuildCredential, omniAccountId,
  });
}
