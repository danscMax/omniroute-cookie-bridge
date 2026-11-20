// A terminal HTTP proxy: every response is synthetic; nothing is ever forwarded.
import http from "node:http";

export async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
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
    mode: "online", bulk: "success", zip: "success", oauthPoll: "pending", autoFound: false,
    connections: [], journal: [], nextId: 1, sentinelOrigin,
  };
  const safe = (c) => Object.fromEntries(Object.entries(c).filter(([k]) => !["apiKey", "token", "blob"].includes(k)));
  function create(body, upsert = true) {
    const previous = upsert && state.connections.find((c) => c.provider === body.provider && c.name === body.name);
    if (previous) { Object.assign(previous, body); return previous; }
    const c = { id: `fixture-${state.nextId++}`, name: "Synthetic fixture", isActive: true, testStatus: "active", createdAt: new Date().toISOString(), ...body };
    state.connections.push(c); return c;
  }
  state.create = create;
  const server = http.createServer(async (req, res) => {
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(403); res.end("Absolute proxy URL required"); return; }
    const entry = { at: Date.now(), method: req.method, url: u.href, mode: state.mode, cookie: req.headers.cookie || "", origin: req.headers.origin || "", outcome: "denied" };
    state.journal.push(entry);
    function answer(code, body, type = "application/json") {
      entry.status = code; entry.outcome = "synthetic";
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    }
    if (u.origin === sentinelOrigin && ["/fixture/page", "/fixture/worker", "/fixture/page-fetch", "/fixture/worker-down", "/fixture/page-down"].includes(u.pathname)) {
      if (u.pathname === "/fixture/page") return answer(200, "<!doctype html><title>Isolated proxy preflight</title>", "text/html");
      return answer(200, { through: "synthetic-proxy", path: u.pathname });
    }
    if (u.origin !== "http://127.0.0.1:20128") return answer(403, { error: "Unmodeled origin denied" });
    if (state.mode === "offline") { entry.outcome = "synthetic-disconnect"; req.socket.destroy(); return; }
    if (state.mode === "hanging" && u.pathname === "/api/providers") { entry.outcome = "synthetic-hang"; return; }
    if (req.method === "GET" && ["/home", "/fixture/auth", "/callback"].includes(u.pathname)) return answer(200, "<!doctype html><title>Synthetic gateway only</title><h1>Local verification fixture</h1>", "text/html");
    if (req.method === "GET" && u.pathname === "/favicon.ico") return answer(204, "", "text/plain");
    if (state.mode === "wrong") return answer(200, "<!doctype html><title>Not a gateway</title>", "text/html");
    if (state.mode === "unauthenticated" && u.pathname.startsWith("/api/")) return answer(401, { error: "Synthetic sign-in required" });
    if (req.method === "GET" && u.pathname === "/api/providers") return answer(200, { connections: state.connections.map(safe) });
    if (req.method === "GET" && u.pathname === "/api/system/version") return answer(200, { version: "4.29.0-fixture" });
    if (req.method === "GET" && u.pathname === "/v1/models") return answer(200, { data: ["openai", "perplexity-web", "claude-web", "github", "codex", "cursor"].map((s) => ({ id: `${s}/fixture-model`, owned_by: s })) });
    let body = {};
    if (["POST", "PATCH"].includes(req.method)) {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) { req.destroy(); return; } chunks.push(chunk); }
      const text = Buffer.concat(chunks).toString();
      if (req.headers["content-type"]?.includes("application/json")) {
        try { body = JSON.parse(text); } catch { return answer(400, { error: "Invalid JSON" }); }
        entry.body = body;
      } else entry.bodyBytes = size;
    }
    if (req.method === "POST" && u.pathname === "/v1/chat/completions") return answer(200, { model: body.model, choices: [{ message: { role: "assistant", content: "Synthetic fixture reply" } }], usage: { total_tokens: 2 } });
    if (req.method === "POST" && u.pathname === "/api/providers") {
      if (!body.provider || !body.apiKey) return answer(400, { error: "Missing provider or synthetic key" });
      return answer(201, { connection: safe(create(body)) });
    }
    // Contract: OmniRoute src/app/api/providers/bulk/route.ts returns HTTP 200 even on partial/full failure.
    if (req.method === "POST" && u.pathname === "/api/providers/bulk") {
      if (!Array.isArray(body.entries)) return answer(400, { error: "Expected entries array" });
      const created = [], errors = [];
      body.entries.forEach((e, index) => {
        if (state.bulk === "failure" || (state.bulk === "partial" && index > 0)) errors.push({ index, name: e.name, message: "Synthetic rejected entry" });
        else created.push(safe(create({ ...e, provider: body.provider }, false)));
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
    const oauth = u.pathname.match(/^\/api\/oauth\/(github|codex|cursor)\/(device-code|poll|start-callback-server|authorize|auto-import|import-token|paste-credentials)$/);
    if (oauth) {
      const [, provider, action] = oauth;
      if (action === "device-code" && req.method === "GET") return answer(200, { device_code: "synthetic-device-code", user_code: "TEST-ONLY", verification_uri: "http://127.0.0.1:20128/fixture/auth", expires_in: 900, interval: 5 });
      if (["start-callback-server", "authorize"].includes(action) && req.method === "GET") return answer(200, { authUrl: "http://127.0.0.1:20128/fixture/auth" });
      if (action === "poll" && req.method === "POST") return answer(200, state.oauthPoll === "success" ? { success: true, connection: safe(create({ provider, name: "Synthetic OAuth" })) } : { error: state.oauthPoll === "slow_down" ? "slow_down" : "authorization_pending" });
      if (action === "auto-import" && req.method === "GET") return answer(200, { found: state.autoFound, token: state.autoFound ? "synthetic-local-token" : "" });
      if (["import-token", "paste-credentials"].includes(action) && req.method === "POST") return answer(200, { connection: safe(create({ provider, name: `Synthetic ${action}`, token: body.token || body.blob })) });
    }
    if (req.method === "POST" && u.pathname === "/api/providers/claude-auth/zip-extract") return answer(200, { entries: [{ name: "Synthetic archive A", json: "{}" }, { name: "Synthetic archive B", json: "{}" }] });
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
