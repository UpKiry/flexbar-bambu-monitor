const test = require("node:test");
const assert = require("node:assert/strict");
const { createPrinterManager } = require("../src/printer/printer-manager");
const { CONNECTION_STATES } = require("../src/cloud/cloud-mqtt");

/** 假云客户端：直接暴露 onStatus / onReport 的触发入口。 */
function makeFakeMqttFactory() {
  const created = [];
  const factory = (options) => {
    const statusHandler = { fn: null };
    const reportHandler = { fn: null };
    const instance = {
      options,
      started: false,
      stopped: false,
      onStatus(fn) { statusHandler.fn = fn; },
      onReport(fn) { reportHandler.fn = fn; },
      start() { instance.started = true; },
      stop() { instance.stopped = true; },
      requestFullState: () => ({ sent: true }),
      emitStatus(status) { statusHandler.fn?.(status); },
      emitReport(report) { reportHandler.fn?.(report); },
      captureHandlers() { return { status: statusHandler.fn, report: reportHandler.fn }; },
    };
    created.push(instance);
    return instance;
  };
  return { factory, created };
}

function setup() {
  const { factory, created } = makeFakeMqttFactory();
  const warnings = [];
  const manager = createPrinterManager({
    createMqttClient: factory,
    logger: { warn: (m) => warnings.push(m), info: () => {}, error: () => {} },
    now: () => 5000,
  });
  return { manager, created, warnings };
}

test("selecting a printer without credentials does not connect", () => {
  const { manager, created } = setup();
  manager.selectPrinter("DEV1");
  assert.equal(manager.printerId, "DEV1");
  assert.equal(created.length, 0);
  assert.equal(manager.state.connection, "disconnected");
});

test("connect wires the account credentials into the MQTT client", () => {
  const { manager, created } = setup();
  manager.selectPrinter("DEV1");
  const result = manager.connect({ host: "us.mqtt.bambulab.com", port: 8883, userId: "42", accessToken: "tok" });

  assert.equal(result.started, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].options.host, "us.mqtt.bambulab.com");
  assert.equal(created[0].options.username, "u_42");
  assert.equal(created[0].options.password, "tok");
  assert.equal(created[0].options.deviceId, "DEV1");
  assert.equal(created[0].started, true);
});

test("connect without a selected printer is refused", () => {
  const { manager, created } = setup();
  const result = manager.connect({ host: "h", port: 1, userId: "1", accessToken: "t" });
  assert.equal(result.started, false);
  assert.equal(result.reason, "no-printer");
  assert.equal(created.length, 0);
});

test("MQTT status transitions map to printer connection states", () => {
  const { manager, created } = setup();
  manager.selectPrinter("DEV1");
  manager.connect({ host: "h", port: 1, userId: "1", accessToken: "t" });

  created[0].emitStatus({ state: CONNECTION_STATES.connecting, attempt: 0, lastError: null, subscribed: false });
  assert.equal(manager.state.connection, "connecting");

  created[0].emitStatus({ state: CONNECTION_STATES.connected, attempt: 0, lastError: null, subscribed: true });
  assert.equal(manager.state.connection, "connected");
  assert.equal(manager.connected, true);

  created[0].emitStatus({ state: CONNECTION_STATES.reconnecting, attempt: 2, lastError: null, subscribed: false });
  assert.equal(manager.state.connection, "reconnecting");
  assert.equal(manager.connected, false);

  created[0].emitStatus({ state: CONNECTION_STATES.failed, attempt: 0, lastError: { message: "x" }, subscribed: false });
  assert.equal(manager.state.connection, "error");
});

test("reports are merged into the printer state and listeners notified", () => {
  const { manager, created } = setup();
  const changes = [];
  manager.subscribe((change) => changes.push(change));

  manager.selectPrinter("DEV1");
  manager.connect({ host: "h", port: 1, userId: "1", accessToken: "t" });
  created[0].emitReport({ raw: { gcode_state: "RUNNING", mc_percent: 30 }, receivedAt: 5000 });

  assert.equal(manager.state.activity, "printing");
  assert.equal(manager.state.progressPercent, 30);
  assert.equal(manager.state.lastReportAt, 5000);
  assert.ok(changes.some((change) => change.type === "report" && change.state.progressPercent === 30));
});

test("switching printers resets state and closes the old connection", () => {
  const { manager, created } = setup();
  manager.selectPrinter("DEV1");
  manager.connect({ host: "h", port: 1, userId: "1", accessToken: "t" });
  created[0].emitReport({ raw: { gcode_state: "RUNNING", mc_percent: 30 } });

  manager.selectPrinter("DEV2");
  assert.equal(manager.printerId, "DEV2");
  assert.equal(created[0].stopped, true);
  assert.equal(manager.state.progressPercent, null);
  assert.equal(manager.state.lastReportAt, null);
});

test("reconnecting to the same printer keeps its state", () => {
  const { manager, created } = setup();
  manager.selectPrinter("DEV1");
  manager.connect({ host: "h", port: 1, userId: "1", accessToken: "t" });
  created[0].emitReport({ raw: { gcode_state: "RUNNING", mc_percent: 30 } });

  manager.selectPrinter("DEV1");
  assert.equal(manager.state.progressPercent, 30);
});

test("printer name updates are reported without resetting state", () => {
  const { manager, created } = setup();
  const changes = [];
  manager.selectPrinter("DEV1");
  manager.connect({ host: "h", port: 1, userId: "1", accessToken: "t" });
  created[0].emitReport({ raw: { gcode_state: "IDLE" } });
  manager.subscribe((change) => changes.push(change));

  manager.selectPrinter("DEV1", { name: "X1 Carbon" });
  assert.equal(manager.printerName, "X1 Carbon");
  assert.equal(manager.state.activity, "idle");
  assert.ok(changes.some((change) => change.type === "printer" && change.printerName === "X1 Carbon"));
});

test("disconnect closes the connection and marks the state", () => {
  const { manager, created } = setup();
  manager.selectPrinter("DEV1");
  manager.connect({ host: "h", port: 1, userId: "1", accessToken: "t" });
  manager.disconnect();
  assert.equal(created[0].stopped, true);
  assert.equal(manager.state.connection, "disconnected");
});

test("a throwing listener does not break dispatch", () => {
  const { manager, warnings, created } = setup();
  manager.subscribe(() => {
    throw new Error("bad listener");
  });
  const seen = [];
  manager.subscribe((change) => seen.push(change.type));
  manager.selectPrinter("DEV1");
  manager.connect({ host: "h", port: 1, userId: "1", accessToken: "t" });
  created[0].emitReport({ raw: { gcode_state: "IDLE" } });

  assert.ok(warnings.includes("状态回调失败"));
  assert.ok(warnings.every((line) => !line.includes("bad listener")));
  assert.ok(seen.includes("report"));
});

test("requestFullState is forwarded to the live client only", () => {
  const { manager } = setup();
  assert.equal(manager.requestFullState().sent, false);
  manager.selectPrinter("DEV1");
  manager.connect({ host: "h", port: 1, userId: "1", accessToken: "t" });
  assert.deepEqual(manager.requestFullState(), { sent: true });
});

test("callbacks retained by an old client cannot change a new printer", () => {
  const { manager, created } = setup();
  const changes = [];
  manager.subscribe((change) => changes.push(change));
  manager.selectPrinter("DEV1");
  manager.connect({ host: "h", port: 1, userId: "1", accessToken: "t" });
  const old = created[0].captureHandlers();
  manager.selectPrinter("DEV2");
  manager.connect({ host: "h", port: 1, userId: "1", accessToken: "t" });
  const before = changes.length;
  old.status({ state: CONNECTION_STATES.connected, subscribed: true });
  old.report({ raw: { gcode_state: "RUNNING", mc_percent: 90 }, receivedAt: 10 });
  assert.equal(changes.length, before);
  assert.equal(manager.connected, false);
  assert.equal(manager.state.progressPercent, null);
  assert.equal(manager.printerId, "DEV2");
});

test("device switches and disconnect discard starts waiting for close", async () => {
  const { manager, created } = setup();
  const opts = { host: "h", port: 1, userId: "1", accessToken: "t" };
  manager.selectPrinter("DEV1");
  manager.connect(opts);
  let close;
  created[0].stop = () => new Promise((resolve) => { close = resolve; });
  manager.selectPrinter("DEV2");
  manager.connect(opts);
  manager.selectPrinter("DEV3");
  manager.connect(opts);
  assert.equal(created.length, 1);
  close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 2);
  assert.equal(created[1].options.deviceId, "DEV3");

  let close2;
  created[1].stop = () => new Promise((resolve) => { close2 = resolve; });
  manager.selectPrinter("DEV4");
  manager.connect(opts);
  const stopped = manager.disconnect();
  close2();
  await stopped;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 2);
  assert.equal(manager.state.connection, "disconnected");
});

test("close timeout rejects and still blocks replacement", async () => {
  const { factory, created } = makeFakeMqttFactory();
  const manager = createPrinterManager({ createMqttClient: factory, closeTimeoutMs: 10 });
  const opts = { host: "h", userId: "1", accessToken: "t" };
  manager.selectPrinter("A");
  manager.connect(opts);
  created[0].stop = () => new Promise(() => {});
  manager.selectPrinter("B");
  manager.connect(opts);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(created.length, 1);
  assert.equal(manager.status.state, "failed");
  await assert.rejects(manager.disconnect(), /关闭/);
});

test("unconfirmed close prevents any replacement", async () => {
  const { manager, created } = setup();
  const opts = { host: "h", userId: "1", accessToken: "t" };
  manager.selectPrinter("DEV1");
  manager.connect(opts);
  created[0].stop = () => Promise.reject(new Error("sensitive"));
  manager.selectPrinter("DEV2");
  manager.connect(opts);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 1);
  assert.equal(manager.status.state, "failed");
  assert.equal(manager.status.lastError.message, "无法确认旧连接已关闭");
});
