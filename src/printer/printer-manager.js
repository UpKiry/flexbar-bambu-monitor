const { createCloudMqttClient, CONNECTION_STATES } = require("../cloud/cloud-mqtt");
const { reduceReport, reduceConnection, resetForPrinter } = require("./state-reducer");
const { createPresence, hasTelemetry } = require("./presence");
const { createRefreshScheduler } = require("./refresh-scheduler");

/** 递归冻结已发布的状态树；只在新版本产生时调用一次，不在每次读取时遍历。 */
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

/**
 * 设备管理与监控生命周期（见 docs/架构设计.md「设备生命周期」）。
 *
 * 职责：
 * - 管理"当前选中的打印机"，为多设备扩展预留结构；
 * - 持有云 MQTT 连接，并把报文合并进统一状态模型；
 * - 不在此处做绘制，也不读配置：状态变化通过回调通知上层。
 *
 * 发布契约：
 * - `state` 是 reducer 产出的领域状态，读作只读快照；修改必须经过 `reduceReport` / `reduceConnection`。
 * - `status` 是连接状态（broker 侧），与设备 presence、打印 activity 分开维护。
 * - `presence` 每次返回副本；`state` / `status` 的冻结在后续阶段统一加强。
 * - 订阅回调收到的事件仅供消费；事件里的状态与 getter 属于同一版本。
 */
function createPrinterManager({
  createMqttClient = createCloudMqttClient,
  logger,
  onFrame,
  now = () => Date.now(),
  closeTimeoutMs = 6_000,
} = {}) {
  let client = null;
  let generation = 0;
  let closing = null;
  let printerId = null;
  let printerName = null;
  let state = deepFreeze(resetForPrinter(null));
  let presenceTracker = createPresence({ now });
  let refreshScheduler = createRefreshScheduler({ now });

  let lastNotifiedPresence = presenceTracker.value;
  function notifyPresence() {
    const presence = presenceTracker.value;
    if (presence.state === lastNotifiedPresence.state && presence.source === lastNotifiedPresence.source) return;
    lastNotifiedPresence = presence;
    notify({ type: "presence", presence });
  }

  function markObservationsStale() {
    const connection = state.connection;
    publishState({ ...reduceConnection(state, "disconnected"), connection });
  }

  function tick() {
    const previousState = presenceTracker.value.state;
    const recoveryDue = presenceTracker.tick();
    if (previousState !== "unresponsive" && presenceTracker.value.state === "unresponsive") markObservationsStale();
    const reason = refreshScheduler.due(state, presenceTracker.value, recoveryDue);
    if (reason && client && lastStatus.state === CONNECTION_STATES.connected && lastStatus.subscribed) {
      requestFullState({ automatic: true, reason });
    }
    notifyPresence();
    return presenceTracker.value;
  }
  let lastStatus = deepFreeze({ state: CONNECTION_STATES.idle, attempt: 0, lastError: null, subscribed: false });
  const listeners = new Set();

  /**
   * 发布只读快照：状态树在产生新版本时递归冻结一次，
   * getter、订阅回调和 HTTP 序列化共享同一版本，避免调用方绕过 reducer 修改。
   */
  function publishState(next) {
    state = deepFreeze(next);
    return state;
  }

  function publishStatus(next) {
    lastStatus = deepFreeze({ ...next });
    return lastStatus;
  }


  function notify(change) {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        logger?.warn?.("状态回调失败");
      }
    }
  }

  function detachClient() {
    if (!client) return closing;
    const previous = client;
    client = null;
    previous.onReport(null);
    previous.onStatus(null);
    previous.onPresence?.(null);
    let result;
    try {
      result = previous.stop();
    } catch {
      result = Promise.reject(new Error("无法确认旧连接已关闭"));
    }
    if (result && typeof result.then === "function") {
      let timer;
      const pending = Promise.race([
        Promise.resolve(result),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("无法确认旧连接已关闭")), closeTimeoutMs); }),
      ]);
      pending.then(() => clearTimeout(timer), () => clearTimeout(timer));
      closing = pending;
      pending.then(() => {
        if (closing === pending) closing = null;
      }, () => {});
    }
    return closing;
  }

  function connectionStateFor(mqttState) {
    if (mqttState === CONNECTION_STATES.connected) return "connected";
    if (mqttState === CONNECTION_STATES.connecting) return "connecting";
    if (mqttState === CONNECTION_STATES.reconnecting) return "reconnecting";
    if (mqttState === CONNECTION_STATES.failed) return "error";
    return "disconnected";
  }

  /**
   * 选择设备。printerId 为空表示不监控。
   * @param {string|null} id
   * @param {{name?: string}} [meta]
   */
  function selectPrinter(id, meta = {}) {
    const nextId = id ? String(id) : null;
    if (nextId === printerId) {
      if (meta.name && meta.name !== printerName) {
        printerName = meta.name;
        notify({ type: "printer", printerId, printerName });
      }
      return;
    }
    generation += 1;
    detachClient();
    printerId = nextId;
    printerName = meta.name || null;
    // 设备切换：整体重置，避免把旧设备状态带过来。
    publishState(resetForPrinter(printerId));
    presenceTracker = createPresence({ now });
    refreshScheduler = createRefreshScheduler({ now });
    notifyPresence();
    publishStatus({ state: CONNECTION_STATES.idle, attempt: 0, lastError: null, subscribed: false });
    notify({ type: "printer", printerId, printerName });
    notify({ type: "state", state, status: lastStatus });
  }

  /**
   * 依据已登录会话启动云连接。
   * @param {{host: string, port: number, userId: string, accessToken: string}} connection
   */
  function connect({ host, port, userId, accessToken }) {
    if (!printerId) return { started: false, reason: "no-printer" };
    const myGeneration = ++generation;
    const selectedId = printerId;
    const pending = detachClient();
    publishState(reduceConnection(state, "connecting"));
    presenceTracker.broker(false);
    refreshScheduler.broker(false);
    notifyPresence();
    publishStatus({ state: CONNECTION_STATES.connecting, attempt: 0, lastError: null, subscribed: false });
    notify({ type: "state", state, status: lastStatus });

    function startClient() {
      if (generation !== myGeneration || printerId !== selectedId) return;
      const next = createMqttClient({
        host,
        port,
        username: `u_${userId}`,
        password: accessToken,
        deviceId: selectedId,
        logger,
        now,
        onFrame: (event) => {
          if (generation !== myGeneration || printerId !== selectedId) return;
          try {
            const result = onFrame?.(event);
            if (result && typeof result.catch === "function") result.catch(() => {});
          } catch {
            // Diagnostics must not affect printer state.
          }
        },
      });
      client = next;

      next.onStatus((status) => {
        if (client !== next || generation !== myGeneration) return;
        publishStatus(status);
        const mapped = connectionStateFor(status.state);
        publishState(reduceConnection(state, mapped));
        const ready = status.state === CONNECTION_STATES.connected && status.subscribed === true;
        presenceTracker.broker(ready);
        refreshScheduler.broker(ready);
        notifyPresence();
        notify({ type: "connection", status: lastStatus });
        notify({ type: "state", state, status: lastStatus });
      });

      next.onPresence?.((event) => {
        if (client !== next || generation !== myGeneration) return;
        const at = Number.isFinite(event.receivedAt) ? event.receivedAt : now();
        if (event.type === "message") presenceTracker.message(at);
        if (event.type === "event") {
          if (event.event === "client.connected" || event.event === "client.disconnected") markObservationsStale();
          presenceTracker.event(event.event, at);
          if (event.event === "client.connected") refreshScheduler.onlineEvent();
        }
        notifyPresence();
      });
      next.onReport(({ raw, amsIdentities, receivedAt }) => {
        if (client !== next || generation !== myGeneration) return;
        const at = Number.isFinite(receivedAt) ? receivedAt : now();
        presenceTracker.message(at);
        if (hasTelemetry(raw)) presenceTracker.telemetry(at);
        const { state: merged, taskSwitched, reason } = reduceReport(state, raw, { receivedAt: at, amsIdentities });
        publishState(merged);
        refreshScheduler.observe(state);
        // Report listeners must see the merged data before any urgent presence draw.
        notify({ type: "report", state, taskSwitched, reason });
        notifyPresence();
      });
      next.start();
    }

    if (pending) {
      pending.then(startClient, () => {
        if (generation !== myGeneration) return;
        publishStatus({ state: CONNECTION_STATES.failed, attempt: 0, lastError: { kind: "network", message: "无法确认旧连接已关闭" }, subscribed: false });
        publishState(reduceConnection(state, "error"));
        notify({ type: "state", state, status: lastStatus });
      }).catch(() => {
        if (generation !== myGeneration) return;
        publishStatus({ state: CONNECTION_STATES.failed, attempt: 0, lastError: { kind: "network", message: "无法启动云连接" }, subscribed: false });
        publishState(reduceConnection(state, "error"));
        notify({ type: "state", state, status: lastStatus });
      });
    } else startClient();
    return { started: true, reason: null };
  }

  function disconnect() {
    generation += 1;
    const pending = detachClient();
    publishState(reduceConnection(state, "disconnected"));
    presenceTracker.broker(false);
    refreshScheduler.broker(false);
    notifyPresence();
    publishStatus({ state: CONNECTION_STATES.idle, attempt: 0, lastError: null, subscribed: false });
    notify({ type: "state", state, status: lastStatus });
    return pending || Promise.resolve();
  }

  function requestFullState(options) {
    if (!client) return { sent: false, reason: "not-connected" };
    const result = client.requestFullState(options);
    // Failed publication can still reach the broker and consumes the budget.
    if (result?.sent || result?.reason === "publish-failed") {
      refreshScheduler.requested(state, options?.automatic === true);
      const silentAttempt = options?.automatic === true && presenceTracker.value.state !== "online";
      presenceTracker.requested(now(), silentAttempt);
      notifyPresence();
    }
    return result;
  }

  return {
    selectPrinter,
    connect,
    disconnect,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get printerId() {
      return printerId;
    },
    get printerName() {
      return printerName;
    },
    get state() {
      return state;
    },
    get status() {
      return lastStatus;
    },
    get presence() { return presenceTracker.value; },
    tick,
    requestFullState,
    get connected() {
      return lastStatus?.state === CONNECTION_STATES.connected;
    },
  };
}

module.exports = { createPrinterManager };
