const { redact } = require("../util/logger");

/**
 * 浏览器后台的脱敏诊断缓冲。
 *
 * 只保存"便于定位问题"的最小信息：
 * - 日志：已经过 createSafeLogger 脱敏的文本；
 * - 云端请求：方法、路径、状态码、错误类型、耗时，不保存请求头、请求体和响应体。
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
  now = () => Date.now(),
} = {}) {
  const logs = [];
  const requests = [];
  const startedAt = now();

  return {
    /** createSafeLogger 的 onRecord 回调：文本已经脱敏。 */
    recordLog({ level, message, at } = {}) {
      try {
        pushBounded(logs, {
          at: Number.isFinite(at) ? at : now(),
          level: normalizeLevel(level),
          message: redact(String(message === undefined || message === null ? "" : message)),
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
          kind: typeof event.kind === "string" ? event.kind : null,
          durationMs: Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : null,
        }, requestCapacity);
      } catch {
        // 诊断不能影响主流程。
      }
    },

    snapshot() {
      return {
        startedAt,
        logs: logs.slice(),
        requests: requests.slice(),
      };
    },

    summary() {
      return { startedAt, logCount: logs.length, requestCount: requests.length };
    },

    clear() {
      logs.length = 0;
      requests.length = 0;
    },
  };
}

module.exports = {
  createDiagnostics,
  sanitizePath,
  DEFAULT_LOG_CAPACITY,
  DEFAULT_REQUEST_CAPACITY,
};
