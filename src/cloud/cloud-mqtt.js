/**
 * 云 MQTT 连接（见 docs/云端监控设计方案.md §6.2）。
 *
 * 社区资料描述的方案：用云账号令牌连接 MQTT，订阅 `device/{DEVICE_ID}/report`。
 * 需要在该区域的服务地址、用户标识、令牌权限、TLS 证书都验证过之后才真正可用。
 *
 * 这里刻意把网络层封装成可注入的 `createClient`，这样：
 * - 单元测试可以用假客户端验证订阅、重连、退避和令牌失效；
 * - 换成别的 MQTT 库或改用 WebSocket 不需要改上层逻辑。
 */

const { performance } = require("node:perf_hooks");
const { mapAmsIdentities } = require("../printer/state-mapper");
const { sanitizePayload } = require("../admin/debug-redaction");

const TOPIC_PREFIX = "device";
const MAX_REPORT_BYTES = 256 * 1024;
const PUSHALL_COOLDOWN_MS = 5_000;
// Share the cooldown across clients in this process so replacing a connection cannot bypass it.
const pushallCooldowns = new Map();

function validDeviceId(deviceId) {
  return typeof deviceId === "string" && deviceId.length > 0 && !/[\/+\u0023\u0000-\u001f\u007f]/.test(deviceId);
}

/** 与 mqtt 库的错误码对齐，但只依赖数字常量，避免测试引入真实依赖。 */
const MQTT_ERRORS = {
  connectionRefused: 1,
  unauthorized: 4,
  notAuthorized: 5,
};

/** 认知中的云端状态主题。 */
function reportTopic(deviceId) {
  return `${TOPIC_PREFIX}/${deviceId}/report`;
}

function requestTopic(deviceId) {
  return `${TOPIC_PREFIX}/${deviceId}/request`;
}

function defaultCreateClient(url, options) {
  // 延迟加载：只有真正要连云端时才引入 mqtt，避免影响插件启动时间。
  const mqtt = require("mqtt");
  return mqtt.connect(url, options);
}

function randomClientId(random = Math.random) {
  const suffix = Math.floor(random() * 1e9).toString(36);
  return `flexbar-bambu-monitor-${suffix}`;
}

/** 指数退避 + 抖动：第 n 次失败后退避 base * 2^(n-1)，并随机抖动 0–40%。 */
function backoffDelay(attempt, { baseMs = 2_000, maxMs = 60_000, random = Math.random } = {}) {
  const safeAttempt = Math.max(1, Math.min(attempt, 12));
  const raw = Math.min(maxMs, baseMs * 2 ** (safeAttempt - 1));
  const jitter = raw * 0.4 * random();
  return Math.round(raw + jitter);
}

const CONNECTION_STATES = {
  idle: "idle",
  connecting: "connecting",
  connected: "connected",
  reconnecting: "reconnecting",
  failed: "failed",
};

/**
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} options.username 形如 `u_{uid}`
 * @param {string} options.password 访问令牌
 * @param {string} options.deviceId
 * @param {object} options.logger
 * @param {(url: string, options: object) => object} [options.createClient]
 * @param {() => number} [options.now]
 * @param {() => number} [options.cooldownNow]
 * @param {() => number} [options.random]
 */
function createCloudMqttClient({
  host,
  port = 8883,
  username,
  password,
  deviceId,
  logger,
  onFrame,
  createClient = defaultCreateClient,
  now = () => Date.now(),
  cooldownNow = () => performance.now(),
  random = Math.random,
  baseBackoffMs = 2_000,
  maxBackoffMs = 60_000,
  keepaliveSeconds = 60,
  closeTimeoutMs = 5_000,
}) {
  let client = null;
  let state = CONNECTION_STATES.idle;
  let attempt = 0;
  let stopped = true;
  let reconnectTimer = null;
  let lastError = null;
  let reportHandler = null;
  let statusHandler = null;
  let subscribed = false;
  // A pending close gates both automatic reconnect and manager replacement.
  let closingPromise = null;

  function emitStatus(patch = {}) {
    const payload = { state, attempt, lastError, subscribed, ...patch };
    if (statusHandler) {
      try {
        statusHandler(payload);
      } catch {
        logger?.warn?.("MQTT 状态回调失败");
      }
    }
  }

  function setState(next, patch) {
    if (state === next && !patch) return;
    state = next;
    emitStatus(patch);
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(reason) {
    if (stopped) return;
    clearReconnectTimer();
    attempt += 1;
    const delay = backoffDelay(attempt, { baseMs: baseBackoffMs, maxMs: maxBackoffMs, random });
    setState(CONNECTION_STATES.reconnecting, { nextRetryInMs: delay, reason });
    logger?.warn?.(`云连接中断（${reason}），${Math.round(delay / 1000)} 秒后重试（第 ${attempt} 次）`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closingPromise) {
        closingPromise.then(() => connect(), () => {
          if (!stopped) {
            lastError = { kind: "network", message: "无法确认旧连接已关闭" };
            setState(CONNECTION_STATES.failed);
          }
        });
      } else {
        connect();
      }
    }, delay);
    if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
  }

  /** 令牌失效时停止持续重试，交给上层提示重新登录。 */
  function failAuth(reason) {
    stopped = true;
    clearReconnectTimer();
    teardownClient();
    lastError = { kind: "unauthorized", message: reason };
    setState(CONNECTION_STATES.failed, { reason });
    logger?.error?.(`云连接认证失败：${reason}`);
  }

  function teardownClient(alreadyClosed = false) {
    const current = client;
    client = null;
    subscribed = false;
    if (!current) return closingPromise;
    current.removeAllListeners?.();
    let resolveClose;
    let rejectClose;
    const pending = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    const timer = setTimeout(() => rejectClose(new Error("无法确认旧连接已关闭")), closeTimeoutMs);
    closingPromise = pending;
    // A close event confirms the transport is closed. mqtt.js end callback is
    // another confirmation after its cleanup completes.
    current.once?.("close", resolveClose);
    current.on?.("error", () => {});
    try {
      current.end(true, (error) => error ? rejectClose(new Error("关闭云连接失败")) : resolveClose());
      if (alreadyClosed) resolveClose();
    } catch {
      if (alreadyClosed) resolveClose();
      else rejectClose(new Error("关闭云连接失败"));
    }
    pending.then(() => {
      clearTimeout(timer);
      if (closingPromise === pending) closingPromise = null;
    }, () => clearTimeout(timer));
    return pending;
  }

  function captureFrame(topic, payload, truncated = false) {
    if (typeof onFrame !== "function") return;
    try {
      const safe = sanitizePayload(payload);
      const result = onFrame({ protocol: "mqtt", source: topic, at: now(), ...safe, truncated: truncated || safe.truncated });
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // Observers must not prevent business handling, including non-print JSON.
    }
  }

  function handleMessage(topic, payload) {
    if (topic !== reportTopic(deviceId) || !Buffer.isBuffer(payload)) return;
    if (payload.length > MAX_REPORT_BYTES) {
      captureFrame(topic, { oversize: true, bodyOmitted: true, bytes: payload.length }, true);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(payload.toString());
    } catch {
      captureFrame(topic, { parseError: true, bodyOmitted: true, bytes: payload.length });
      logger?.warn?.("收到无法解析的云端报文，已忽略");
      return;
    }
    captureFrame(topic, parsed);
    const candidate = parsed?.print;
    const raw = candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
      (!candidate.command || candidate.command === "push_status" || candidate.command === "pushall") ? candidate : null;
    const amsIdentities = mapAmsIdentities(parsed?.info?.module);
    if (!raw && !amsIdentities.length) return;
    if (!reportHandler) return;
    try {
      reportHandler({ ...(raw ? { raw } : {}), ...(amsIdentities.length ? { amsIdentities } : {}), receivedAt: now() });
    } catch {
      logger?.error?.("处理云端报文失败");
    }
  }

  function connect() {
    if (stopped) return;
    // 已经有一个连接时不重复建立。
    if (client) return;
    attempt = attempt === 0 ? 1 : attempt;
    setState(attempt > 1 ? CONNECTION_STATES.reconnecting : CONNECTION_STATES.connecting);

    const url = `mqtts://${host}:${port}`;
    const options = {
      username,
      password,
      clientId: randomClientId(random),
      clean: true,
      keepalive: keepaliveSeconds,
      reconnectPeriod: 0, // 重连由本模块控制，才能做真正的抖动退避。
      connectTimeout: 15_000,
      rejectUnauthorized: true, // 设计文档要求使用 TLS 并验证证书，不全局关闭校验。
    };

    let next;
    try {
      next = createClient(url, options);
    } catch {
      lastError = { kind: "network", message: "无法创建云连接" };
      scheduleReconnect("create-failed");
      return;
    }
    client = next;

    next.on("connect", () => {
      if (client !== next || stopped) return;
      const topic = reportTopic(deviceId);
      let settled = false;
      const onSubscribed = (error, granted) => {
        if (settled || client !== next || stopped) return;
        settled = true;
        const rejected = granted?.some((entry) => entry.qos >= 128);
        if (error || rejected) {
          const message = "云端状态订阅失败";
          lastError = { kind: "network", message };
          logger?.warn?.(`订阅云端状态失败：${message}`);
          teardownClient();
          scheduleReconnect("subscribe-failed");
          return;
        }
        subscribed = true;
        attempt = 0;
        lastError = null;
        setState(CONNECTION_STATES.connected);
        logger?.info?.("已连接云端并订阅设备状态");
      };
      try {
        next.subscribe(topic, { qos: 0 }, onSubscribed);
      } catch (error) {
        onSubscribed(error);
      }
    });

    next.on("message", (topic, payload) => {
      if (client === next && !stopped) handleMessage(topic, payload);
    });

    next.on("error", (error) => {
      if (client !== next || stopped) return;
      const code = error?.code;
      lastError = { kind: code === MQTT_ERRORS.notAuthorized || code === MQTT_ERRORS.unauthorized ? "unauthorized" : "network", message: "云连接错误" };
      if (code === MQTT_ERRORS.notAuthorized || code === MQTT_ERRORS.unauthorized) {
        failAuth("云端拒绝了凭据，登录可能已失效");
      }
      // 其它错误由 'close' 统一触发重连，避免两处各排一个定时器。
    });

    next.on("close", () => {
      if (client !== next || stopped) return;
      teardownClient(true);
      if (state === CONNECTION_STATES.failed) return;
      scheduleReconnect("connection-closed");
    });
  }

  return {
    get state() {
      return state;
    },
    get subscribed() {
      return subscribed;
    },
    get attempt() {
      return attempt;
    },
    onReport(handler) {
      reportHandler = handler;
    },
    onStatus(handler) {
      statusHandler = handler;
    },
    start() {
      if (!host || !username || !password || !validDeviceId(deviceId)) {
        lastError = { kind: "config", message: "缺少云连接所需的地址、用户标识或令牌" };
        setState(CONNECTION_STATES.failed, { reason: "missing-config" });
        return false;
      }
      if (!stopped) return true;
      stopped = false;
      attempt = 0;
      emitStatus();
      if (closingPromise) {
        closingPromise.then(() => connect(), () => {
          if (!stopped) {
            lastError = { kind: "network", message: "无法确认旧连接已关闭" };
            setState(CONNECTION_STATES.failed);
          }
        });
      } else connect();
      return true;
    },
    stop() {
      stopped = true;
      clearReconnectTimer();
      const closed = teardownClient();
      state = CONNECTION_STATES.idle;
      attempt = 0;
      emitStatus();
      return closed || Promise.resolve();
    },
    /**
     * 主动请求完整状态。
     *
     * 这是只读状态查询，不包含打印控制命令；同一设备至少间隔 5 秒。
     */
    requestFullState() {
      if (!client || state !== CONNECTION_STATES.connected) return { sent: false, reason: "not-connected" };
      const stamp = cooldownNow();
      for (const [id, expiry] of pushallCooldowns) {
        if (stamp >= expiry) pushallCooldowns.delete(id);
      }
      const expiry = pushallCooldowns.get(deviceId);
      if (expiry !== undefined) {
        return { sent: false, reason: "cooldown", retryInMs: expiry - stamp };
      }
      // 一旦尝试发送便计入冷却，异步错误也无法证明设备没有收到。
      pushallCooldowns.set(deviceId, stamp + PUSHALL_COOLDOWN_MS);
      let publishFailed = false;
      try {
        client.publish(
          requestTopic(deviceId),
          JSON.stringify({ pushing: { sequence_id: "0", command: "pushall", version: 1, push_target: 1 } }),
          { qos: 1 },
          (error) => {
            if (error) {
              publishFailed = true;
              logger?.warn?.("完整状态请求发送失败");
            }
          },
        );
        // mqtt.js 接受发送请求不等于设备已收到或回应。
        if (publishFailed) return { sent: false, reason: "publish-failed" };
        return { sent: true, reason: null };
      } catch {
        return { sent: false, reason: "publish-failed" };
      }
    },
    status() {
      return { state, attempt, lastError, subscribed };
    },
  };
}

module.exports = {
  TOPIC_PREFIX,
  MQTT_ERRORS,
  CONNECTION_STATES,
  reportTopic,
  requestTopic,
  backoffDelay,
  randomClientId,
  createCloudMqttClient,
};
