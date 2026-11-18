const test = require("node:test");
const assert = require("node:assert/strict");
const { createPyBambuMonitorClient } = require("../src/pybambu/monitor-client");

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function fixture() {
  const calls = [], scheduled = [], reports = [], statuses = [];
  const start = deferred(), polls = [], close = deferred();
  const fake = {
    start() { calls.push(["spawn"]); },
    request(method, params) {
      calls.push([method, params]);
      if (method === "monitor.start") return start.promise;
      if (method === "monitor.poll") { const p = deferred(); polls.push(p); return p.promise; }
      throw new Error("unexpected");
    },
    stop() { calls.push(["stop"]); return close.promise; },
  };
  const client = createPyBambuMonitorClient({
    pythonCommand: "/trusted/python", scriptPath: "/trusted/monitor.py",
    host: "cn.mqtt.bambulab.com", port: 8883, username: "u_42", password: "secret", deviceId: "DEV1",
    bridgeFactory(options) { calls.push(["factory", options]); return fake; },
    setTimer(fn, ms) { const handle = { fn, ms }; scheduled.push(handle); return handle; },
    clearTimer(handle) { handle.cancelled = true; },
  });
  client.onReport((r) => reports.push(r));
  client.onStatus((s) => statuses.push(s));
  return { client, calls, scheduled, reports, statuses, start, polls, close };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const batch = (events, nextSeq, extra = {}) => ({ generation: 7, deviceId: "DEV1", events, nextSeq, hasMore: false, resetRequired: false, currentConnection: "connected", ...extra });
const ev = (seq, type, data) => ({ seq, type, receivedAtMs: 1000 + seq, data });

test("验证路径并只通过请求传递凭据", async () => {
  assert.throws(() => createPyBambuMonitorClient({ pythonCommand: "python", scriptPath: "/x" }), /绝对路径/);
  const f = fixture();
  assert.equal(f.client.start(), true);
  assert.deepEqual(f.calls[0][1], { pythonCommand: "/trusted/python", scriptPath: "/trusted/monitor.py", mode: "monitor" });
  assert.deepEqual(f.calls[2], ["monitor.start", { region: "China", deviceId: "DEV1", username: "u_42", token: "secret" }]);
  assert.deepEqual(f.client.requestFullState(), { sent: false, reason: "unsupported" });
  f.start.resolve({ generation: 7, deviceId: "DEV1" });
  await tick();
  assert.deepEqual(f.calls[3], ["monitor.poll", { generation: 7, afterSeq: 0 }]);
  const stopped = f.client.stop(); f.close.resolve(); await stopped;
});

test("轮询不并发，事件按序传入 reducer 并使用原始时间", async () => {
  const f = fixture(); f.client.start(); f.start.resolve({ generation: 7, deviceId: "DEV1" }); await tick();
  assert.equal(f.polls.length, 1); assert.equal(f.scheduled.length, 0);
  f.polls[0].resolve(batch([ev(1, "connection", { state: "connected" }), ev(2, "report", { mc_percent: 0 })], 2, { hasMore: true }));
  await tick();
  assert.deepEqual(f.reports, [{ raw: { mc_percent: 0 }, receivedAt: 1002 }]);
  assert.equal(f.client.subscribed, true);
  assert.equal(f.scheduled[0].ms, 0); f.scheduled[0].fn(); await tick();
  assert.equal(f.polls.length, 2);
  assert.deepEqual(f.calls.at(-1)[1], { generation: 7, afterSeq: 2 });
  const stopped = f.client.stop(); f.close.resolve(); await stopped;
});

test("溢出先标旧、恢复订阅，但不回放快照", async () => {
  const f = fixture(); f.client.start(); f.start.resolve({ generation: 7, deviceId: "DEV1" }); await tick();
  f.polls[0].resolve(batch([], 40, { resetRequired: true })); await tick();
  assert.deepEqual(f.statuses.slice(-2).map((s) => s.state), ["reconnecting", "connected"]);
  assert.deepEqual(f.reports, []);
  f.scheduled[0].fn(); await tick();
  assert.equal(f.calls.at(-1)[1].afterSeq, 40);
  const stopped = f.client.stop(); f.close.resolve(); await stopped;
});

test("停止等待实际关闭且丢弃迟到结果", async () => {
  const f = fixture(); f.client.start(); f.start.resolve({ generation: 7, deviceId: "DEV1" }); await tick();
  let settled = false; const stopped = f.client.stop().then(() => { settled = true; });
  f.polls[0].resolve(batch([ev(1, "report", { mc_percent: 10 })], 1)); await tick();
  assert.equal(settled, false); assert.deepEqual(f.reports, []); assert.equal(f.client.start(), false);
  f.close.resolve(); await stopped; assert.equal(settled, true);
});

test("错误序列、错误设备或连接认证失败均不泄露异常", async () => {
  for (const result of [batch([ev(2, "report", { mc_percent: 1 })], 2), batch([], 0, { deviceId: "OTHER" }), batch([ev(1, "connection", { state: "auth_failed" })], 1)]) {
    const f = fixture(); f.client.start(); f.start.resolve({ generation: 7, deviceId: "DEV1" }); await tick();
    f.polls[0].resolve(result); await tick();
    assert.equal(f.client.state, "failed");
    assert.ok(!JSON.stringify(f.statuses).includes("secret"));
    const stopped = f.client.stop(); f.close.resolve(); await stopped;
  }
});

test("与设备管理器合并增量并在溢出后标记字段旧", async () => {
  const { createPrinterManager } = require("../src/printer/printer-manager");
  const f = fixture();
  const manager = createPrinterManager({ createMqttClient: () => f.client });
  manager.selectPrinter("DEV1");
  manager.connect({ host: "cn.mqtt.bambulab.com", port: 8883, userId: "42", accessToken: "secret" });
  f.start.resolve({ generation: 7, deviceId: "DEV1" }); await tick();
  f.polls[0].resolve(batch([ev(1, "connection", { state: "connected" }), ev(2, "report", { gcode_state: "RUNNING", mc_percent: 0 })], 2));
  await tick();
  assert.equal(manager.state.progressPercent, 0);
  assert.equal(manager.state.freshness.fields.progressPercent.at, 1002);
  f.scheduled[0].fn(); await tick();
  f.polls[1].resolve(batch([], 40, { resetRequired: true })); await tick();
  assert.equal(manager.status.state, "connected");
  assert.equal(manager.state.freshness.fields.progressPercent.stale, true);
  const stopped = manager.disconnect(); f.close.resolve(); await stopped;
});

test("无效批次整批拒绝，避免半批状态更新", async () => {
  const f = fixture(); f.client.start(); f.start.resolve({ generation: 7, deviceId: "DEV1" }); await tick();
  f.polls[0].resolve(batch([ev(1, "report", { mc_percent: 20 }), ev(3, "report", { mc_percent: 30 })], 3));
  await tick();
  assert.deepEqual(f.reports, []);
  assert.equal(f.client.state, "failed");
  const stopped = f.client.stop(); f.close.resolve(); await stopped;
});

test("进程关闭失败会阻断后续启动", async () => {
  const f = fixture(); f.client.start();
  const stopped = f.client.stop(); f.close.reject(new Error("secret"));
  await assert.rejects(stopped, /无法确认 Python/);
  assert.equal(f.client.start(), false);
});
