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

// The few user-facing strings this adapter owns (OAuth token hints, the catch-all family label) live in
// _locales like the rest of the UI. Resolved through a guarded lookup rather than chrome.i18n directly:
// this file is also loaded by the node test harness, where `chrome` does not exist, and the inline text
// is the fallback there (and for a locale that lacks the key).
const T = (k, fb) => {
  try {
    return chrome.i18n.getMessage(k) || fb;
  } catch (e) {
    return fb;
  }
};

// ── web providers (with real RegExp + credential type) ──────────────────────
const OMNI_WEB = (OMNI_GEN.web || []).map((w) => ({
  ...w,
  key: w.slug,
  slug: w.slug,
  label: w.label,
  site: w.site,
  loginUrl: w.loginUrl || "",
  host: w.host,
  perms: w.perms,
  hostRe: new RegExp(w.hostReSrc || "(?!)", "i"),
  sources: w.sources || [],
  cred: { t: w.capture || "dashboard", name: w.valueCookie || "" },
}));
const OMNI_CAPTURE_WEB = OMNI_WEB.filter((p) => p.cred.t === "cookie" || p.cred.t === "token");
const OMNI_WEB_MAP = {};
for (const p of OMNI_WEB) OMNI_WEB_MAP[p.key] = p;

// ── apikey providers ────────────────────────────────────────────────────────
// Extra provider-specific fields that go into `providerSpecificData` on add. `required` ones the
// provider can't work without (OmniRoute rejects the add) — e.g. google-pse-search needs the Search
// Engine ID (cx). Optional ones (baseUrl override) are power-user extras validated by OmniRoute.
const APIKEY_EXTRA_FIELDS = {
  "google-pse-search": [{ key: "cx", label: "Search Engine ID (cx)", required: true, hint: "Programmable Search Engine ID" }],
  "cloudflare-ai": [{ key: "accountId", label: "Cloudflare Account ID", required: true, hint: "Workers AI account ID (not the API token)" }],
};
// The generated `get` is the provider's HOMEPAGE (that's what OmniRoute's source carries) — useless when you
// need a key and don't remember where the console hides it. Deep links straight to the "API keys" page:
const APIKEY_KEY_URL = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  gemini: "https://aistudio.google.com/apikey",
  groq: "https://console.groq.com/keys",
  xai: "https://console.x.ai/",
  mistral: "https://console.mistral.ai/api-keys",
  perplexity: "https://www.perplexity.ai/account/api/keys",
  cohere: "https://dashboard.cohere.com/api-keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  openrouter: "https://openrouter.ai/settings/keys",
  together: "https://api.together.ai/settings/api-keys",
  fireworks: "https://fireworks.ai/account/api-keys",
  huggingface: "https://huggingface.co/settings/tokens",
  cerebras: "https://cloud.cerebras.ai/",
  nvidia: "https://build.nvidia.com/settings/api-keys",
  novita: "https://novita.ai/settings/key-management",
  venice: "https://venice.ai/settings/api",
  chutes: "https://chutes.ai/app/api",
  nebius: "https://studio.nebius.com/settings/api-keys",
  sambanova: "https://cloud.sambanova.ai/apis",
  zai: "https://z.ai/manage-apikey/apikey-list",
  glm: "https://z.ai/manage-apikey/apikey-list",
  "glm-cn": "https://open.bigmodel.cn/usercenter/apikeys",
  kimi: "https://platform.moonshot.ai/console/api-keys",
  ai21: "https://studio.ai21.com/account/api-key",
};
const OMNI_APIKEY = (OMNI_GEN.apikey || []).map((a) => ({
  ...a,
  get: a.deepLink ? a.get : APIKEY_KEY_URL[a.slug] || a.get,
  deepLink: !!a.deepLink || !!APIKEY_KEY_URL[a.slug], free: !!a.free, family: a.family || T("cat_other", "Прочее"),
  dashboardOnly: a.keySetup === "dashboard",
  extra: APIKEY_EXTRA_FIELDS[a.slug] || null,
}));
const OMNI_APIKEY_MAP = {};
for (const p of OMNI_APIKEY) OMNI_APIKEY_MAP[p.slug] = p;

// ── oauth providers ─────────────────────────────────────────────────────────
// device_code = we can drive it headless (code + poll). Others (authorization_code[_pkce],
// import_token) need a redirect/callback or a CLI token → deep-link to the dashboard.
// providers that support bulk ZIP import of many exported accounts → their `<slug>-auth` endpoint base
const OAUTH_ZIP = { claude: "claude-auth", codex: "codex-auth", antigravity: "agy-auth" };
// Where the user grabs a CLI token for import_token providers (shown as a "где взять" link).
const OAUTH_TOKEN_HINT = {
  windsurf: "https://windsurf.com/show-auth-token",
  zed: T("hint_zed", "Zed → настройки → скопируй токен из связки ключей ОС"),
  cursor: T("hint_cursor", "Cursor → Settings → скопируй сессионный токен"),
  "grok-cli": T("hint_grokCli", "grok-cli: запусти `grok auth` и скопируй токен"),
  trae: T("hint_trae", "Trae → выйди/зайди, скопируй токен из devtools/конфига"),
};
// flowType → how we drive it: device_code = code+poll; import_token = paste a token; everything else
// (authorization_code[_pkce]) = browser redirect completed by OmniRoute's callback server (poll-callback).
const OMNI_OAUTH = (OMNI_GEN.oauth || []).map((o) => ({
  ...o,
  slug: o.slug,
  label: o.label || o.slug,
  flowType: o.flowType,
  kind: o.flowType === "device_code" ? "device" : o.flowType === "import_token" ? "import" : "redirect",
  deviceFlow: o.flowType === "device_code",
  dashboardOnly: o.oauthSetup === "dashboard",
  broken: false,
  autoImport: false,
  zipAuth: OAUTH_ZIP[o.slug] || null,
  tokenHint: OAUTH_TOKEN_HINT[o.slug] || "",
}));
const OMNI_OAUTH_MAP = {};
for (const o of OMNI_OAUTH) OMNI_OAUTH_MAP[o.slug] = o;

// One directory record per registered provider, including local/no-auth/system entries.
const OMNI_CATALOG = (OMNI_GEN.all || []).map((p) => ({
  ...p,
  get: OMNI_APIKEY_MAP[p.slug]?.get || p.get,
  deepLink: OMNI_APIKEY_MAP[p.slug]?.deepLink || !!p.deepLink,
}));
const OMNI_CATALOG_MAP = Object.fromEntries(OMNI_CATALOG.map((p) => [p.slug, p]));
function omniDashboardUrl(provider) {
  const p = typeof provider === "string" ? OMNI_CATALOG_MAP[provider] : provider;
  if (p?.category === "cloud-agent") return OMNI_BASE + "/dashboard/providers?section=cloudagent";
  if (!p || p.category === "system" || p.category === "other") return OMNI_BASE + "/dashboard/providers";
  return OMNI_BASE + "/dashboard/providers/" + encodeURIComponent(p.slug);
}
function omniMatchesProvider(p, query) {
  const q = String(query || "").trim().toLowerCase();
  return !q || [p.slug, p.label, p.alias, p.category, p.family, p.website, p.authHint, p.apiHint, p.notice, p.freeNote, ...(p.serviceKinds || [])]
    .some((v) => typeof v === "string" && v.toLowerCase().includes(q));
}

// /v1/models omits capability fields on legacy chat rows. Explicit endpoint/type metadata
// takes precedence: a responses-only or specialty model is not a chat-completions probe.
function omniCanChatModel(model) {
  if (!model || model.supported_in_api === false) return false;
  if (model.supported_endpoints !== undefined) {
    return Array.isArray(model.supported_endpoints) && model.supported_endpoints.includes("chat");
  }
  if (model.type && model.type !== "chat") return false;
  return true;
}

// Auth.js can split a cookie into numbered chunks. Only concatenate a contiguous sequence
// starting at zero from this single capture; never join different stores or partitions.
function omniCookieValue(cookie, name) {
  const pairs = new Map();
  for (const part of String(cookie || "").split(";")) {
    const raw = part.trim(), eq = raw.indexOf("=");
    if (eq > 0 && !pairs.has(raw.slice(0, eq))) pairs.set(raw.slice(0, eq), raw.slice(eq + 1));
  }
  if (pairs.get(name)) return pairs.get(name);
  const chunks = [...pairs].filter(([n]) => n.startsWith(name + ".") && /^\d+$/.test(n.slice(name.length + 1)))
    .map(([n, value]) => [Number(n.slice(name.length + 1)), value]).sort((a, b) => a[0] - b[0]);
  return chunks.length && chunks.every(([n, value], i) => n === i && !!value) ? chunks.map(([, v]) => v).join("") : "";
}
function omniHasSession(p, cap) {
  if (!p || !cap || p.cred?.t === "dashboard") return false;
  if (p.cred?.t === "token") return typeof cap.token === "string" && !!cap.token.trim();
  const groups = p.cookieGroups || [(p.sources || []).filter((s) => s.type === "cookie").map((s) => s.name)];
  return groups.length > 0 && groups.every((names) => names.some((name) => !!omniCookieValue(cap.cookie, name)));
}

// ── credential builder ──────────────────────────────────────────────────────
function omniBuildCredential(provider, cap) {
  if (!omniHasSession(provider, cap)) return "";
  if (provider.cred.t === "token") return cap.token.trim();
  if (provider.cred.name) return omniCookieValue(cap.cookie, provider.cred.name);
  return cap.cookie;
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

// Is the accountId a real account identity (an id claim inside a JWT) rather than a hash of the whole
// credential? Only a stable id may be used to find "the same account" among existing connections.
function omniAccountIdStable(cred) {
  const m = String(cred || "").match(/eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)/);
  if (!m) return false;
  try {
    const p = JSON.parse(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")));
    return !!(p.id || p.sub || p.user_id || p.userId || p.uid);
  } catch (e) { return false; }
}

// Account e-mail from a JWT in the credential, when the provider puts one there — display only (the
// connection NAME keeps the accountId so OmniRoute's upsert-by-name stays stable). "" when unknown.
function omniAccountEmail(cred) {
  const m = String(cred || "").match(/eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)/);
  if (!m) return "";
  try {
    const p = JSON.parse(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")));
    const e = p.email || p.mail || p.preferred_username || "";
    return /@/.test(e) ? String(e).slice(0, 80) : "";
  } catch (e) { return ""; }
}

if (typeof self !== "undefined") {
  Object.assign(self, {
    OMNI_BASE, OMNI_WEB, OMNI_WEB_MAP, OMNI_CAPTURE_WEB, OMNI_APIKEY, OMNI_APIKEY_MAP, OMNI_OAUTH, OMNI_OAUTH_MAP,
    OMNI_CATALOG, OMNI_CATALOG_MAP, omniDashboardUrl, omniMatchesProvider, omniCanChatModel, omniCookieValue, omniHasSession,
    omniBuildCredential, omniAccountId, omniAccountEmail, omniAccountIdStable,
  });
}
