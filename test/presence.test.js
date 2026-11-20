const test = require("node:test");
const assert = require("node:assert/strict");
const { createPresence, hasTelemetry } = require("../src/printer/presence");
const { createPrinterManager } = require("../src/printer/printer-manager");

test("only validated domain telemetry is evidence of life", () => {
  for (const raw of [null, {}, { command: "pushall", result: "success" }, { unexpected: 4 },
    { mc_percent: 101 }, { nozzle_temper: "bad" }, { rawFans: 4 }, { heatbreak_fan_speed: 99 },
    { ams: {} }, { ams: { ams: [] } }, { ams: { ams: [{ id: 0, tray: [{ id: 0 }] }] } },
    { gcode_state: null }, { gcode_state: "???" }, { task_id: "123" }, { subtask_name: "old job" },
    { ams: { ams: [{ id: 0, info: "7" }] } },
    { ams: { tray_now: 255 } }, { ams: { tray_now: "NEW_TRAY" } },
    { ams_status: "NEW_STATUS" }, { ams_status: 0 },
    { ams: { ams: [{ id: 0, tray: [{ id: 0, state: "NEW_STATE" }] }] } }]) {
    assert.equal(hasTelemetry(raw), false, JSON.stringify(raw));
  }
  for (const raw of [{ nozzle_temper: 0 }, { mc_percent: 0 }, { gcode_state: "RUNNING" },
    { heatbreak_fan_speed: "0" }, { hms: [] }, { ams: { ams: [{ id: 0, tray: [{ id: 1, remain: 0 }] }] } },
    { ams: { tray_exist_bits: "0" } }, { ams: { tray_now: 0 } },
    { ams: { ams: [{ id: 0, zone_info: [{ zone_id: 0, temp: 0, humidity_raw: 0, dry_time: 0 }] }] } },
    { ams: { ams: [{ id: 0, tray: [{ id: 0, tray_color: "AABBCCFF", tray_type: "PLA" }] }] } }]) {
    assert.equal(hasTelemetry(raw), true, JSON.stringify(raw));
  }
});

test("broker uncertainty, explicit offline, telemetry recovery, and clock rollback", () => {
  let at = 100;
  const tracker = createPresence({ now: () => at });
  tracker.broker(true);
  assert.equal(tracker.value.state, "syncing");
  at += 119999;
  assert.equal(tracker.tick(), false);
  at += 1;
  assert.equal(tracker.tick(), true);
  assert.equal(tracker.value.state, "unresponsive");
  tracker.telemetry();
  assert.equal(tracker.value.state, "online");
  tracker.message(at + 10);
  assert.equal(tracker.value.lastTelemetryAt, at);
  tracker.broker(false);
  assert.equal(tracker.value.state, "unknown");
  tracker.broker(true);
  assert.equal(tracker.value.state, "syncing");
  tracker.event("client.disconnected");
  at += 1000000;
  assert.equal(tracker.tick(), false);
  assert.equal(tracker.value.state, "offline");
  tracker.telemetry();
  assert.equal(tracker.value.state, "online");
  at -= 2000000;
  assert.equal(tracker.tick(), false);
  assert.equal(tracker.value.state, "online");
  // 回拨后重新计时，超时仍会推进，而不是永久停在线上。
  at += 120000;
  tracker.tick();
  assert.equal(tracker.value.state, "unresponsive");
});

test("repeated connected events cannot postpone the telemetry timeout", () => {
  let at = 0;
  const tracker = createPresence({ now: () => at });
  tracker.broker(true);
  for (at = 4000; at < 120000; at += 4000) tracker.event("client.connected");
  assert.equal(tracker.value.waitingSince, 0);
  assert.equal(tracker.tick(), true);
  assert.equal(tracker.value.state, "unresponsive");
});

test("two recovery requests per episode survive reconnect, coordinate manual queries and reset on telemetry", () => {
  let at = 0;
  const tracker = createPresence({ now: () => at });
  tracker.broker(true);
  at = 120000;
  assert.equal(tracker.tick(), true);
  tracker.requested(at, true);
  assert.equal(tracker.value.autoAttempts, 1);
  assert.equal(tracker.value.nextAutoRequestAt, 420000);
  tracker.broker(false);
  at = 130000;
  tracker.broker(true);
  at = 419999;
  assert.equal(tracker.tick(), false);
  at = 420000;
  assert.equal(tracker.tick(), true);
  tracker.requested(at, true);
  assert.equal(tracker.value.nextAutoRequestAt, null);
  tracker.broker(false);
  tracker.broker(true);
  at += 1000000;
  assert.equal(tracker.tick(), false);
  tracker.telemetry();
  assert.equal(tracker.value.autoAttempts, 0);
  at += 1000;
  tracker.requested(at);
  assert.equal(tracker.value.nextAutoRequestAt, at + 300000);
});


test("resume replenishes the recovery budget after a blind window", () => {
  let at = 0;
  const tracker = createPresence({ now: () => at });
  tracker.broker(true);
  at = 120000;
  assert.equal(tracker.tick(), true);
  tracker.requested(at, true);
  at = 420000;
  assert.equal(tracker.tick(), true);
  tracker.requested(at, true);
  assert.equal(tracker.value.autoAttempts, 2);
  assert.equal(tracker.value.nextAutoRequestAt, null);
  at += 3_600_000;
  tracker.resume();
  assert.equal(tracker.value.autoAttempts, 0);
  assert.notEqual(tracker.value.nextAutoRequestAt, null);
  assert.equal(tracker.tick(), false, "唤醒后先走同步，不立即重复恢复请求");
  at += 120_000;
  assert.equal(tracker.tick(), true, "恢复预算重置后失活恢复继续");
});

test("AMS raw reports cannot revive a printer or replenish exhausted recovery attempts", () => {
  let time = 1000;
  const handlers = {};
  let requests = 0;
  const manager = createPrinterManager({
    now: () => time,
    resumeGapMs: Infinity,
    createMqttClient: () => ({
      onStatus(handler) { handlers.status = handler; },
      onPresence(handler) { handlers.presence = handler; },
      onReport(handler) { handlers.report = handler; },
      start() {}, stop() {},
      requestFullState() { requests += 1; return { sent: true }; },
    }),
  });
  manager.selectPrinter("synthetic-device");
  manager.connect({ host: "synthetic.invalid", port: 8883, userId: "test", accessToken: "synthetic-token" });
  handlers.status({ state: "connected", subscribed: true });
  handlers.report({ raw: { gcode_state: "IDLE", nozzle_temper: 0, bed_temper: 0 }, receivedAt: time });
  time += 120000;
  manager.tick();
  time += 300000;
  manager.tick();
  assert.equal(requests, 2);
  assert.equal(manager.presence.autoAttempts, 2);
  const telemetryAt = manager.presence.lastTelemetryAt;
  for (const raw of [
    { ams: { tray_now: 255 } },
    { ams_status: "NEW_STATUS" },
    { ams: { ams: [{ id: 0, tray: [{ id: 0, state: "NEW_STATE" }] }] } },
  ]) {
    time += 300000;
    handlers.report({ raw, receivedAt: time });
    manager.tick();
    assert.equal(manager.presence.lastMessageAt, time);
    assert.equal(manager.presence.lastTelemetryAt, telemetryAt);
    assert.equal(manager.presence.state, "unresponsive");
    assert.equal(manager.presence.nextAutoRequestAt, null);
    handlers.presence({ type: "event", event: "client.disconnected", receivedAt: time });
    handlers.report({ raw, receivedAt: ++time });
    manager.tick();
    assert.equal(manager.presence.state, "offline", "raw reports cannot clear explicit offline evidence");
    assert.equal(manager.presence.lastTelemetryAt, telemetryAt);
    handlers.presence({ type: "event", event: "client.connected", receivedAt: time });
    time += 120000;
    manager.tick();
    assert.equal(manager.presence.nextAutoRequestAt, null, "重连同步不补充失活恢复预算");
  }
  assert.equal(requests, 5, "raw 报文不产生请求；每轮的请求只来自设备重连的盲窗同步");
  handlers.report({ raw: { ams: { ams: [{ id: 0, tray: [{ id: 0, remain: 0 }] }] } }, receivedAt: ++time });
  assert.equal(manager.presence.state, "online", "interpreted zero remaining is still valid telemetry");
  assert.equal(manager.presence.lastTelemetryAt, time);
  assert.equal(manager.presence.autoAttempts, 0);
});
