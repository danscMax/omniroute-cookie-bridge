// Reviewed bridge capabilities, not a second provider catalog. Unknown providers stay discoverable
// with dashboard setup. Evidence is checked against the selected source on every regeneration.
// Reviewed against OmniRoute e3c1531afd07d5e06f7ffab658584a7ae2e3627e.
const evidence = (file, line, ...contains) => ({ file, line, contains });
const A = "src/lib/providers/validation/webProvidersA.ts";
const B = "src/lib/providers/validation/webProvidersB.ts";
const cookie = (urls, cookieGroups, proof, valueCookie) => ({
  capture: "cookie", urls, cookieGroups, evidence: proof,
  reason: valueCookie ? "Imports the named session-cookie value." : "Imports a Cookie header containing the required session cookies.",
  ...(valueCookie ? { valueCookie } : {}),
});
const token = (urls, proof, reason = "Captures the Bearer token from an authenticated site request.") => ({
  capture: "token", urls, evidence: proof, reason,
});
const dashboard = (reason) => ({ capture: "dashboard", reason, evidence: [] });

export const WEB_CAPABILITIES = {
  "claude-web": cookie(["https://claude.ai/"], [["sessionKey"]], [evidence(B, 150, '"sessionKey"', "https://claude.ai/api/organizations")]),
  "gemini-web": cookie(["https://gemini.google.com/"], [["__Secure-1PSID"]], [evidence(B, 222, "normalizeGeminiValidationCookie", "__Secure-1PSID", "https://gemini.google.com/app")]),
  "grok-web": cookie(["https://grok.com/"], [["sso"], ["sso-rw"]], [evidence("src/lib/providers/webCookieAuth.ts", 119, "buildGrokCookieHeader", '"sso-rw"')]),
  "perplexity-web": cookie(["https://www.perplexity.ai/"], [["__Secure-next-auth.session-token"]], [evidence(A, 388, "__Secure-next-auth.session-token=", "https://www.perplexity.ai/")], "__Secure-next-auth.session-token"),
  "blackbox-web": cookie(["https://app.blackbox.ai/"], [["__Secure-authjs.session-token", "next-auth.session-token"]], [evidence(A, 493, 'normalizeSessionCookieHeader(apiKey, "next-auth.session-token")', "__Secure-authjs.session-token", "https://app.blackbox.ai/api/auth/session")]),
  "deepseek-web": token(["https://chat.deepseek.com/"], [evidence(A, 107, "https://chat.deepseek.com/api/v0/users/current", "Bearer ${token}")]),
  "kimi-web": token(["https://www.kimi.ai/"], [evidence(A, 47, "https://www.kimi.ai/api/user", "Bearer ${accessToken}")]),
  "copilot-web": token(["https://copilot.microsoft.com/"], [evidence(B, 338, "extractAccessToken", "https://copilot.microsoft.com/c/api/conversations", "Bearer ${token}")]),
  "adapta-web": cookie(["https://clerk.agent.adapta.one/"], [["__client"]], [evidence(B, 109, "https://clerk.agent.adapta.one/v1/client", "__client=${clientJwt}")], "__client"),
  "venice-web": cookie(["https://clerk.venice.ai/"], [["__client"]], [evidence("open-sse/executors/venice-web-auth.ts", 41, "https://clerk.venice.ai", "__client=${clientJwt}", "extractClientJwt")], "__client"),
  huggingchat: cookie(["https://huggingface.co/chat"], [["hf-chat"]], [evidence("open-sse/executors/huggingchat.ts", 36, "https://huggingface.co", 'DEFAULT_COOKIE_NAME = "hf-chat"', "normalizeSessionCookieHeader")]),
  "notion-web": cookie(["https://www.notion.so/", "https://app.notion.com/"], [["token_v2"]], [evidence("open-sse/executors/notion-web.ts", 175, "normalizeNotionCookieInput", 'cookieName = "token_v2"')], "token_v2"),
  "conol-web": cookie(["https://conol.ai/"], [["__Secure-better-auth.session_token"]], [evidence("open-sse/services/conolAuth.ts", 1, 'CONOL_SESSION_COOKIE_NAME = "__Secure-better-auth.session_token"', "normalizeConolCookie")]),
  "notrack-web": cookie(["https://notrack.ai/"], [["uid"], ["si_usr_id"], ["si_ses_id"]], [evidence("open-sse/executors/notrack-web/cookie.ts", 35, '"uid="', '"si_usr_id="', '"si_ses_id="', "buildNotrackCookie")]),
  "poe-web": cookie(["https://poe.com/", "https://www.poe.com/"], [["p-b"]], [evidence("open-sse/executors/poe-web.ts", 43, "https://www.poe.com", "extractPbCookie", "p-b=${pbCookie}")]),
  "v0-vercel-web": cookie(["https://v0.dev/"], [["__Secure-next-auth.session-token"]], [evidence("open-sse/services/tokenExtractionConfig.ts", 281, "__Secure-next-auth.session-token", "https://v0.dev"), evidence("open-sse/executors/v0-vercel-web.ts", 26, "normalizeCookie", "reqHeaders.Cookie = rawCookie")]),
  "yuanbao-web": cookie(["https://yuanbao.tencent.com/"], [["hy_user"], ["hy_token"]], [evidence("open-sse/executors/yuanbao-web.ts", 114, "hy_user=", "hy_token=", "https://yuanbao.tencent.com")]),
  "zenmux-free": cookie(["https://zenmux.ai/"], [["ctoken"]], [evidence("open-sse/executors/zenmux-free.ts", 19, "extractCtoken", "ctoken=", "https://zenmux.ai", "reqHeaders.Cookie = rawCookie")]),
  syntx: token(["https://api.syntx.ai/"], [evidence("open-sse/services/syntxAuth.ts", 9, "https://api.syntx.ai", "Bearer ${token}")]),
  promptql: token(["https://data.prompt.ql.app/"], [evidence("open-sse/executors/promptql.ts", 95, "data.prompt.ql.app", "Bearer ${")], "Captures the playground Bearer JWT. Project claims must be present; DDN-only tokens do not support chat. Use dashboard setup for project overrides or renewal."),
  chatplayground: token(["https://app.chatplayground.ai/"], [evidence("open-sse/services/chatplaygroundAuth.ts", 109, "parseChatPlaygroundAccount", 'type: "jwt"', "Bearer ${"), evidence("open-sse/services/chatplaygroundModels.ts", 23, "https://app.chatplayground.ai")], "Captures a current Clerk Bearer JWT. Durable cookie-based renewal requires dashboard setup."),
  "chatgpt-web": dashboard("Requires Playwright storage-state JSON and connection-bound browser setup; a Cookie header is not accepted."),
  "chatgpt-web-codex": dashboard("Requires connection-bound browser validation and storage state. Complete the ChatGPT import in the dashboard."),
  "copilot-m365-web": dashboard("Use native Microsoft sign-in. This flow needs account-specific Chathub identity and a server-issued login transaction."),
  "muse-spark-web": dashboard("Requires the session cookie plus separate WebSocket authorization; cookie capture alone is incomplete."),
  "inner-ai": dashboard("The validator requires the token and account email. Use the dashboard to supply both."),
  "t3-web": dashboard("Requires the Cookie header plus local-storage convex-session-id."),
  "doubao-web": dashboard("Requires session cookies and additional browser-specific request context. Use the provider's dashboard import."),
  lmarena: dashboard("Requires provider-specific browser setup beyond the named session cookie. Use the dashboard import."),
  "adobe-firefly": dashboard("Media setup can require additional IMS/session state beyond a Bearer token. Use the dashboard flow."),
  twinmind: dashboard("Use the dashboard to import the IndexedDB access/refresh-token record and configure renewal."),
  maxai: dashboard("Requires access token, device ID and user identity from the provider-specific sign-in flow."),
  uc: dashboard("Requires provider-specific session and user fields from the email sign-in flow."),
  "tinycms-web": dashboard("Uses local-storage app-config-uuid and a custom header, not Cookie or Bearer capture."),
  "zai-web": dashboard("Requires a local-storage token and the provider's dashboard/browser transport setup."),
  hyperagent: dashboard("The executor accepts Cookie headers, but the required session-cookie names are not specified in the source."),
  "tencent-aistudio-web": dashboard("The executor accepts Cookie headers, but the required session-cookie names are not specified in the source."),
};

// These need resource/project/region/native configuration beyond the bridge's generic key form.
export const DASHBOARD_KEY_PROVIDERS = new Set([
  "azure-openai", "azure-ai", "vertex", "vertex-partner", "bedrock", "sap", "aws-polly",
  "heroku", "databricks", "snowflake",
  "ghe-copilot", "copilot-m365-web", "auggie", "zcode",
]);

export function reviewedWebCapability(source, provider, recipes = WEB_CAPABILITIES) {
  const recipe = recipes[provider.slug];
  const fallback = (reason) => ({ capture: "dashboard", captureReason: reason, captureEvidence: [provider.source], captureUrls: [], sources: [], cookieGroups: [] });
  if (!recipe) return fallback("No reviewed bridge capture recipe is available. Use the upstream dashboard instructions.");
  if (recipe.capture === "dashboard") return fallback(recipe.reason);
  const valid = recipe.evidence.length > 0 && recipe.evidence.every((e) => source.exists(e.file) && e.contains.every((s) => source.text(e.file).includes(s)));
  if (!valid) return fallback("The upstream credential contract has changed or its evidence is unavailable. Review the capture recipe; use dashboard setup meanwhile.");
  return {
    capture: recipe.capture, captureReason: recipe.reason,
    captureEvidence: recipe.evidence.map(({ file, line }) => ({ file, line })), captureUrls: recipe.urls,
    cookieGroups: recipe.cookieGroups || [], ...(recipe.valueCookie ? { valueCookie: recipe.valueCookie } : {}),
    sources: recipe.capture === "token" ? [{ type: "header", name: "Authorization" }]
      : [...new Set(recipe.cookieGroups.flat())].map((name) => ({ type: "cookie", name })),
  };
}
