/**
 * 浏览器后台 API 客户端与令牌管理。
 *
 * 只通过同源 fetch 访问本机服务；不保存云令牌，不访问外网。
 * 令牌来自 URL fragment 或 sessionStorage，失效时由调用方切回令牌页。
 */

const TOKEN_KEY = "bambu-monitor-admin-token";

function readHashToken(location) {
  const raw = String(location?.hash || "").replace(/^#/, "");
  if (!raw) return "";
  try {
    return new URLSearchParams(raw).get("token") || "";
  } catch {
    return "";
  }
}

function storedToken(storage) {
  try {
    return storage?.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function persistToken(storage, token) {
  try {
    storage?.setItem(TOKEN_KEY, token);
  } catch {
    // 隐私模式下 sessionStorage 不可用时，退化为仅当前页面内存。
  }
}

function clearStoredToken(storage) {
  try {
    storage?.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

function stripTokenFromAddress(location, history) {
  if (!location?.hash) return;
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    // ignore
  }
}

function extractToken(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    if (text.includes("#token=")) return decodeURIComponent(text.split("#token=")[1]);
    if (/^https?:\/\//i.test(text)) {
      const parsed = new URL(text);
      return new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token") || "";
    }
  } catch {
    return "";
  }
  return text;
}

/**
 * @param {object} options
 * @param {(path: string, init: object) => Promise<Response>} options.fetchFn
 * @param {() => string} options.getToken
 * @param {(message: string) => void} options.onUnauthorized 令牌失效回调
 */
function createApi({ fetchFn, getToken, onUnauthorized = () => {} }) {
  async function request(path, { method = "GET", body } = {}) {
    const requestToken = getToken();
    const headers = { Authorization: `Bearer ${requestToken}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchFn(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
    });

    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (response.status === 401) {
      if (getToken() === requestToken) onUnauthorized("后台令牌无效或已过期，请从 FlexDesigner 设置页重新点击「进入后台」。");
      throw new Error("后台令牌无效");
    }
    if (!response.ok) {
      throw new Error(data.message || `请求失败（HTTP ${response.status}）`);
    }
    return data;
  }

  return {
    status: () => request("/api/status"),
    diagnostics: () => request("/api/diagnostics"),
    action: (action, payload = {}) => request("/api/action", { method: "POST", body: { action, payload } }),
  };
}

/** 诊断请求是否属于允许导出的动作。 */
const EXPORTABLE_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];
const EXPORTABLE_REQUEST_KINDS = [
  "invalid-credentials", "verification-required", "verification-invalid", "invalid-phone",
  "two-factor-required", "rate-limited", "network", "timeout", "region-mismatch",
  "unauthorized", "device-list-unavailable", "unknown",
];
const EXPORTABLE_ACTIVITIES = ["idle", "preparing", "printing", "paused", "finished", "failed", "unknown"];

module.exports = {
  TOKEN_KEY,
  readHashToken,
  storedToken,
  persistToken,
  clearStoredToken,
  stripTokenFromAddress,
  extractToken,
  createApi,
  EXPORTABLE_METHODS,
  EXPORTABLE_REQUEST_KINDS,
  EXPORTABLE_ACTIVITIES,
};
