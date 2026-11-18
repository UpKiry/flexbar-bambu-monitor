const { spawn } = require("node:child_process");
const path = require("node:path");

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

// These are the only externally callable methods in the two experimental protocols.
const METHODS = Object.freeze({
  probe: new Set(["update"]),
  monitor: new Set(["monitor.start", "monitor.snapshot", "monitor.poll", "monitor.stop"]),
});
const MONITOR_CAPABILITIES = ["monitor.passive", "monitor.snapshot", "monitor.poll-deltas"];

/** Experimental JSON-lines bridge. start() starts negotiation; request() waits for it. */
class PyBambuBridge {
  constructor({ spawnFn = spawn, pythonCommand, scriptPath, mode = "probe", timeoutMs = 15_000, maxOutputBytes = 1024 * 1024, maxRequestBytes = 65536, maxPendingRequests = 100, stopTimeoutMs = 1000 } = {}) {
    if (typeof spawnFn !== "function" || typeof pythonCommand !== "string" || !path.isAbsolute(pythonCommand) || typeof scriptPath !== "string" || !path.isAbsolute(scriptPath) || !Object.hasOwn(METHODS, mode)) {
      throw new TypeError("必须提供 Python 和脚本的绝对路径及有效模式");
    }
    for (const value of [timeoutMs, maxOutputBytes, maxRequestBytes, maxPendingRequests, stopTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("超时和输出限制必须为正整数");
    }
    Object.assign(this, { spawnFn, pythonCommand, scriptPath, mode, timeoutMs, maxOutputBytes, maxRequestBytes, maxPendingRequests, stopTimeoutMs });
    this.child = null;
    this.state = "idle";
    this.pending = new Map();
    this.activeRequests = 0;
    this.nextId = 1;
    this.parts = [];
    this.partBytes = 0;
    this.stopPromise = null;
    this.readyPromise = null;
  }

  start() {
    if (this.state !== "idle") throw new BridgeError("BRIDGE_STATE", "桥接进程已启动或正在关闭");
    let child;
    try {
      child = this.spawnFn(this.pythonCommand, [this.scriptPath], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    } catch (_) {
      throw new BridgeError("SPAWN_FAILED", "无法启动桥接进程");
    }
    this.child = child;
    this.state = "starting";
    child.stdout.on("data", (chunk) => this.onData(child, chunk));
    child.stdout.on("error", () => this.fail(child, "STREAM_ERROR", "桥接输出流异常"));
    child.stderr.on("data", () => {});
    child.stderr.on("error", () => this.fail(child, "STREAM_ERROR", "桥接错误流异常"));
    child.stdin.on("error", () => this.fail(child, "STREAM_ERROR", "桥接输入流异常"));
    child.on("error", () => this.fail(child, "PROCESS_ERROR", "桥接进程异常"));
    child.on("close", () => {
      if (this.child !== child) return;
      this.rejectAll(new BridgeError("PROCESS_CLOSED", "桥接进程已关闭"));
      this.parts = [];
      this.partBytes = 0;
      this.child = null;
      this.state = "idle";
    });
    this.readyPromise = this.send("hello", {}).then((result) => {
      if (!result || typeof result !== "object" || Array.isArray(result) || result.protocol !== 1 ||
          (this.mode === "monitor" && (!Array.isArray(result.capabilities) ||
            !MONITOR_CAPABILITIES.every((capability) => result.capabilities.includes(capability))))) {
        throw new BridgeError("HANDSHAKE_FAILED", "桥接协议或能力不兼容");
      }
      // The legacy offline probe only advertises {protocol:1}; its fixed mode
      // grants update, whereas monitor requires explicit capability advertisement.
      if (this.child !== child || this.state !== "starting") throw new BridgeError("BRIDGE_STOPPED", "桥接进程已停止");
      this.state = "running";
      return result;
    }).catch((error) => {
      if (this.child === child && this.state === "starting") this.stop().catch(() => {});
      throw error;
    });
    // A caller may start and stop without making a request.
    this.readyPromise.catch(() => {});
    return this;
  }

  request(method, params = {}) {
    if (this.state !== "starting" && this.state !== "running") return Promise.reject(new BridgeError("BRIDGE_STATE", "桥接进程未运行"));
    if (method !== "hello" && !METHODS[this.mode].has(method)) return Promise.reject(new BridgeError("METHOD_NOT_ALLOWED", "桥接方法未授权"));
    if (method === "hello" && (params === null || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length)) {
      return Promise.reject(new BridgeError("INVALID_REQUEST", "握手参数无效"));
    }
    const child = this.child;
    if (method === "hello") return this.readyPromise;
    if (this.activeRequests >= this.maxPendingRequests) return Promise.reject(new BridgeError("PENDING_LIMIT", "待处理请求数量超过限制"));
    this.activeRequests += 1;
    return this.readyPromise.then(() => {
      if (this.child !== child || this.state !== "running") throw new BridgeError("BRIDGE_STOPPED", "桥接进程已停止");
      return this.send(method, params);
    }).finally(() => { this.activeRequests -= 1; });
  }

  send(method, params) {
    if (this.pending.size >= this.maxPendingRequests) return Promise.reject(new BridgeError("PENDING_LIMIT", "待处理请求数量超过限制"));
    const id = this.nextId++;
    let line;
    try { line = JSON.stringify({ id, method, params }) + "\n"; } catch (_) {
      return Promise.reject(new BridgeError("INVALID_REQUEST", "请求无法序列化"));
    }
    if (Buffer.byteLength(line) > this.maxRequestBytes) return Promise.reject(new BridgeError("REQUEST_LIMIT", "桥接请求超过大小限制"));
    const child = this.child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("TIMEOUT", "桥接请求超时"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(line, (error) => {
          if (error) this.fail(child, "STREAM_ERROR", "桥接输入流异常");
        });
      } catch (_) {
        this.fail(child, "STREAM_ERROR", "桥接输入流异常");
      }
    });
  }

  onData(child, chunk) {
    if (this.child !== child || !["starting", "running", "stopping"].includes(this.state)) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < data.length) {
      const end = data.indexOf(10, start);
      const next = end === -1 ? data.length : end;
      const length = next - start;
      if (this.partBytes + length > this.maxOutputBytes) {
        this.fail(child, "OUTPUT_LIMIT", "桥接输出超过限制");
        return;
      }
      if (length) {
        this.parts.push(Buffer.from(data.subarray(start, next)));
        this.partBytes += length;
      }
      if (end === -1) return;
      const line = Buffer.concat(this.parts, this.partBytes).toString("utf8");
      this.parts = [];
      this.partBytes = 0;
      let message;
      try { message = JSON.parse(line); } catch (_) {
        this.fail(child, "PROTOCOL_ERROR", "桥接响应格式无效");
        return;
      }
      const hasResult = message && Object.hasOwn(message, "result");
      const hasError = message && Object.hasOwn(message, "error");
      if (!message || typeof message !== "object" || !Number.isSafeInteger(message.id) || hasResult === hasError ||
          (hasError && (!message.error || typeof message.error !== "object" ||
            !(typeof message.error.code === "string" || typeof message.error.code === "number") || typeof message.error.message !== "string"))) {
        this.fail(child, "PROTOCOL_ERROR", "桥接响应格式无效");
        return;
      }
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (hasError) pending.reject(new BridgeError("REMOTE_ERROR", "桥接远端返回错误"));
        else pending.resolve(message.result);
      }
      start = end + 1;
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  fail(child, code, message) {
    if (!child || this.child !== child || this.state === "idle" || this.state === "stopping") return;
    this.rejectAll(new BridgeError(code, message));
    this.stop().catch(() => {});
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    if (!this.child) return Promise.resolve();
    const child = this.child;
    const negotiated = this.state === "running";
    this.state = "stopping";
    this.rejectAll(new BridgeError("BRIDGE_STOPPED", "桥接进程已停止"));
    this.parts = [];
    this.partBytes = 0;
    this.stopPromise = new Promise((resolve, reject) => {
      let killTimer;
      let deadline;
      const onClose = () => {
        clearTimeout(killTimer);
        clearTimeout(deadline);
        resolve();
      };
      child.once("close", onClose);
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch (_) { /* wait for close */ }
        deadline = setTimeout(() => {
          child.removeListener("close", onClose);
          reject(new BridgeError("STOP_TIMEOUT", "桥接进程未能退出"));
        }, this.stopTimeoutMs);
      }, this.stopTimeoutMs);
      try {
        // probe does not implement shutdown; EOF closes it gracefully.
        if (negotiated && this.mode === "monitor") {
          child.stdin.end(JSON.stringify({ id: this.nextId++, method: "shutdown", params: {} }) + "\n");
        } else child.stdin.end();
      } catch (_) { /* forced termination after the grace period */ }
    }).finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }
}

module.exports = { PyBambuBridge, BridgeError };
