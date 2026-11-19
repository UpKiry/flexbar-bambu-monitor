const https = require("node:https");
const { sanitizePayload } = require("../admin/debug-redaction");
const os = require("node:os");
const { URL } = require("node:url");
const { listRegions, resolveRegion, regionMismatchHint } = require("./region");

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_USER_AGENT = "Flexbar-BambuMonitor/0.3.1";
const OS_FAMILY = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
// 与 Bambu Studio / ha-bambulab 保持一致的客户端标识，减少被 Cloudflare 拦截的概率。
const CLIENT_HEADERS = {
  "x-bbl-client-name": "flexbar-bambu-monitor",
  "x-bbl-client-type": "homeautomation",
  "x-bbl-client-version": "01.00.00.00",
  "x-bbl-language": "zh-CN",
  "x-bbl-os-type": OS_FAMILY,
  "x-bbl-os-version": os.release(),
  "x-bbl-agent-version": "01.00.00.00",
  "x-bbl-executable-info": "{}",
  "x-bbl-agent-os-type": OS_FAMILY,
};
const BIND_PATH = "/v1/iot-service/api/user/bind";
const PREFERENCE_PATH = "/v1/design-user-service/my/preference";
const LOGIN_PATH = "/v1/user-service/user/login";
const EMAIL_CODE_PATH = "/v1/user-service/user/sendemail/code";
const SMS_CODE_PATH = "/v1/user-service/user/sendsmscode";
const LOGOUT_PATH = "/v1/user-service/my/logout";
const REFRESH_PATH = "/v1/user-service/user/refreshtoken";

/**
 * 云接口错误分类。
 *
 * 界面需要区分账号密码错误、验证码错误或过期、请求受限、网络失败及区域不匹配，
 * 因此错误对象必须带一个稳定的 `kind`，而不是让上层去猜 message 文本。
 */
const ERROR_KINDS = {
  invalidCredentials: "invalid-credentials",
  verificationRequired: "verification-required",
  verificationInvalid: "verification-invalid",
  invalidPhone: "invalid-phone",
  twoFactorRequired: "two-factor-required",
  rateLimited: "rate-limited",
  network: "network",
  timeout: "timeout",
  regionMismatch: "region-mismatch",
  unauthorized: "unauthorized",
  deviceListUnavailable: "device-list-unavailable",
  unknown: "unknown",
};

class CloudApiError extends Error {
  constructor(kind, message, { status = null, code = null, cause = null } = {}) {
    super(message);
    this.name = "CloudApiError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.cause = cause;
  }
}

function userMessageFor(kind, fallback, regionId) {
  switch (kind) {
    case ERROR_KINDS.invalidCredentials:
      return "账号或密码错误";
    case ERROR_KINDS.verificationRequired:
      return "该账号需要输入验证码";
    case ERROR_KINDS.verificationInvalid:
      return "验证码错误或已过期";
    case ERROR_KINDS.invalidPhone:
      return "请输入有效的手机号（可带国家区号，如 +86）";
    case ERROR_KINDS.twoFactorRequired:
      return "该账号需要双重认证，当前版本尚不支持";
    case ERROR_KINDS.rateLimited:
      return "请求过于频繁，请稍后再试";
    case ERROR_KINDS.network:
      return "网络连接失败，请检查网络后重试";
    case ERROR_KINDS.timeout:
      return "请求超时，请稍后重试";
    case ERROR_KINDS.regionMismatch:
      return regionMismatchHint(regionId);
    case ERROR_KINDS.unauthorized:
      return "登录已失效，请重新登录";
    case ERROR_KINDS.deviceListUnavailable:
      return "无法读取设备列表，请确认账号已在 Bambu 应用或 Bambu Studio 中绑定打印机";
    default:
      return "云端请求失败";
  }
}

/** 按语义给服务端错误归类。刻意不依赖固定文案之外的结构。 */
function classifyServiceError(status, body) {
  const text = String(body?.error || body?.message || "").toLowerCase();
  const code = body?.code;

  if (status === 429) return ERROR_KINDS.rateLimited;
  if (status === 401 || status === 403) {
    if (text.includes("login")) return ERROR_KINDS.unauthorized;
    return ERROR_KINDS.unauthorized;
  }
  if (text.includes("incorrect account or password")) return ERROR_KINDS.invalidCredentials;
  if (text.includes("phone number") || text.includes("valid phone")) return ERROR_KINDS.invalidPhone;
  if (text.includes("verification") || text.includes("verify code") || text.includes("code")) {
    if (text.includes("expire") || text.includes("incorrect") || text.includes("invalid")) {
      return ERROR_KINDS.verificationInvalid;
    }
    return ERROR_KINDS.verificationRequired;
  }
  if (text.includes("two-factor") || text.includes("tfa") || text.includes("2fa")) return ERROR_KINDS.twoFactorRequired;
  if (code === 1) return ERROR_KINDS.invalidCredentials;
  if (code === 4) return ERROR_KINDS.unauthorized;
  return ERROR_KINDS.unknown;
}

/** 把底层 socket 错误归类为网络 / 超时。 */
function classifyTransportError(error) {
  const code = error?.code || "";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || error?.name === "AbortError") {
    return ERROR_KINDS.timeout;
  }
  return ERROR_KINDS.network;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 极简 HTTPS 请求封装。
 *
 * 不使用 fetch：插件后端运行在 FlexDesigner 的 Node 环境中，不同版本对全局 fetch 支持不一，
 * 直接依赖 node:https 更稳，也便于精确控制超时和证书验证。
 */
function request({
  url,
  method = "GET",
  headers = {},
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  agentOptions,
  httpsRequest = https.request,
}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== "https:") {
      reject(new CloudApiError(ERROR_KINDS.unknown, "云端接口必须使用 HTTPS"));
      return;
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const requestHeaders = {
      accept: "application/json",
      "user-agent": DEFAULT_USER_AGENT,
      ...CLIENT_HEADERS,
      ...headers,
    };
    if (payload) {
      requestHeaders["content-type"] = "application/json";
      requestHeaders["content-length"] = String(payload.length);
    }

    let req;
    let res;
    let settled = false;
    let ended = false;
    const timer = setTimeout(() => {
      fail(new CloudApiError(ERROR_KINDS.timeout, "请求超时"));
    }, timeoutMs);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        if (res) res.destroy();
        if (req) req.destroy();
      } else {
        resolve(result);
      }
    }
    function fail(error) {
      const kind = error instanceof CloudApiError && Object.values(ERROR_KINDS).includes(error.kind)
        ? error.kind : classifyTransportError(error);
      finish(new CloudApiError(kind, userMessageFor(kind)));
    }

    try {
      req = httpsRequest(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method,
          headers: requestHeaders,
          timeout: timeoutMs,
          ...agentOptions,
        },
        (response) => {
          res = response;
          const chunks = [];
          let bytes = 0;
          res.on("error", fail);
          res.on("aborted", () => fail(new Error("响应中断")));
          res.on("close", () => {
            if (!ended) fail(new Error("响应提前关闭"));
          });
          res.on("data", (chunk) => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > MAX_RESPONSE_BYTES) {
              fail(new CloudApiError(ERROR_KINDS.network, "云端响应过大"));
              return;
            }
            chunks.push(buffer);
          });
          res.on("end", () => {
            ended = true;
            finish(null, {
              status: res.statusCode || 0,
              headers: res.headers,
              text: Buffer.concat(chunks, bytes).toString("utf8"),
            });
          });
          if (settled) res.destroy();
        },
      );
      req.on("timeout", () => fail(new CloudApiError(ERROR_KINDS.timeout, "请求超时")));
      req.on("error", fail);
      if (settled) {
        req.destroy();
        return;
      }
      if (payload) req.write(payload);
      req.end();
    } catch (error) {
      fail(error);
    }
  });
}

/**
 * Bambu 云 HTTP 适配器。
 *
 * 云端适配层统一转换原始响应，输出明确的领域对象；
 * 上层只看到 accessToken / devices / uid，不直接依赖原始响应结构。
 */
class CloudApi {
  constructor({ region = "global", regionConfig, timeoutMs = DEFAULT_TIMEOUT_MS, requestFn, onRequest, onFrame } = {}) {
    const resolved = regionConfig || resolveRegion(region);
    this.regionId = resolved.id;
    this.regionLabel = resolved.label;
    this.apiBaseUrl = String(resolved.apiBaseUrl || "").replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.requestFn = requestFn || request;
    this.onRequest = typeof onRequest === "function" ? onRequest : null;
    this.onFrame = typeof onFrame === "function" ? onFrame : null;
    this.lastRequestAt = 0;
  }

  get baseUrl() {
    return this.apiBaseUrl;
  }

  async call(path, { method = "GET", token, body, timeoutMs } = {}) {
    const startedAt = Date.now();
    let responseStatus = null;
    let errorKind = null;

    try {
      const headers = {};
      if (token) headers.authorization = `Bearer ${token}`;
      let response;
      try {
        response = await this.requestFn({
          url: `${this.apiBaseUrl}${path}`,
          method,
          headers,
          body,
          timeoutMs: timeoutMs || this.timeoutMs,
        });
      } catch (error) {
        // 传输层错误统一在这里归类，调用方只需要面对 CloudApiError。
        const kind = error instanceof CloudApiError && Object.values(ERROR_KINDS).includes(error.kind)
          ? error.kind : classifyTransportError(error);
        errorKind = kind;
        throw new CloudApiError(kind, userMessageFor(kind, null, this.regionId));
      }
      responseStatus = response.status;
      this.lastRequestAt = Date.now();
      const parsed = parseJson(response.text);
      if (this.onFrame) {
        try {
          const source = String(path).split(/[?#]/, 1)[0];
          // Authentication/profile bodies can carry arbitrary personal data. Keep metadata only.
          const metadataOnly = /\/(?:user-service|design-user-service)\//.test(source);
          const invalidJson = parsed === null && String(response.text || "").trim() !== "null";
          const safe = invalidJson
            ? { payload: { metadataOnly: true, json: false, parseError: true, bodyOmitted: true, bytes: Buffer.byteLength(String(response.text || "")) }, truncated: false }
            : metadataOnly
              ? { payload: { metadataOnly: true, json: true }, truncated: false }
              : sanitizePayload(parsed);
          const result = this.onFrame({ protocol: "http", source, method, status: response.status, at: this.lastRequestAt, ...safe });
          if (result && typeof result.catch === "function") result.catch(() => {});
        } catch {
          // Capture errors must not change the request result.
        }
      }
      if (response.status >= 200 && response.status < 300 && (!parsed || parsed.error)) {
        // 200 里也可能带业务错误，统一按业务错误处理。
        if (parsed?.error) {
          const kind = classifyServiceError(response.status, parsed);
          errorKind = kind;
          throw new CloudApiError(kind, userMessageFor(kind, parsed.error, this.regionId), {
            status: response.status,
            code: typeof parsed.code === "number" && Number.isSafeInteger(parsed.code) ? parsed.code : null,
          });
        }
        return parsed;
      }
      if (response.status >= 200 && response.status < 300) return parsed;
      const kind = classifyServiceError(response.status, parsed);
      errorKind = kind;
      throw new CloudApiError(kind, userMessageFor(kind, parsed?.error || parsed?.message, this.regionId), {
        status: response.status,
        code: typeof parsed?.code === "number" && Number.isSafeInteger(parsed.code) ? parsed.code : null,
      });
    } catch (error) {
      if (error instanceof CloudApiError && Object.values(ERROR_KINDS).includes(error.kind)) {
        errorKind = error.kind;
        throw error;
      }
      errorKind = classifyTransportError(error);
      throw new CloudApiError(errorKind, userMessageFor(errorKind));
    } finally {
      // 只上报脱敏元数据：不记录请求头、请求体、响应体或令牌。
      if (typeof this.onRequest === "function") {
        try {
          this.onRequest({
            method,
            path,
            status: responseStatus,
            kind: errorKind,
            durationMs: Date.now() - startedAt,
          });
        } catch {
          // 诊断回调不能影响请求结果。
        }
      }
    }
  }

  /**
   * 请求验证码。
   *
   * 参考 ha-bambulab 的实际行为：
   * - 账号里带 `@` 视为邮箱账号，调用 sendemail/code；
   * - 否则视为手机号，调用国区短信接口 sendsmscode。
   *
   * 国区短信接口在 API 主机 `api.bambulab.cn` 上，与登录接口同域；网站主机 `bambulab.cn` 会被 Cloudflare 挑战。
   */
  async requestVerificationCode(account) {
    if (!account) throw new CloudApiError(ERROR_KINDS.invalidCredentials, "请填写 Bambu 账号");
    const channel = account.includes("@") ? "email" : "sms";
    const payload = channel === "email"
      ? await this.call(EMAIL_CODE_PATH, {
        method: "POST",
        body: { email: account, type: "codeLogin" },
      })
      : await this.call(SMS_CODE_PATH, {
        method: "POST",
        body: { phone: account, type: "codeLogin" },
      });
    if (typeof payload?.accessToken === "string" && payload.accessToken) {
      // 少数情况下服务端直接返回令牌，说明该账号无需验证码。
      return { codeSent: false, channel, login: this.toLoginResult(payload) };
    }
    return { codeSent: true, channel, login: null };
  }

  /** 兼容旧调用方；实际按账号类型选择邮箱或短信验证码。 */
  async requestEmailCode(account) {
    return this.requestVerificationCode(account);
  }

  toLoginResult(payload) {
    const accessToken = typeof payload?.accessToken === "string" ? payload.accessToken : "";
    if (!accessToken) {
      const loginType = String(payload?.loginType || "");
      if (loginType === "verifyCode") {
        throw new CloudApiError(ERROR_KINDS.verificationRequired, "该账号需要输入验证码");
      }
      throw new CloudApiError(ERROR_KINDS.unknown, "登录响应中缺少令牌");
    }
    return {
      accessToken,
      refreshToken: typeof payload?.refreshToken === "string" ? payload.refreshToken : "",
      expiresInSeconds: Number.isFinite(payload?.expiresIn) ? payload.expiresIn : null,
      loginType: String(payload?.loginType || ""),
    };
  }

  /**
   * 账号登录。密码与验证码只用于当前请求，不落盘。
   * @param {{account: string, password?: string, code?: string}} credentials
   */
  async login({ account, password, code }) {
    if (!account) throw new CloudApiError(ERROR_KINDS.invalidCredentials, "请填写 Bambu 账号");
    if (!code && !password) {
      throw new CloudApiError(ERROR_KINDS.invalidCredentials, "请填写密码或验证码");
    }
    const body = code
      ? { account, code }
      : { account, password, apiError: "" };

    const payload = await this.call(LOGIN_PATH, { method: "POST", body });
    return this.toLoginResult(payload);
  }

  /** 绑定设备列表。返回值已去掉 LAN Access Code 等无关字段。 */
  async fetchDevices(token) {
    const payload = await this.call(BIND_PATH, { token });
    const devices = Array.isArray(payload?.devices) ? payload.devices : null;
    if (!devices) {
      throw new CloudApiError(ERROR_KINDS.deviceListUnavailable, "设备列表响应格式异常");
    }
    return devices
      .filter((device) => device && typeof device.dev_id === "string" && device.dev_id)
      .map((device) => ({
        id: device.dev_id,
        name: String(device.name || device.dev_product_name || device.dev_id),
        model: String(device.dev_product_name || device.dev_model_name || ""),
        online: typeof device.online === "boolean" ? device.online : null,
        printStatus: device.print_status == null ? null : String(device.print_status),
        nozzleDiameter: device.nozzle_diameter == null ? null : String(device.nozzle_diameter),
      }));
  }

  /** 云 MQTT 用户名需要数字 uid；较新的令牌里不再包含它。 */
  async fetchUserId(token) {
    const payload = await this.call(PREFERENCE_PATH, { token });
    const uid = payload?.uid;
    if (typeof uid === "number" && Number.isFinite(uid)) return String(uid);
    if (typeof uid === "string" && /^\d+$/.test(uid)) return uid;
    throw new CloudApiError(ERROR_KINDS.unknown, "无法从账号资料中读取用户标识，云端监控不可用");
  }

  /**
   * 令牌刷新。社区资料提示该接口目前基本不可用，默认不启用；
   * 仅在实测可用后由调用方打开。
   */
  async refreshToken(refreshTokenValue) {
    const payload = await this.call(REFRESH_PATH, {
      method: "POST",
      body: { refreshToken: refreshTokenValue },
    });
    const accessToken = typeof payload?.accessToken === "string" ? payload.accessToken : "";
    if (!accessToken) throw new CloudApiError(ERROR_KINDS.unauthorized, "刷新令牌失败，请重新登录");
    return {
      accessToken,
      refreshToken: typeof payload?.refreshToken === "string" ? payload.refreshToken : refreshTokenValue,
      expiresInSeconds: Number.isFinite(payload?.expiresIn) ? payload.expiresIn : null,
    };
  }

  /** 主动注销会话。失败不算错误：本地凭据始终要清理。 */
  async logout(token) {
    if (!token) return false;
    try {
      await this.call(LOGOUT_PATH, { method: "POST", token });
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = {
  CloudApi,
  CloudApiError,
  ERROR_KINDS,
  DEFAULT_TIMEOUT_MS,
  request,
  BIND_PATH,
  PREFERENCE_PATH,
  EMAIL_CODE_PATH,
  SMS_CODE_PATH,
  listRegions,
  userMessageFor,
  classifyServiceError,
};
