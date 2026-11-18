const { CloudApiError, ERROR_KINDS } = require("../cloud/cloud-api");
const { resolveRegion, regionMismatchHint } = require("../cloud/region");

/**
 * 登录状态机（见 docs/云端监控设计方案.md §5.1）。
 *
 *   未登录 → 登录中 → 等待验证码 / 等待二次验证 → 已登录
 *                          ↘ 登录失败，可由用户重试
 *   已登录 → 令牌过期或被撤销 → 需要重新登录
 *
 * 约定：
 * - 认证失败和限流时不循环自动提交；
 * - 未支持的认证方式（例如双重认证）说明限制并停止，不绕过验证；
 * - 密码与验证码只在本次调用中存在，结束后不保留引用。
 */
const STATES = {
  signedOut: "signed-out",
  signingIn: "signing-in",
  awaitingCode: "awaiting-code",
  awaitingTwoFactor: "awaiting-two-factor",
  signedIn: "signed-in",
  failed: "failed",
  expired: "expired",
};

const TOKEN_KEY = "session";

function emptySession() {
  return { accessToken: null, refreshToken: null, userId: null, region: null, expiresAt: null, issuedAt: null };
}

function normalizeSession(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.accessToken !== "string" || !raw.accessToken) return null;
  return {
    accessToken: raw.accessToken,
    refreshToken: typeof raw.refreshToken === "string" ? raw.refreshToken : "",
    userId: raw.userId == null ? null : String(raw.userId),
    region: typeof raw.region === "string" ? raw.region : null,
    issuedAt: Number.isFinite(raw.issuedAt) ? raw.issuedAt : null,
    expiresAt: Number.isFinite(raw.expiresAt) ? raw.expiresAt : null,
  };
}

/**
 * @param {object} options
 * @param {(region: string) => object} options.createApi 区域 → 云 API
 * @param {object} options.credentialStore
 * @param {object} options.logger
 * @param {() => number} [options.now]
 */
function createAuthService({ createApi, credentialStore, logger, now = () => Date.now() }) {
  let state = STATES.signedOut;
  let session = emptySession();
  let sessionPersisted = false;
  let regionId = null;
  let lastError = null;
  let pendingAccount = null;
  let pendingApi = null;
  let inFlight = false;
  let loginGeneration = 0;
  let pendingPersist = null;

  function snapshot() {
    return {
      state,
      region: regionId,
      hasSession: Boolean(session.accessToken),
      userId: session.userId,
      expiresAt: session.expiresAt,
      persisted: sessionPersisted,
      error: lastError ? { kind: lastError.kind, message: lastError.message } : null,
    };
  }

  function fail(kind, message) {
    state = STATES.failed;
    lastError = { kind, message };
    return { status: "failed", ...snapshot() };
  }

  /** 清理内存中的敏感引用。只清理引用，不做不可靠的覆写。 */
  function clearSecrets() {
    pendingAccount = null;
    pendingApi = null;
  }

  /** 取消当前登录流程，并忽略尚未完成的认证响应。 */
  function cancelPendingLogin() {
    loginGeneration += 1;
    clearSecrets();
    if (state === STATES.signingIn || state === STATES.awaitingCode || state === STATES.awaitingTwoFactor || state === STATES.failed) {
      state = session.accessToken ? STATES.signedIn : STATES.signedOut;
      if (session.accessToken) regionId = session.region;
      lastError = null;
    }
    return snapshot();
  }

  function apiFor(region) {
    const resolved = resolveRegion(region);
    return createApi(resolved.id);
  }

  /**
   * 国区账号只能使用手机号，其他区域使用邮箱。
   * 参考 ha-bambulab：它用账号里是否包含 `@` 来决定发邮箱验证码还是短信验证码；
   * 这里在进入请求前明确提示，避免把手机号发到邮箱接口或反过来。
   */
  function accountKindError(region, account) {
    const hasEmail = typeof account === "string" && account.includes("@");
    if (region === "china" && hasEmail) return "中国大陆账号只能使用手机号登录";
    if (region !== "china" && !hasEmail) return "全球账号请使用邮箱登录";
    return "";
  }

  /** 手机号允许用户带空格 / 连字符输入，提交前去掉这些分隔符。 */
  function normalizeAccount(region, account) {
    const text = String(account === undefined || account === null ? "" : account).trim();
    if (region !== "china") return text;
    return text.replace(/[\s()-]/g, "");
  }

  function isExpired(at = now()) {
    if (!session.accessToken) return false;
    if (!Number.isFinite(session.expiresAt)) return false;
    return at >= session.expiresAt;
  }

  async function persist(nextSession, generation, api) {
    const previousRecord = sessionPersisted ? JSON.stringify({ [TOKEN_KEY]: session }) : null;
    const operation = (async () => {
      const result = await credentialStore.save(JSON.stringify({ [TOKEN_KEY]: nextSession }));
      if (generation !== loginGeneration) {
        if (result?.persisted === true) {
          if (previousRecord) await credentialStore.save(previousRecord);
          else await credentialStore.clear();
        }
        return false;
      }
      session = nextSession;
      sessionPersisted = result?.persisted === true;
      if (!sessionPersisted) {
        logger?.warn?.("安全存储不可用，登录状态仅保留在内存中，重启后需重新登录");
      }
      state = STATES.signedIn;
      lastError = null;
      regionId = api.regionId;
      clearSecrets();
      logger?.info?.(`Bambu 账号登录成功（区域：${api.regionLabel || api.regionId}）`);
      return true;
    })();
    pendingPersist = operation;
    try {
      return await operation;
    } finally {
      if (pendingPersist === operation) pendingPersist = null;
    }
  }

  async function hydrate() {
    const stored = await credentialStore.load();
    if (!stored) {
      state = STATES.signedOut;
      return snapshot();
    }
    let parsed = null;
    try {
      parsed = JSON.parse(stored);
    } catch {
      parsed = null;
    }
    const restored = normalizeSession(parsed?.[TOKEN_KEY] || parsed);
    if (!restored) {
      await credentialStore.clear();
      state = STATES.signedOut;
      return snapshot();
    }
    session = restored;
    regionId = restored.region || regionId;
    sessionPersisted = true;
    if (isExpired()) {
      state = STATES.expired;
      lastError = { kind: ERROR_KINDS.unauthorized, message: "登录已失效，请重新登录" };
      return snapshot();
    }
    state = STATES.signedIn;
    lastError = null;
    return snapshot();
  }

  /**
   * 使用密码登录。服务端要求邮箱验证码时会进入 awaitingCode，而不是抛错。
   */
  async function loginWithPassword({ region, account, password }) {
    if (inFlight) return { status: "busy", ...snapshot() };
    clearSecrets();
    if (!account || !password) return fail(ERROR_KINDS.invalidCredentials, "请填写账号和密码");
    const resolved = resolveRegion(region);
    const normalizedAccount = normalizeAccount(resolved.id, account);
    const kindError = accountKindError(resolved.id, normalizedAccount);
    if (kindError) return fail(ERROR_KINDS.invalidCredentials, kindError);
    inFlight = true;
    const generation = ++loginGeneration;
    regionId = resolved.id;
    state = STATES.signingIn;
    lastError = null;
    const api = apiFor(regionId);
    try {
      const result = await api.login({ account: normalizedAccount, password });
      if (generation !== loginGeneration) return { status: "cancelled", ...snapshot() };
      if (!await completeLogin(api, result, generation)) return { status: "cancelled", ...snapshot() };
      return { status: "success", ...snapshot() };
    } catch (error) {
      if (generation !== loginGeneration) return { status: "cancelled", ...snapshot() };
      return handleAuthError(error, { account: normalizedAccount, api });
    } finally {
      inFlight = false;
    }
  }

  /** 请求验证码：邮箱账号发邮件，手机号账号发短信。 */
  async function requestEmailCode({ region, account }) {
    if (inFlight) return { status: "busy", ...snapshot() };
    clearSecrets();
    if (!account) return fail(ERROR_KINDS.invalidCredentials, "请填写账号");
    const resolved = resolveRegion(region);
    const normalizedAccount = normalizeAccount(resolved.id, account);
    const kindError = accountKindError(resolved.id, normalizedAccount);
    if (kindError) return fail(ERROR_KINDS.invalidCredentials, kindError);
    inFlight = true;
    const generation = ++loginGeneration;
    regionId = resolved.id;
    state = STATES.signingIn;
    lastError = null;
    const api = apiFor(regionId);
    try {
      const result = await api.requestEmailCode(normalizedAccount);
      if (generation !== loginGeneration) return { status: "cancelled", ...snapshot() };
      if (result.codeSent) {
        pendingAccount = normalizedAccount;
        pendingApi = api;
        state = STATES.awaitingCode;
        const channelLabel = result.channel === "sms" ? "手机号" : "邮箱";
        return { status: "code-sent", message: `验证码已发送至账号${channelLabel}`, channel: result.channel || "email", ...snapshot() };
      }
      if (!await completeLogin(api, result.login, generation)) return { status: "cancelled", ...snapshot() };
      return { status: "success", ...snapshot() };
    } catch (error) {
      if (generation !== loginGeneration) return { status: "cancelled", ...snapshot() };
      return handleAuthError(error, { account: normalizedAccount, api });
    } finally {
      inFlight = false;
    }
  }

  /** 提交邮箱验证码。 */
  async function submitCode({ code }) {
    if (inFlight) return { status: "busy", ...snapshot() };
    if (!code) return fail(ERROR_KINDS.verificationInvalid, "请输入验证码");
    if (!pendingAccount || !pendingApi) {
      return fail(ERROR_KINDS.verificationInvalid, "验证码流程已失效，请重新登录");
    }
    inFlight = true;
    const generation = ++loginGeneration;
    const account = pendingAccount;
    const api = pendingApi;
    state = STATES.signingIn;
    lastError = null;
    try {
      const result = await api.login({ account, code });
      if (generation !== loginGeneration) return { status: "cancelled", ...snapshot() };
      if (!await completeLogin(api, result, generation)) return { status: "cancelled", ...snapshot() };
      return { status: "success", ...snapshot() };
    } catch (error) {
      if (generation !== loginGeneration) return { status: "cancelled", ...snapshot() };
      return handleAuthError(error, { account, api, retryCode: true });
    } finally {
      inFlight = false;
    }
  }

  async function completeLogin(api, loginResult, generation) {
    const issuedAt = now();
    const expiresAt = Number.isFinite(loginResult?.expiresInSeconds)
      ? issuedAt + loginResult.expiresInSeconds * 1000
      : null;
    let userId = null;
    try {
      userId = await api.fetchUserId(loginResult.accessToken);
    } catch (error) {
      // 拿不到 uid 只影响云 MQTT，登录本身仍应成功。
      logger?.warn?.(`读取用户标识失败：${error?.message || error}`);
    }
    if (generation !== loginGeneration) return false;
    const nextSession = {
      accessToken: loginResult.accessToken,
      refreshToken: loginResult.refreshToken || "",
      userId,
      region: api.regionId,
      issuedAt,
      expiresAt,
    };
    return persist(nextSession, generation, api);
  }

  function handleAuthError(error, { account, api, retryCode = false }) {
    clearSecrets();
    const kind = error instanceof CloudApiError ? error.kind : ERROR_KINDS.unknown;
    const message = error instanceof CloudApiError
      ? error.message
      : (error?.message || "登录失败");
    if (kind === ERROR_KINDS.verificationRequired) {
      state = STATES.awaitingCode;
      pendingAccount = account;
      pendingApi = api;
      lastError = { kind, message };
      return { status: "code-required", ...snapshot() };
    }
    if (retryCode && [ERROR_KINDS.verificationInvalid, ERROR_KINDS.rateLimited, ERROR_KINDS.network, ERROR_KINDS.timeout, ERROR_KINDS.unknown].includes(kind)) {
      pendingAccount = account;
      pendingApi = api;
      return fail(kind, message);
    }
    if (kind === ERROR_KINDS.twoFactorRequired) {
      state = STATES.awaitingTwoFactor;
      lastError = { kind, message: "该账号需要双重认证，当前版本尚不支持，请使用密码登录或关闭双重认证" };
      logger?.warn?.(lastError.message);
      return { status: "unsupported", ...snapshot() };
    }
    if (kind === ERROR_KINDS.unauthorized && /account|region/i.test(message)) {
      return fail(ERROR_KINDS.regionMismatch, regionMismatchHint(api.regionId));
    }
    return fail(kind, message);
  }

  /** 退出登录：关闭云端连接由上层负责，这里只清理本地凭据。 */
  async function logout({ revokeRemote = true } = {}) {
    cancelPendingLogin();
    const token = session.accessToken;
    const api = regionId ? apiFor(regionId) : null;
    session = emptySession();
    sessionPersisted = false;
    state = STATES.signedOut;
    lastError = null;
    clearSecrets();
    if (pendingPersist) await pendingPersist.catch(() => {});
    await credentialStore.clear();
    if (revokeRemote && api && token) {
      // 服务端会话撤销是"尽力而为"：网络失败不能阻止本地退出登录。
      try {
        await api.logout(token);
      } catch (error) {
        logger?.warn?.(`撤销服务端会话失败：${error?.message || error}`);
      }
    }
    return snapshot();
  }

  /** 上层在收到 401 时调用，统一转移到"需要重新登录"。 */
  async function invalidate(reason = "登录已失效，请重新登录") {
    cancelPendingLogin();
    session = emptySession();
    sessionPersisted = false;
    state = STATES.expired;
    lastError = { kind: ERROR_KINDS.unauthorized, message: reason };
    if (pendingPersist) await pendingPersist.catch(() => {});
    await credentialStore.clear();
    return snapshot();
  }

  function getAccessToken() {
    return isExpired() ? null : session.accessToken;
  }

  function getUserId() {
    return session.userId;
  }

  function getRegion() {
    return regionId;
  }

  return {
    STATES,
    get state() {
      return state;
    },
    snapshot,
    hydrate,
    loginWithPassword,
    requestEmailCode,
    submitCode,
    cancelPendingLogin,
    logout,
    invalidate,
    isExpired,
    getAccessToken,
    getUserId,
    getRegion,
  };
}

module.exports = { createAuthService, STATES, normalizeSession, emptySession };
