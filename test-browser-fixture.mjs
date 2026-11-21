// A terminal HTTP proxy: every response is synthetic; nothing is ever forwarded.
import http from "node:http";

export async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", onError); resolve(); });
  });
  return server.address().port;
}
export async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
export async function sentinel() {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.end("DIRECT CONNECTION MUST NOT HAPPEN"); });
  const port = await listen(server);
  return { server, port, hits, origin: `http://127.0.0.1:${port}` };
}

export async function fixture(sentinelOrigin) {
  const state = {
    mode: "online", bulk: "success", zip: "success", oauthPoll: "pending",
    connections: [], callbacks: new Map(), journal: [], nextId: 1, sentinelOrigin,
  };
  const safe = (c) => Object.fromEntries(Object.entries(c).filter(([k]) => !["apiKey", "token", "blob", "accessToken", "refreshToken"].includes(k)));
  const nonempty = (value) => typeof value === "string" && !!value.trim();
  function create(body, upsert = true) {
    const previous = upsert && state.connections.find((c) => c.provider === body.provider && c.name === body.name);
    if (previous) { Object.assign(previous, body); return previous; }
    const c = { id: `fixture-${state.nextId++}`, name: "Synthetic fixture", isActive: true, testStatus: "active", createdAt: new Date().toISOString(), ...body };
    state.connections.push(c); return c;
  }
  state.create = create;
  // Receiving a callback only stores parameters. Persistence belongs to POST poll-callback,
  // just like the pinned route; selecting an existing account models token/email re-auth.
  state.completeCallback = (provider, result = {}) => {
    const callback = state.callbacks.get(provider);
    if (!callback) throw new Error(`No synthetic callback server for ${provider}`);
    callback.result = { code: "synthetic-authorization-code", ...result };
  };
  const server = http.createServer(async (req, res) => {
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(403); res.end("Absolute proxy URL required"); return; }
    const entry = { at: Date.now(), method: req.method, url: u.href, mode: state.mode, cookie: req.headers.cookie || "", origin: req.headers.origin || "", contentType: req.headers["content-type"] || "", outcome: "denied" };
    state.journal.push(entry);
    function answer(code, body, type = "application/json") {
      entry.status = code; entry.outcome = "synthetic";
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    }
    if (u.origin === sentinelOrigin && req.method === "GET" && u.pathname === "/favicon.ico") {
      return answer(204, "", "text/plain");
    }
    if (u.origin === sentinelOrigin && ["/fixture/page", "/fixture/worker", "/fixture/page-fetch", "/fixture/worker-down", "/fixture/page-down"].includes(u.pathname)) {
      if (u.pathname === "/fixture/page") return answer(200, "<!doctype html><title>Isolated proxy preflight</title>", "text/html");
      return answer(200, { through: "synthetic-proxy", path: u.pathname });
    }
    if (u.origin !== "http://127.0.0.1:20128") return answer(403, { error: "Unmodeled origin denied" });
    if (state.mode === "offline") { entry.outcome = "synthetic-disconnect"; req.socket.destroy(); return; }
    if (state.mode === "hanging" && u.pathname === "/api/providers") { entry.outcome = "synthetic-hang"; return; }
    if (req.method === "GET" && (["/home", "/fixture/auth", "/callback"].includes(u.pathname) || /^\/dashboard\/providers(?:\/[^/]+)?$/.test(u.pathname))) {
      return answer(200, "<!doctype html><title>Synthetic gateway only</title><h1>Local verification fixture</h1>", "text/html");
    }
    if (req.method === "GET" && u.pathname === "/favicon.ico") return answer(204, "", "text/plain");
    if (state.mode === "wrong") return answer(200, "<!doctype html><title>Not a gateway</title>", "text/html");
    if (state.mode === "unauthenticated" && u.pathname.startsWith("/api/")) return answer(401, { error: { message: "Synthetic sign-in required", type: "invalid_request" }, requestId: "synthetic-request" });
    if (req.method === "GET" && u.pathname === "/api/providers") return answer(200, { connections: state.connections.map(safe), total: state.connections.length });
    if (req.method === "GET" && u.pathname === "/api/system/version") return answer(200, { version: "4.29.0-fixture" });
    if (req.method === "GET" && u.pathname === "/v1/models") {
      const providers = new Set(["openai", "perplexity-web", "claude-web", "github", "codex", "devin-cli", "cloudflare-ai", ...state.connections.map((c) => c.provider)]);
      return answer(200, { data: [...providers].map((s) => ({ id: `${s}/fixture-model`, owned_by: s })) });
    }
    let body = {};
    if (["POST", "PATCH"].includes(req.method)) {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) { req.destroy(); return; } chunks.push(chunk); }
      const text = Buffer.concat(chunks).toString();
      if (req.headers["content-type"]?.includes("application/json")) {
        try { body = JSON.parse(text); } catch { return answer(400, { error: "Invalid JSON" }); }
        if (!body || typeof body !== "object" || Array.isArray(body)) return answer(400, { error: "Expected JSON object" });
        entry.body = body;
      } else entry.bodyBytes = size;
    }
    if (req.method === "POST" && u.pathname === "/v1/chat/completions") return answer(200, { model: body.model, choices: [{ message: { role: "assistant", content: "Synthetic fixture reply" } }], usage: { total_tokens: 2 } });
    if (req.method === "POST" && u.pathname === "/api/providers") {
      if (!body.provider || !nonempty(body.apiKey)) return answer(400, { error: "Missing provider or synthetic key" });
      const required = { "google-pse-search": "cx", "cloudflare-ai": "accountId" }[body.provider];
      if (required && !nonempty(body.providerSpecificData?.[required])) return answer(400, { error: `Missing ${required}` });
      return answer(201, { connection: safe(create(body)) });
    }
    // Numeric result contract: HTTP 200 also covers partial/full entry failure. PSE is
    // excluded upstream; Cloudflare routing account IDs are supplied on each entry.
    if (req.method === "POST" && u.pathname === "/api/providers/bulk") {
      if (!Array.isArray(body.entries)) return answer(400, { error: "Expected entries array" });
      if (body.provider === "google-pse-search") return answer(400, { error: "Provider excluded from bulk import" });
      const created = [], errors = [];
      body.entries.forEach((e, index) => {
        if (!e || !nonempty(e.apiKey) || (body.provider === "cloudflare-ai" && !nonempty(e.accountId))) {
          errors.push({ index, name: e?.name, message: "Missing synthetic key or required accountId" });
        } else if (state.bulk === "failure" || (state.bulk === "partial" && index > 0)) errors.push({ index, name: e.name, message: "Synthetic rejected entry" });
        else created.push(safe(create({ ...e, provider: body.provider, ...(body.providerSpecificData ? { providerSpecificData: body.providerSpecificData } : {}) }, false)));
      });
      return answer(200, { success: created.length, failed: errors.length, total: body.entries.length, created, errors });
    }
    const connection = u.pathname.match(/^\/api\/providers\/(fixture-\d+)$/);
    if (connection && req.method === "PATCH") {
      const c = state.connections.find((x) => x.id === connection[1]);
      if (!c) return answer(404, { error: "Synthetic missing connection" });
      Object.assign(c, body); return answer(200, { connection: safe(c) });
    }
    if (connection && req.method === "DELETE") { state.connections = state.connections.filter((c) => c.id !== connection[1]); return answer(200, { success: true }); }
    const oauth = u.pathname.match(/^\/api\/oauth\/(github|codex|devin-cli)\/([^/]+)$/);
    if (oauth) {
      const [, provider, action] = oauth;
      if (provider === "github" && action === "device-code" && req.method === "GET") return answer(200, { device_code: "synthetic-device-code", user_code: "TEST-ONLY", verification_uri: "http://127.0.0.1:20128/fixture/auth", expires_in: 900, interval: 5, codeVerifier: "synthetic-verifier" });
      if (provider === "github" && action === "poll" && req.method === "POST") {
        if (body.deviceCode !== "synthetic-device-code") return answer(400, { error: "Missing synthetic device code" });
        return answer(200, state.oauthPoll === "success"
          ? { success: true, connection: { id: create({ provider, name: "Synthetic device account" }).id, provider } }
          : { success: false, pending: true, error: state.oauthPoll === "slow_down" ? "slow_down" : "authorization_pending" });
      }
      if (provider === "codex" && action === "start-callback-server" && req.method === "GET") {
        state.callbacks.set(provider, { result: null });
        return answer(200, { authUrl: "http://127.0.0.1:20128/fixture/auth?provider=codex", codeVerifier: "synthetic-callback-verifier", redirectUri: "http://localhost:1455/auth/callback", serverPort: 1455, remoteHost: false });
      }
      if (provider === "codex" && action === "poll-callback" && req.method === "POST") {
        if (Object.keys(body).length) return answer(400, { error: "Expected empty callback poll object" });
        const callback = state.callbacks.get(provider);
        if (!callback) return answer(200, { success: false, error: "no_server", errorDescription: "Callback server not running" });
        if (!callback.result) return answer(200, { success: false, pending: true });
        state.callbacks.delete(provider); // Consume before exchange, including terminal errors.
        const result = callback.result;
        if (result.error) return answer(200, { success: false, error: result.error, errorDescription: result.errorDescription });
        const existing = result.connectionId && state.connections.find((c) => c.id === result.connectionId && c.provider === provider);
        if (result.connectionId && !existing) return answer(500, { success: false, error: "Synthetic re-auth account missing" });
        const c = existing || create({ provider, name: "Synthetic callback account" });
        c.testStatus = "active"; c.isActive = true;
        entry.connectionId = c.id;
        return answer(200, { success: true, connection: { id: c.id, provider: c.provider, email: "synthetic-account@example.test", displayName: c.name } });
      }
      if (provider === "devin-cli" && action === "import-token" && req.method === "POST") {
        if (!nonempty(body.token) || body.token.startsWith("omniroute-cred-v1.")) return answer(400, { error: "Expected synthetic raw token" });
        return answer(200, { success: true, connection: safe(create({ provider, name: "Synthetic raw-token account", token: body.token })) });
      }
    }
    if (req.method === "POST" && u.pathname === "/api/providers/claude-auth/zip-extract") return answer(200, { entries: [{ name: "Synthetic archive A", json: {} }, { name: "Synthetic archive B", json: {} }] });
    if (req.method === "POST" && u.pathname === "/api/providers/claude-auth/import-bulk") {
      if (!Array.isArray(body.entries)) return answer(400, { error: "Expected entries array" });
      const created = [], errors = [];
      body.entries.forEach((entry, index) => {
        if (state.zip === "failure" || (state.zip === "partial" && index > 0)) errors.push({ index, name: entry.name, message: "Synthetic rejection" });
        else created.push(safe(create({ provider: "claude", name: entry.name })));
      });
      return answer(200, { success: created.length, failed: errors.length, total: body.entries.length, created, errors });
    }
    return answer(403, { error: "Unmodeled method/path denied" });
  });
  server.on("connect", (req, socket) => {
    state.journal.push({ at: Date.now(), method: "CONNECT", url: req.url, outcome: "denied-no-forwarding" });
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  const port = await listen(server);
  return { server, port, state, close: () => closeServer(server), restart: () => listen(server, port) };
}
