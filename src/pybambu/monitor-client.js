const path = require("node:path");
const { PyBambuBridge } = require("./bridge");
const { CONNECTION_STATES } = require("../cloud/cloud-mqtt");

// 开发用被动订阅适配器；调用者负责选择可信的绝对路径和互斥的后端。
function createPyBambuMonitorClient({
  pythonCommand, scriptPath, host, port, username, password, deviceId,
  bridgeFactory = (options) => new PyBambuBridge(options),
  pollIntervalMs = 1000, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  if (!path.isAbsolute(pythonCommand || "") || !path.isAbsolute(scriptPath || "")) {
    throw new TypeError("必须提供可信 Python 和脚本绝对路径");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) throw new TypeError("轮询间隔无效");
  const regions = { "cn.mqtt.bambulab.com": "China", "us.mqtt.bambulab.com": "Global" };
  const region = Object.hasOwn(regions, host) ? regions[host] : null;
  let bridge = null;
  let running = false;
  let epoch = 0;
  let timer = null;
  let closePromise = null;
  let reportHandler = null;
  let statusHandler = null;
  let status = { state: CONNECTION_STATES.idle, attempt: 0, lastError: null, subscribed: false };

  function emit(next, error = null) {
    status = { state: next, attempt: 0, lastError: error, subscribed: next === CONNECTION_STATES.connected };
    try { statusHandler?.(status); } catch { /* 消费者异常不能影响监控 */ }
  }
  function isCurrent(generation, instance) { return running && epoch === generation && bridge === instance; }
  function schedule(generation, instance, remoteGeneration, cursor, delay) {
    if (!isCurrent(generation, instance)) return;
    timer = setTimer(() => {
      timer = null;
      poll(generation, instance, remoteGeneration, cursor);
    }, delay);
    timer?.unref?.();
  }
  function connection(value) {
    switch (value) {
      case "connecting": case "subscribing": return CONNECTION_STATES.connecting;
      case "connected": return CONNECTION_STATES.connected;
      case "disconnected": return CONNECTION_STATES.reconnecting;
      case "auth_failed": case "model_error": case "stopped": return CONNECTION_STATES.failed;
      default: return null;
    }
  }
  function failure(generation, instance, kind = "network") {
    if (!isCurrent(generation, instance)) return;
    running = false;
    epoch += 1;
    if (timer) clearTimer(timer);
    timer = null;
    // 不吞掉关闭失败：后续 stop 必须向管理器传播，防止建立第二条连接。
    closePromise = Promise.resolve().then(() => instance.stop());
    closePromise.catch(() => {});
    emit(CONNECTION_STATES.failed, {
      kind,
      message: kind === "unauthorized" ? "云端拒绝了凭据，登录可能已失效" : "Python 监控后端不可用",
    });
  }
  async function poll(generation, instance, remoteGeneration, cursor) {
    try {
      const result = await instance.request("monitor.poll", { generation: remoteGeneration, afterSeq: cursor });
      if (!isCurrent(generation, instance)) return;
      if (!result || result.generation !== remoteGeneration || result.deviceId !== deviceId ||
          !Number.isSafeInteger(result.nextSeq) || result.nextSeq < cursor ||
          !Array.isArray(result.events) || result.events.length > 16 ||
          typeof result.resetRequired !== "boolean" || typeof result.hasMore !== "boolean") throw new Error();
      if (result.resetRequired) {
        if (result.events.length || !connection(result.currentConnection)) throw new Error();
        emit(CONNECTION_STATES.reconnecting);
        const mapped = connection(result.currentConnection);
        if (mapped === CONNECTION_STATES.connected) emit(mapped);
        else if (result.currentConnection === "auth_failed") return failure(generation, instance, "unauthorized");
        else if (mapped === CONNECTION_STATES.failed) return failure(generation, instance);
        else if (mapped) emit(mapped);
        schedule(generation, instance, remoteGeneration, result.nextSeq, pollIntervalMs);
        return;
      }
      let last = cursor;
      for (const event of result.events) {
        if (!event || !Number.isSafeInteger(event.seq) || event.seq !== last + 1 ||
            !Number.isSafeInteger(event.receivedAtMs) || event.receivedAtMs < 0 ||
            !event.data || typeof event.data !== "object" || Array.isArray(event.data) ||
            !["connection", "report"].includes(event.type) ||
            (event.type === "connection" && !connection(event.data.state))) throw new Error();
        last = event.seq;
      }
      if (last !== result.nextSeq || (result.hasMore && !result.events.length)) throw new Error();
      for (const event of result.events) {
        if (event.type === "connection") {
          const mapped = connection(event.data.state);
          if (!mapped) throw new Error();
          if (event.data.state === "auth_failed") return failure(generation, instance, "unauthorized");
          if (mapped === CONNECTION_STATES.failed) return failure(generation, instance);
          emit(mapped);
        } else if (event.type === "report") {
          try { reportHandler?.({ raw: event.data, receivedAt: event.receivedAtMs }); } catch { /* 隔离消费者 */ }
        } else throw new Error();
        if (!isCurrent(generation, instance)) return;
      }
      schedule(generation, instance, remoteGeneration, last, result.hasMore ? 0 : pollIntervalMs);
    } catch {
      failure(generation, instance);
    }
  }
  async function begin(generation, instance) {
    try {
      instance.start();
      // 用户名和令牌仅经过 bridge 的 stdin 请求，不进入 argv、环境或诊断。
      const started = await instance.request("monitor.start", { region, deviceId, username, token: password });
      if (!isCurrent(generation, instance)) return;
      if (!started || started.deviceId !== deviceId || !Number.isSafeInteger(started.generation) || started.generation < 1) throw new Error();
      await poll(generation, instance, started.generation, 0);
    } catch {
      failure(generation, instance);
    }
  }
  return {
    onStatus(handler) { statusHandler = typeof handler === "function" ? handler : null; },
    onReport(handler) { reportHandler = typeof handler === "function" ? handler : null; },
    start() {
      if (running) return true;
      if (bridge || closePromise || !region || (port !== undefined && port !== 8883) ||
          typeof username !== "string" || !username || typeof password !== "string" || !password ||
          typeof deviceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) {
        emit(CONNECTION_STATES.failed, { kind: "config", message: "Python 监控配置无效或旧进程尚未关闭" });
        return false;
      }
      try { bridge = bridgeFactory({ pythonCommand, scriptPath, mode: "monitor" }); } catch {
        emit(CONNECTION_STATES.failed, { kind: "network", message: "Python 监控后端不可用" });
        return false;
      }
      running = true;
      const generation = ++epoch;
      emit(CONNECTION_STATES.connecting);
      begin(generation, bridge);
      return true;
    },
    stop() {
      running = false;
      epoch += 1;
      if (timer) clearTimer(timer);
      timer = null;
      const instance = bridge;
      if (!closePromise && instance) closePromise = Promise.resolve().then(() => instance.stop());
      const pending = closePromise || Promise.resolve();
      emit(CONNECTION_STATES.idle);
      return pending.then(() => {
        if (bridge === instance) bridge = null;
        if (closePromise === pending) closePromise = null;
      }, () => { throw new Error("无法确认 Python 监控进程已关闭"); });
    },
    requestFullState() { return { sent: false, reason: "unsupported" }; },
    status() { return { ...status }; },
    get state() { return status.state; },
    get subscribed() { return status.subscribed; },
  };
}

module.exports = { createPyBambuMonitorClient };
