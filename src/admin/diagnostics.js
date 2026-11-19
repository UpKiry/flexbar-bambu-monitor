const { redact } = require("../util/logger");
const { sanitizePayload, sanitizeText } = require("./debug-redaction");

/**
 * 浏览器后台的脱敏诊断缓冲。
 *
 * - 日志：已经过 createSafeLogger 脱敏的文本；
 * - 云端请求：方法、路径、状态码、错误类型、耗时；
 * - 入站帧：适配层脱敏后的响应/报文，再次递归脱敏并限制数量与字节数。
 * 不保存请求头、请求体或认证响应正文。
 *
 * 这里不做持久化：插件退出后诊断信息随之消失，避免把敏感内容留在磁盘上。
 */

const DEFAULT_LOG_CAPACITY = 200;
const DEFAULT_REQUEST_CAPACITY = 50;
const MAX_PATH_LENGTH = 240;

function normalizeLevel(level) {
  return ["debug", "info", "warn", "error"].includes(level) ? level : "info";
}

function sanitizePath(value) {
  const text = String(value === undefined || value === null ? "" : value);
  const withoutQuery = text.split(/[?#]/, 1)[0];
  return (withoutQuery || "/").slice(0, MAX_PATH_LENGTH);
}

function pushBounded(list, item, capacity) {
  list.unshift(item);
  if (list.length > capacity) list.length = capacity;
}

function createDiagnostics({
  logCapacity = DEFAULT_LOG_CAPACITY,
  requestCapacity = DEFAULT_REQUEST_CAPACITY,
  frameCapacity = 100,
  frameMaxBytes = 32 * 1024,
  frameTotalBytes = 1024 * 1024,
  now = () => Date.now(),
} = {}) {
  const logs = [];
  const requests = [];
  const frames = [];
  let frameBytes = 0;
  let nextFrameId = 0;
  const bounded = (value, fallback, max) => Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : fallback;
  logCapacity = bounded(logCapacity, DEFAULT_LOG_CAPACITY, 1000);
  requestCapacity = bounded(requestCapacity, DEFAULT_REQUEST_CAPACITY, 1000);
  frameCapacity = bounded(frameCapacity, 100, 1000);
  frameMaxBytes = bounded(frameMaxBytes, 32 * 1024, 256 * 1024);
  frameTotalBytes = bounded(frameTotalBytes, 1024 * 1024, 8 * 1024 * 1024);
  const startedAt = now();

  return {
    /** createSafeLogger 的 onRecord 回调：文本已经脱敏。 */
    recordLog({ level, message, at } = {}) {
      try {
        let text = String(message === undefined || message === null ? "" : message);
        try {
          text = JSON.stringify(sanitizePayload(JSON.parse(text), { maxBytes: 4096 }).payload);
        } catch {
          // Plain log messages use textual redaction below.
        }
        pushBounded(logs, {
          at: Number.isFinite(at) ? at : now(),
          level: normalizeLevel(level),
          message: sanitizeText(redact(text)).slice(0, 4096),
        }, logCapacity);
      } catch {
        // 诊断不能影响主流程。
      }
    },

    /** CloudApi 的 onRequest 回调：只记录不含秘密的请求元数据。 */
    recordRequest(event = {}) {
      try {
        pushBounded(requests, {
          at: now(),
          method: String(event.method || "GET").toUpperCase().slice(0, 8),
          path: sanitizePath(event.path),
          status: Number.isFinite(event.status) ? event.status : null,
          kind: typeof event.kind === "string" ? sanitizeText(event.kind).slice(0, 80) : null,
          durationMs: Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : null,
        }, requestCapacity);
      } catch {
        // 诊断不能影响主流程。
      }
    },

    recordFrame(event = {}) {
      try {
        if (!["http", "mqtt"].includes(event.protocol) || !frameCapacity) return;
        const limit = Math.min(frameMaxBytes, frameTotalBytes);
        if (limit < 512) return;
        const safe = sanitizePayload(event.payload, { maxBytes: limit - 384 });
        const frame = {
          id: ++nextFrameId,
          at: Number.isFinite(event.at) ? event.at : now(),
          protocol: event.protocol,
          source: sanitizeText(sanitizePath(event.source)).slice(0, 160),
          payload: safe.payload,
          truncated: Boolean(event.truncated || safe.truncated),
        };
        if (Number.isFinite(event.status)) frame.status = event.status;
        if (typeof event.method === "string") frame.method = event.method.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8);
        let bytes = Buffer.byteLength(JSON.stringify(frame));
        if (bytes > limit) {
          frame.payload = "[已截断]";
          frame.truncated = true;
          bytes = Buffer.byteLength(JSON.stringify(frame));
        }
        frames.unshift({ frame, bytes });
        frameBytes += bytes;
        while (frames.length > frameCapacity || frameBytes > frameTotalBytes) frameBytes -= frames.pop().bytes;
      } catch {
        // Malformed data or instrumentation must never interrupt monitoring.
      }
    },

    snapshot() {
      return {
        startedAt,
        logs: logs.slice(),
        requests: requests.slice(),
        frames: frames.map(({ frame }) => JSON.parse(JSON.stringify(frame))),
      };
    },

    summary() {
      return { startedAt, logCount: logs.length, requestCount: requests.length };
    },

    clear() {
      logs.length = 0;
      requests.length = 0;
      frames.length = 0;
      frameBytes = 0;
    },
  };
}

module.exports = {
  createDiagnostics,
  sanitizePath,
  DEFAULT_LOG_CAPACITY,
  DEFAULT_REQUEST_CAPACITY,
};
