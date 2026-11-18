const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const { listRegions } = require("../cloud/region");
const { redact } = require("../util/logger");
const { createDiagnostics } = require("./diagnostics");
const { openBrowser } = require("./open-browser");

/**
 * 本机浏览器后台。
 *
 * 边界：
 * - 只监听 127.0.0.1 的随机端口，不对局域网开放；
 * - 除静态页面外，所有 API 都要求进程级随机 token；
 * - 只接受同源请求，禁止 CORS；
 * - 不记录请求体、响应体、密码、验证码或令牌。
 *
 * 管理页是"瘦客户端"：登录、设备、日志都由 runtime 负责，HTTP 层只做鉴权和转发。
 */

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TOKEN_BYTES = 32;
const DEFAULT_OPEN_TIMEOUT_MS = 1_500;

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

const ACTIONS = new Set([
  "login",
  "requestCode",
  "cancelCode",
  "logout",
  "refreshDevices",
  "setPrinter",
  "setRegion",
  "requestFullState",
  "testConnection",
]);

const RATE_LIMITS = new Map([
  ["login", 10],
  ["requestCode", 10],
  ["refreshDevices", 20],
  ["testConnection", 20],
]);

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function generateToken() {
  return crypto.randomBytes(DEFAULT_TOKEN_BYTES).toString("base64url");
}

function createRateLimiter({ limit, windowMs = 60_000, now = () => Date.now() }) {
  const hits = new Map();
  return {
    allow(key) {
      if (!Number.isFinite(limit) || limit <= 0) return true;
      const stamp = now();
      const previous = hits.get(key) || [];
      const recent = previous.filter((at) => stamp - at < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(stamp);
      hits.set(key, recent);
      return true;
    },
  };
}

function applyCommonHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload === undefined ? {} : payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  if (res.writableEnded) return;
  const body = Buffer.from(String(text), "utf8");
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": body.length,
  });
  res.end(body);
}

function readJsonBody(req, { limit = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        const error = new Error("请求体过大");
        error.code = "BODY_TOO_LARGE";
        settle(error);
        // 继续把请求读空，避免连接处于半关闭状态。
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        settle(null, {});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        const error = new Error("请求体不是合法 JSON");
        error.code = "BAD_JSON";
        settle(error);
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        settle(null, {});
        return;
      }
      settle(null, parsed);
    });
    req.on("error", (error) => settle(error));
  });
}

function hostAllowed(req, port) {
  const host = String(req.headers.host || "").toLowerCase();
  return Boolean(port) && (host === `127.0.0.1:${port}` || host === `localhost:${port}`);
}

function originAllowed(req, port) {
  const origin = req.headers.origin;
  // 同源 fetch 会带 Origin；curl 等本机工具可能不带，此时依靠 token。
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

/**
 * @param {object} options
 * @param {object} options.runtime createPluginRuntime 的返回值
 * @param {string} options.staticDir 管理页静态文件目录
 * @param {object} [options.logger]
 * @param {string} [options.token] 测试可注入；默认每次启动随机生成
 * @param {object} [options.diagnostics] 默认取 runtime.diagnostics
 * @param {Function} [options.openBrowserFn]
 * @param {string} [options.platform]
 * @param {() => number} [options.now]
 */
function createAdminServer({
  runtime,
  staticDir,
  logger,
  token = generateToken(),
  diagnostics = runtime?.diagnostics || createDiagnostics(),
  openBrowserFn = openBrowser,
  platform = process.platform,
  now = () => Date.now(),
} = {}) {
  if (!runtime || !runtime.actions) {
    throw new TypeError("createAdminServer 需要 runtime.actions");
  }
  if (!staticDir) {
    throw new TypeError("createAdminServer 需要 staticDir");
  }

  let server = null;
  let running = false;
  let port = null;
  let startedAt = null;
  let startPromise = null;
  let stopPromise = null;
  let openPromise = null;

  const limiters = new Map();
  for (const [action, limit] of RATE_LIMITS) {
    limiters.set(action, createRateLimiter({ limit, now }));
  }

  function info() {
    return {
      available: true,
      running,
      port,
      startedAt,
      backend: "local-http",
    };
  }

  function url() {
    if (!port) return null;
    return `http://127.0.0.1:${port}/#token=${token}`;
  }

  function hasValidToken(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const provided = header.slice("Bearer ".length).trim();
    if (!provided) return false;
    const expectedBuffer = Buffer.from(token, "utf8");
    const providedBuffer = Buffer.from(provided, "utf8");
    if (expectedBuffer.length !== providedBuffer.length) return false;
    try {
      return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
    } catch {
      return false;
    }
  }

  async function statusPayload() {
    const result = await runtime.actions.status();
    return {
      ...result,
      regions: listRegions(),
      admin: info(),
      serverTime: now(),
    };
  }

  function diagnosticsPayload() {
    return {
      status: "success",
      ...diagnostics.snapshot(),
      summary: diagnostics.summary(),
      serverTime: now(),
    };
  }

  async function dispatchAction(body) {
    const action = typeof body?.action === "string" ? body.action : "";
    if (!ACTIONS.has(action)) {
      return { httpStatus: 400, payload: { status: "error", message: "未知的操作" } };
    }
    const limiter = limiters.get(action);
    if (limiter && !limiter.allow(action)) {
      return { httpStatus: 429, payload: { status: "error", message: "操作过于频繁，请稍后再试" } };
    }
    const payload = body?.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
      ? body.payload
      : {};
    try {
      const result = await runtime.actions[action](payload);
      return { httpStatus: 200, payload: { status: "success", action, result } };
    } catch (error) {
      logger?.error?.(`浏览器后台操作 ${action} 失败：${redact(error?.message || error)}`);
      return { httpStatus: 500, payload: { status: "error", message: "操作失败" } };
    }
  }

  async function handle(req, res) {
    applyCommonHeaders(res);

    if (!hostAllowed(req, port)) {
      sendJson(res, 403, { status: "error", message: "请求来源不受信任" });
      return;
    }

    let requestUrl;
    try {
      requestUrl = new URL(req.url || "/", "http://127.0.0.1");
    } catch {
      sendJson(res, 400, { status: "error", message: "请求地址无效" });
      return;
    }

    const pathname = requestUrl.pathname;

    if (pathname.startsWith("/api/")) {
      if (!hasValidToken(req)) {
        sendJson(res, 401, { status: "error", message: "未授权的后台请求" });
        return;
      }

      if (pathname === "/api/status" && req.method === "GET") {
        try {
          sendJson(res, 200, await statusPayload());
        } catch (error) {
          logger?.error?.(`浏览器后台读取状态失败：${redact(error?.message || error)}`);
          sendJson(res, 500, { status: "error", message: "读取状态失败" });
        }
        return;
      }

      if (pathname === "/api/diagnostics" && req.method === "GET") {
        sendJson(res, 200, diagnosticsPayload());
        return;
      }

      if (pathname === "/api/action" && req.method === "POST") {
        if (!originAllowed(req, port)) {
          sendJson(res, 403, { status: "error", message: "跨站请求被拒绝" });
          return;
        }
        const contentType = String(req.headers["content-type"] || "").toLowerCase();
        if (!contentType.includes("application/json")) {
          sendJson(res, 415, { status: "error", message: "请求格式必须是 application/json" });
          return;
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          if (error?.code === "BODY_TOO_LARGE") {
            sendJson(res, 413, { status: "error", message: "请求体过大" });
            return;
          }
          if (error?.code === "BAD_JSON") {
            sendJson(res, 400, { status: "error", message: "请求体不是合法 JSON" });
            return;
          }
          sendJson(res, 400, { status: "error", message: "无法读取请求体" });
          return;
        }
        const { httpStatus, payload } = await dispatchAction(body);
        sendJson(res, httpStatus, payload);
        return;
      }

      sendJson(res, 404, { status: "error", message: "接口不存在" });
      return;
    }

    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      sendJson(res, 405, { status: "error", message: "只支持 GET / HEAD" });
      return;
    }

    const entry = STATIC_FILES.get(pathname);
    if (!entry) {
      sendJson(res, 404, { status: "error", message: "页面不存在" });
      return;
    }

    const [fileName, contentType] = entry;
    try {
      const content = await fs.readFile(path.join(staticDir, fileName));
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": content.length,
      });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch (error) {
      logger?.error?.(`浏览器后台页面文件读取失败：${redact(error?.message || error)}`);
      sendText(res, 500, "后台页面文件缺失，请重新安装插件。");
    }
  }

  async function start() {
    if (running) return info();
    if (startPromise) return startPromise;

    startPromise = new Promise((resolve, reject) => {
      const instance = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
          logger?.error?.(`浏览器后台请求处理失败：${redact(error?.message || error)}`);
          sendJson(res, 500, { status: "error", message: "后台请求失败" });
        });
      });
      instance.headersTimeout = 10_000;
      instance.requestTimeout = 15_000;
      instance.keepAliveTimeout = 5_000;
      instance.maxHeadersCount = 50;
      instance.on("clientError", (_error, socket) => {
        if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      });
      instance.once("error", (error) => {
        startPromise = null;
        reject(error);
      });
      instance.listen(0, "127.0.0.1", () => {
        server = instance;
        running = true;
        port = instance.address().port;
        startedAt = now();
        startPromise = null;
        logger?.info?.(`浏览器后台已监听 127.0.0.1:${port}`);
        resolve(info());
      });
    });

    return startPromise;
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    // 启动尚未完成时先等它落地，避免 shutdown 之后又留下监听端口。
    if (startPromise) {
      try {
        await startPromise;
      } catch {
        // 启动失败时没有 server 需要关闭。
      }
    }
    if (!server) return undefined;
    const instance = server;
    server = null;
    running = false;
    stopPromise = new Promise((resolve) => {
      instance.close(() => resolve());
      if (typeof instance.closeAllConnections === "function") instance.closeAllConnections();
    }).finally(() => {
      port = null;
      startedAt = null;
      stopPromise = null;
    });
    return stopPromise;
  }

  /** 供设置页"进入后台"按钮调用：按需启动服务并拉起浏览器。 */
  async function open() {
    if (openPromise) return openPromise;
    openPromise = openInternal().finally(() => {
      openPromise = null;
    });
    return openPromise;
  }

  async function openInternal() {
    try {
      await start();
    } catch (error) {
      logger?.error?.(`启动浏览器后台失败：${redact(error?.message || error)}`);
      return { status: "error", message: "无法启动浏览器后台，请查看插件日志" };
    }

    const target = url();
    let launched = { opened: false, reason: "not-attempted" };
    try {
      launched = await openBrowserFn(target, { platform, timeoutMs: DEFAULT_OPEN_TIMEOUT_MS });
    } catch (error) {
      launched = { opened: false, reason: error?.message || "spawn-failed" };
    }

    if (launched.opened) {
      return { status: "success", opened: true, url: target, message: "已在浏览器打开后台" };
    }
    return {
      status: "success",
      opened: false,
      url: target,
      message: "浏览器没有自动打开，请手动访问下面的地址",
    };
  }

  return {
    start,
    stop,
    open,
    info,
    url,
    get token() {
      return token;
    },
    get running() {
      return running;
    },
    get port() {
      return port;
    },
  };
}

module.exports = {
  createAdminServer,
  generateToken,
  hostAllowed,
  originAllowed,
  MAX_BODY_BYTES,
  ACTIONS,
  STATIC_FILES,
  CONTENT_SECURITY_POLICY,
};
