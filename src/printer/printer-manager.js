const { createCloudMqttClient, CONNECTION_STATES } = require("../cloud/cloud-mqtt");
const { reduceReport, reduceConnection, resetForPrinter } = require("./state-reducer");

/**
 * 设备管理与监控生命周期（见 docs/云端监控设计方案.md §4、§6）。
 *
 * 职责：
 * - 管理"当前选中的打印机"，为多设备扩展预留结构；
 * - 持有云 MQTT 连接，并把报文合并进统一状态模型；
 * - 不在此处做绘制，也不读配置：状态变化通过回调通知上层。
 */
function createPrinterManager({
  createMqttClient = createCloudMqttClient,
  logger,
  now = () => Date.now(),
} = {}) {
  let client = null;
  let printerId = null;
  let printerName = null;
  let state = resetForPrinter(null);
  let lastStatus = { state: CONNECTION_STATES.idle, attempt: 0, lastError: null, subscribed: false };
  const listeners = new Set();

  function notify(change) {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (error) {
        logger?.warn?.(`状态回调失败：${error?.message || error}`);
      }
    }
  }

  function detachClient() {
    if (!client) return;
    const previous = client;
    client = null;
    previous.onReport(null);
    previous.onStatus(null);
    previous.stop();
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
    detachClient();
    printerId = nextId;
    printerName = meta.name || null;
    // 设备切换：整体重置，避免把旧设备状态带过来。
    state = resetForPrinter(printerId);
    lastStatus = { state: CONNECTION_STATES.idle, attempt: 0, lastError: null, subscribed: false };
    notify({ type: "printer", printerId, printerName });
    notify({ type: "state", state, status: lastStatus });
  }

  /**
   * 依据已登录会话启动云连接。
   * @param {{host: string, port: number, userId: string, accessToken: string}} connection
   */
  function connect({ host, port, userId, accessToken }) {
    if (!printerId) return { started: false, reason: "no-printer" };
    detachClient();
    state = reduceConnection(resetForPrinter(printerId), "connecting");
    notify({ type: "state", state, status: lastStatus });

    const next = createMqttClient({
      host,
      port,
      username: `u_${userId}`,
      password: accessToken,
      deviceId: printerId,
      logger,
      now,
    });
    client = next;

    next.onStatus((status) => {
      if (client !== next) return;
      lastStatus = status;
      const mapped = connectionStateFor(status.state);
      state = reduceConnection(state, mapped);
      notify({ type: "connection", status });
      notify({ type: "state", state, status });
    });

    next.onReport(({ raw, receivedAt }) => {
      if (client !== next) return;
      const { state: merged, taskSwitched, reason } = reduceReport(state, raw, { receivedAt });
      state = merged;
      notify({ type: "report", state, taskSwitched, reason });
    });

    next.start();
    return { started: true, reason: null };
  }

  function disconnect() {
    detachClient();
    state = reduceConnection(state, "disconnected");
    lastStatus = { state: CONNECTION_STATES.idle, attempt: 0, lastError: null, subscribed: false };
    notify({ type: "state", state, status: lastStatus });
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
    requestFullState(options) {
      if (!client) return { sent: false, reason: "not-connected" };
      return client.requestFullState(options);
    },
    get connected() {
      return lastStatus?.state === CONNECTION_STATES.connected;
    },
  };
}

module.exports = { createPrinterManager };
