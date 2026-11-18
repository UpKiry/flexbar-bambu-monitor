const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { PyBambuBridge } = require("../src/pybambu/bridge");

const python = process.env.PYBAMBU_PYTHON;

test("Node 桥接通过 Python 进程使用固定的上游模型解析增量数据", { skip: !python }, async (t) => {
  const bridge = new PyBambuBridge({
    pythonCommand: python,
    scriptPath: path.join(__dirname, "../scripts/pybambu_probe.py"),
    timeoutMs: 10_000,
  }).start();
  t.after(() => bridge.stop());
  const hello = await bridge.request("hello");
  assert.equal(hello.protocol, 1);
  const initial = await bridge.request("update", { print: { mc_percent: 23, bed_temper: 52 } });
  const updated = await bridge.request("update", { print: { mc_percent: 24, layer_num: 7 } });
  assert.equal(initial.state.mc_percent, 23);
  assert.equal(updated.state.mc_percent, 24);
  assert.equal(updated.state.bed_temper, 52);
  assert.equal(updated.state.layer_num, 7);
});

test("真实 Python 子进程经模拟 MQTT 和适配器更新设备状态", { skip: !python }, async (t) => {
  const { createPyBambuMonitorClient } = require("../src/pybambu/monitor-client");
  const { createPrinterManager } = require("../src/printer/printer-manager");
  const manager = createPrinterManager({ createMqttClient: (options) => createPyBambuMonitorClient({
    ...options, pythonCommand: python, scriptPath: path.join(__dirname, "fixtures/pybambu_offline_monitor.py"), pollIntervalMs: 10,
  }) });
  t.after(() => manager.disconnect());
  manager.selectPrinter("DEV1");
  manager.connect({ host: "cn.mqtt.bambulab.com", port: 8883, userId: "42", accessToken: "synthetic-secret" });
  const deadline = Date.now() + 10000;
  while (manager.state.taskName !== "offline task" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(manager.status.state, "connected");
  assert.equal(manager.state.taskName, "offline task");
  assert.equal(manager.state.progressPercent, 0);
  assert.equal(manager.state.ams.units[0].slots[0].material, "PLA");
  assert.equal(manager.requestFullState().reason, "unsupported");
});

test("monitor 真实进程协商能力并优雅关闭，无需连接云端", { skip: !python }, async (t) => {
  const bridge = new PyBambuBridge({
    pythonCommand: python,
    scriptPath: path.join(__dirname, "../scripts/pybambu_monitor.py"),
    mode: "monitor",
    timeoutMs: 10_000,
    stopTimeoutMs: 2_000,
  }).start();
  t.after(() => bridge.stop());
  const hello = await bridge.request("hello");
  assert.equal(hello.protocol, 1);
  assert.ok(hello.capabilities.includes("monitor.passive"));
  assert.ok(hello.capabilities.includes("monitor.snapshot"));
  assert.ok(hello.capabilities.includes("monitor.poll-deltas"));
  const poll = await bridge.request("monitor.poll", { generation: 0, afterSeq: 0 });
  assert.equal(poll.generation, 0);
  assert.equal(poll.resetRequired, false);
  assert.deepEqual(poll.events, []);
  assert.equal(poll.nextSeq, 0);
  assert.equal(poll.hasMore, false);
  assert.equal(poll.currentConnection, "stopped");
  const snapshot = await bridge.request("monitor.snapshot");
  assert.equal(snapshot.connection, "stopped");
  assert.equal(snapshot.lastReportAt, null);
  const child = bridge.child;
  await bridge.stop();
  assert.equal(child.exitCode, 0);
});
