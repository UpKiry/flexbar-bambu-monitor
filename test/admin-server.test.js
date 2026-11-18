const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { createAdminServer, CONTENT_SECURITY_POLICY } = require("../src/admin/server");
const { createDiagnostics } = require("../src/admin/diagnostics");

const STATIC_DIR = path.join(__dirname, "..", "com.upkiry.bambumonitor.plugin", "resources", "admin");
const TOKEN = "test-token";

function makeRuntime() {
  const calls = [];
  const actions = {
    async status() {
      return {
        status: "success",
        auth: { state: "signed-out", hasSession: false },
        config: { region: "global", printerId: "", printerName: "" },
        credentialStore: { available: true, backend: "memory" },
        devices: [],
        devicesError: null,
        printer: { id: "", name: "", state: {}, link: { state: "idle" } },
        display: { tone: "muted", title: "请登录", subtitle: "在插件设置中登录 Bambu 账号" },
        views: [],
      };
    },
    async login(payload) {
      calls.push({ action: "login", payload });
      return { status: "success", auth: { state: "signed-in" } };
    },
    async requestCode(payload) {
      calls.push({ action: "requestCode", payload });
      return { status: "code-sent", message: "验证码已发送" };
    },
    async logout() {
      calls.push({ action: "logout", payload: {} });
      return { status: "success" };
    },
    async refreshDevices() {
      return { status: "success", devices: [] };
    },
    async setPrinter(payload) {
      return { status: "success", config: { printerId: payload.printerId } };
    },
    async setRegion(payload) {
      return { status: "success", config: { region: payload.region } };
    },
    async requestFullState() {
      return { sent: false, reason: "not-connected" };
    },
    async testConnection() {
      return { status: "success", message: "已读取 0 台绑定设备" };
    },
  };
  return { diagnostics: createDiagnostics(), actions, calls };
}

async function startServer(t, overrides = {}) {
  const runtime = overrides.runtime || makeRuntime();
  const server = createAdminServer({
    runtime,
    staticDir: STATIC_DIR,
    token: TOKEN,
    openBrowserFn: overrides.openBrowserFn || (async () => ({ opened: true, reason: "" })),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const info = await server.start();
  t.after(() => server.stop());
  return { server, runtime, baseUrl: `http://127.0.0.1:${info.port}` };
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

function rawRequest(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("serves the admin page with security headers and no token", async (t) => {
  const { baseUrl } = await startServer(t);
  const response = await fetch(`${baseUrl}/`);
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.equal(response.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(text, /Bambu Monitor 后台/);
});

test("serves only known static files", async (t) => {
  const { baseUrl } = await startServer(t);
  const app = await fetch(`${baseUrl}/app.js`);
  assert.equal(app.status, 200);
  assert.match(app.headers.get("content-type"), /javascript/);
  assert.ok((await app.text()).includes("bambu-monitor-admin-token"));

  const missing = await fetch(`${baseUrl}/server.js`);
  assert.equal(missing.status, 404);
});

test("API requires a valid bearer token", async (t) => {
  const { baseUrl } = await startServer(t);
  assert.equal((await fetch(`${baseUrl}/api/status`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/status`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/status`, { headers: authHeaders() })).status, 200);
});

test("status includes regions and admin info but not the token", async (t) => {
  const { baseUrl, server } = await startServer(t);
  const response = await fetch(`${baseUrl}/api/status`, { headers: authHeaders() });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "success");
  assert.deepEqual(body.regions.map((region) => region.id), ["global", "china"]);
  assert.equal(body.admin.port, server.port);
  assert.equal(body.admin.running, true);
  assert.ok(!JSON.stringify(body).includes(TOKEN));
});

test("actions are forwarded to the runtime with a whitelist", async (t) => {
  const { baseUrl, runtime } = await startServer(t);
  const response = await fetch(`${baseUrl}/api/action`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json", Origin: baseUrl }),
    body: JSON.stringify({ action: "login", payload: { account: "a@b.c", password: "pw" } }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "success");
  assert.equal(body.action, "login");
  assert.deepEqual(runtime.calls[0], { action: "login", payload: { account: "a@b.c", password: "pw" } });

  const unknown = await fetch(`${baseUrl}/api/action`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ action: "shutdown" }),
  });
  assert.equal(unknown.status, 400);
});

test("rejects cross-site origins and content types", async (t) => {
  const { baseUrl } = await startServer(t);
  const badOrigin = await fetch(`${baseUrl}/api/action`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json", Origin: "https://evil.example" }),
    body: JSON.stringify({ action: "login", payload: {} }),
  });
  assert.equal(badOrigin.status, 403);

  const badType = await fetch(`${baseUrl}/api/action`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "text/plain", Origin: baseUrl }),
    body: JSON.stringify({ action: "login", payload: {} }),
  });
  assert.equal(badType.status, 415);
});

test("rejects DNS-rebinding style Host headers", async (t) => {
  const { baseUrl } = await startServer(t);
  const port = new URL(baseUrl).port;
  const response = await rawRequest(`http://127.0.0.1:${port}/api/status`, {
    headers: { Host: "evil.example", Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 403);
});

test("rejects oversized and malformed JSON bodies", async (t) => {
  const { baseUrl } = await startServer(t);
  const oversized = await fetch(`${baseUrl}/api/action`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json", Origin: baseUrl }),
    body: JSON.stringify({ action: "login", payload: { padding: "x".repeat(70_000) } }),
  });
  assert.equal(oversized.status, 413);

  const malformed = await fetch(`${baseUrl}/api/action`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json", Origin: baseUrl }),
    body: "{not json",
  });
  assert.equal(malformed.status, 400);
});

test("rate limits repeated login actions", async (t) => {
  const { baseUrl } = await startServer(t);
  let lastStatus = 0;
  for (let index = 0; index < 11; index += 1) {
    const response = await fetch(`${baseUrl}/api/action`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json", Origin: baseUrl }),
      body: JSON.stringify({ action: "login", payload: { account: "a@b.c", password: "pw" } }),
    });
    lastStatus = response.status;
  }
  assert.equal(lastStatus, 429);
});

test("diagnostics endpoint returns redacted logs and request metadata", async (t) => {
  const runtime = makeRuntime();
  runtime.diagnostics.recordLog({ level: "info", message: "token=secret123" });
  runtime.diagnostics.recordRequest({ method: "POST", path: "/v1/login?x=1", status: 200, durationMs: 5 });
  const { baseUrl } = await startServer(t, { runtime });

  const response = await fetch(`${baseUrl}/api/diagnostics`, { headers: authHeaders() });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.logs.length, 1);
  assert.ok(!body.logs[0].message.includes("secret123"));
  assert.equal(body.requests[0].path, "/v1/login");
});

test("open starts the server and returns the loopback URL", async (t) => {
  let openedWith = null;
  const runtime = makeRuntime();
  const server = createAdminServer({
    runtime,
    staticDir: STATIC_DIR,
    token: TOKEN,
    openBrowserFn: async (url) => {
      openedWith = url;
      return { opened: true, reason: "" };
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  t.after(() => server.stop());

  const result = await server.open();
  assert.equal(result.status, "success");
  assert.equal(result.opened, true);
  assert.equal(openedWith, result.url);
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=/);
  assert.ok(server.port > 0);
});

test("open returns the URL for manual fallback when the browser cannot launch", async (t) => {
  const server = createAdminServer({
    runtime: makeRuntime(),
    staticDir: STATIC_DIR,
    token: TOKEN,
    openBrowserFn: async () => ({ opened: false, reason: "exit-1" }),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  t.after(() => server.stop());

  const result = await server.open();
  assert.equal(result.status, "success");
  assert.equal(result.opened, false);
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=/);
});

test("stop closes the listener", async (t) => {
  const runtime = makeRuntime();
  const server = createAdminServer({
    runtime,
    staticDir: STATIC_DIR,
    token: TOKEN,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const info = await server.start();
  const baseUrl = `http://127.0.0.1:${info.port}`;
  await server.stop();
  await assert.rejects(() => fetch(`${baseUrl}/api/status`, { headers: authHeaders() }));
});

test("concurrent open calls share one browser launch", async (t) => {
  let launches = 0;
  const server = createAdminServer({
    runtime: makeRuntime(),
    staticDir: STATIC_DIR,
    token: TOKEN,
    openBrowserFn: async () => {
      launches += 1;
      return { opened: true, reason: "" };
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  t.after(() => server.stop());

  const [first, second] = await Promise.all([server.open(), server.open()]);
  assert.equal(launches, 1);
  assert.equal(first.url, second.url);
  assert.equal(first.opened, true);
});
