const test = require("node:test");
const assert = require("node:assert/strict");
const { createRefreshScheduler } = require("../src/printer/refresh-scheduler");
const { reduceReport, reduceConnection, resetForPrinter } = require("../src/printer/state-reducer");

const MINUTE = 60_000;
const ONLINE = { state: "online", autoAttempts: 0 };
const SYNCING = { state: "syncing", autoAttempts: 0 };
const CORE = { gcode_state: "IDLE", nozzle_temper: 0, bed_temper: 0 };

// All reports are synthetic. The injected clock avoids wall-clock timers and sleeps.
function setup({ complete = true, random = () => 0 } = {}) {
  let time = 1_000;
  let state = resetForPrinter("test-printer");
  const scheduler = createRefreshScheduler({ now: () => time, random });
  function report(raw) {
    state = reduceReport(state, raw, { receivedAt: time }).state;
    scheduler.observe(state);
  }
  if (complete) report(CORE);
  return {
    scheduler,
    get state() { return state; },
    advance(ms) { time += ms; },
    report,
    stale() {
      state = reduceConnection(state, "disconnected");
      scheduler.observe(state);
    },
    due(presence = ONLINE, recoveryDue = false) {
      return scheduler.due(state, presence, recoveryDue);
    },
    requested(automatic = true) { scheduler.requested(state, automatic); },
  };
}

function exhaustFieldBatch(clock) {
  clock.report({ mc_percent: 20 });
  clock.stale();
  clock.report(CORE);
  clock.scheduler.broker(true);
  clock.advance(5_000);
  assert.equal(clock.due(), "sync");
  clock.requested();
  clock.advance(5 * MINUTE);
  assert.equal(clock.due(), "fields");
  clock.requested();
}

test("connection waits five seconds before syncing missing core fields", () => {
  const clock = setup({ complete: false });
  clock.scheduler.broker(true);
  assert.equal(clock.due(SYNCING), null);
  clock.advance(4_999);
  assert.equal(clock.due(SYNCING), null);
  clock.advance(1);
  assert.equal(clock.due(SYNCING), "sync");
});

test("natural core reports cancel pending synchronization without requiring optional fields", () => {
  const clock = setup({ complete: false });
  clock.scheduler.broker(true);
  clock.advance(4_000);
  clock.report({ gcode_state: "IDLE", nozzle_temper: 0 });
  clock.advance(999);
  clock.report({ bed_temper: 0 });
  clock.advance(1);
  assert.equal(clock.due(), null);
  clock.advance(30_000);
  assert.equal(clock.due(), null);
});

test("online stale measurements wait thirty seconds before a field refresh", () => {
  const clock = setup();
  clock.scheduler.broker(true);
  clock.advance(5_000);
  assert.equal(clock.due(), null); // Consume the connection synchronization window.
  clock.report({ mc_percent: 20 });
  clock.stale();
  clock.report(CORE);
  clock.advance(29_999);
  assert.equal(clock.due(), null);
  clock.advance(1);
  assert.equal(clock.due(), "fields");
});

test("multiple stale fields, including nested AMS measurements, share one refresh and cooldown", () => {
  const clock = setup();
  clock.scheduler.broker(true);
  clock.advance(5_000);
  assert.equal(clock.due(), null);
  clock.report({ mc_percent: 20, mc_remaining_time: 40 });
  clock.stale();
  clock.report(CORE);
  // A small synthetic fixture exercises nested freshness without real device data.
  clock.state.freshness.ams.units["0"] = {
    slots: { "0": { remaining: { at: 1_000, stale: true } } },
    zones: { "0": { humidity: { at: 1_000, stale: true } } },
  };
  clock.scheduler.observe(clock.state);
  clock.advance(30_000);
  assert.equal(clock.due(), "fields");
  clock.requested();
  assert.equal(clock.due(), null);
  clock.advance(5 * MINUTE - 1);
  assert.equal(clock.due(), null);
  clock.advance(1);
  assert.equal(clock.due(), "fields");
  clock.requested();
  clock.advance(15 * MINUTE);
  assert.equal(clock.due(), "periodic", "预算耗尽后由周期兜底接管，不再永久安静");
});

test("manual and automatic requests both impose the five-minute automatic cooldown", () => {
  for (const automatic of [false, true]) {
    const clock = setup({ complete: false });
    clock.scheduler.broker(true);
    clock.requested(automatic);
    clock.advance(5 * MINUTE - 1);
    assert.equal(clock.due(ONLINE, true), null, `automatic=${automatic}`);
    clock.advance(1);
    assert.equal(clock.due(ONLINE, true), "recovery", `automatic=${automatic}`);
  }
});

test("manual requests defer pending field completion for the full five minutes", () => {
  const clock = setup();
  clock.scheduler.broker(true);
  clock.advance(5_000);
  clock.due();
  clock.report({ mc_percent: 20 });
  clock.stale();
  clock.report(CORE);
  clock.requested(false);
  clock.advance(5 * MINUTE - 1);
  assert.equal(clock.due(), null);
  clock.advance(1);
  assert.equal(clock.due(), "fields");
});

test("the same unresolved field batch has at most two automatic attempts", () => {
  const clock = setup();
  exhaustFieldBatch(clock);
  clock.advance(5 * MINUTE);
  assert.equal(clock.due(), null, "快速档预算耗尽后不再提前补全");
  clock.advance(10 * MINUTE);
  assert.equal(clock.due(), "periodic", "周期兜底继续覆盖未解决批次");
});

test("unrelated temperature reports neither restart the thirty-second delay nor reset attempts", () => {
  const clock = setup();
  clock.scheduler.broker(true);
  clock.advance(5_000);
  clock.due();
  clock.report({ mc_percent: 20 });
  clock.stale();
  clock.report(CORE);
  clock.advance(20_000);
  clock.report({ nozzle_temper: 21 });
  clock.advance(10_000);
  assert.equal(clock.due(), "fields");
  clock.requested();
  clock.advance(5 * MINUTE);
  clock.report({ nozzle_temper: 22 });
  assert.equal(clock.due(), "fields");
  clock.requested();
  clock.advance(5 * MINUTE);
  clock.report({ nozzle_temper: 23 });
  assert.equal(clock.due(), null);
});

test("periodic floor retries an exhausted batch every fifteen minutes", () => {
  const clock = setup();
  exhaustFieldBatch(clock);
  for (let cycle = 0; cycle < 3; cycle++) {
    clock.advance(15 * MINUTE);
    assert.equal(clock.due(), "periodic", `第 ${cycle + 1} 次周期兜底`);
    clock.requested();
    clock.advance(5 * MINUTE);
    assert.equal(clock.due(), null, "兜底之间仍受共享冷却约束");
    clock.advance(10 * MINUTE);
  }
});

test("broker reconnect re-syncs within the shared cooldown even after the batch budget is spent", () => {
  const clock = setup();
  exhaustFieldBatch(clock);
  clock.advance(5 * MINUTE);
  clock.scheduler.broker(false);
  clock.scheduler.broker(true);
  clock.advance(5_000);
  assert.equal(clock.due(), "sync", "重连后的同步不受批次预算门控");
  clock.requested();
  // 重复 online 事件不绕过共享冷却，但会重新武装同步。
  clock.scheduler.onlineEvent();
  clock.advance(5_000);
  assert.equal(clock.due(), null);
  clock.advance(5 * MINUTE - 5_000);
  assert.equal(clock.due(), "sync");
  clock.requested();
});

test("reconnect cannot bypass the shared cooldown while fields still have an attempt", () => {
  const clock = setup({ complete: false });
  clock.scheduler.broker(true);
  clock.advance(5_000);
  assert.equal(clock.due(SYNCING), "sync");
  clock.requested();
  clock.scheduler.broker(false);
  clock.scheduler.broker(true);
  clock.advance(5_000);
  assert.equal(clock.due(SYNCING), null);
  clock.advance(5 * MINUTE - 5_000);
  assert.equal(clock.due(SYNCING), "sync");
});

test("old stale fields wait for a new five-second synchronization grace after offline or disconnect", () => {
  for (const condition of ["offline", "disconnected"]) {
    const clock = setup();
    clock.scheduler.broker(true);
    clock.advance(5_000);
    assert.equal(clock.due(), null);
    clock.report({ mc_percent: 20 });
    clock.stale();
    clock.report(CORE);
    if (condition === "disconnected") clock.scheduler.broker(false);
    clock.advance(31_000);
    const presence = condition === "offline" ? { state: "offline" } : ONLINE;
    assert.equal(clock.due(presence), null, condition);
    if (condition === "disconnected") clock.scheduler.broker(true);
    else clock.scheduler.onlineEvent();
    assert.equal(clock.due(), null, `${condition}: reconnect starts grace`);
    clock.advance(4_999);
    assert.equal(clock.due(), null, `${condition}: grace has not elapsed`);
    clock.advance(1);
    assert.equal(clock.due(), "sync", `${condition}: grace elapsed`);
  }
});

test("online events repeated every four seconds do not postpone the first five-second synchronization", () => {
  const clock = setup({ complete: false });
  clock.scheduler.broker(true);
  clock.scheduler.onlineEvent();
  clock.advance(4_000);
  clock.scheduler.onlineEvent();
  assert.equal(clock.due(SYNCING), null);
  clock.advance(999);
  assert.equal(clock.due(SYNCING), null);
  clock.advance(1);
  assert.equal(clock.due(SYNCING), "sync");
});

test("a corresponding field report clears its exhausted batch so a later stale episode can retry", () => {
  const clock = setup();
  exhaustFieldBatch(clock);
  clock.report({ mc_percent: 21 });
  clock.advance(5 * MINUTE);
  clock.stale();
  clock.report(CORE);
  clock.advance(29_999);
  assert.equal(clock.due(), null);
  clock.advance(1);
  assert.equal(clock.due(), "fields");
});

test("normal periodic refresh runs after fifteen minutes and reschedules from the request", () => {
  const clock = setup();
  clock.scheduler.broker(true);
  clock.advance(15 * MINUTE - 1);
  assert.equal(clock.due(), null);
  clock.advance(1);
  assert.equal(clock.due(), "periodic");
  clock.requested();
  clock.advance(15 * MINUTE - 1);
  assert.equal(clock.due(), null);
  clock.advance(1);
  assert.equal(clock.due(), "periodic");
});

test("periodic refresh includes injected jitter and a manual request restarts its interval", () => {
  const clock = setup({ random: () => 0.5 });
  clock.scheduler.broker(true);
  clock.advance(15 * MINUTE);
  assert.equal(clock.due(), null);
  clock.advance(30_000);
  assert.equal(clock.due(), "periodic");
  clock.requested(false);
  clock.advance(15 * MINUTE + 29_999);
  assert.equal(clock.due(), null);
  clock.advance(1);
  assert.equal(clock.due(), "periodic");
});

test("resume forces an unconditional sync after the grace and clears the shared cooldown", () => {
  const clock = setup();
  clock.scheduler.broker(true);
  clock.advance(5_000);
  clock.requested(false);
  clock.advance(60_000);
  clock.scheduler.resume();
  clock.advance(4_999);
  assert.equal(clock.due(), null, "宽限期内不请求");
  clock.advance(1);
  assert.equal(clock.due(), "sync", "盲窗后即使没有缺失或标旧字段也强制同步");
  clock.requested();
});

test("resume resets the batch attempt budget so exhausted fields retry promptly", () => {
  const clock = setup();
  exhaustFieldBatch(clock);
  clock.scheduler.resume();
  clock.advance(5_000);
  assert.equal(clock.due(), "sync");
  clock.requested();
  clock.advance(5 * MINUTE);
  assert.equal(clock.due(), "fields", "预算重置后字段补全恢复快速重试");
  clock.requested();
});

test("a backward clock step re-arms timers instead of blocking automatic refresh forever", () => {
  const clock = setup({ complete: false });
  clock.scheduler.broker(true);
  clock.advance(5_000);
  clock.requested();
  clock.advance(-5_000);
  assert.equal(clock.due(ONLINE, true), null, "冷却从回拨时刻重新起算");
  clock.advance(5 * MINUTE);
  assert.equal(clock.due(ONLINE, true), "recovery", "冷却结束后自动刷新恢复，而不是永久封锁");
});

test("disconnected, unsubscribed, explicitly offline, and unknown states never request", () => {
  for (const condition of ["disconnected", "unsubscribed", "offline", "unknown"]) {
    const clock = setup({ complete: false });
    // broker(true) represents connected AND subscribed at this module boundary.
    if (condition !== "unsubscribed") clock.scheduler.broker(true);
    if (condition === "disconnected") clock.scheduler.broker(false);
    clock.advance(20 * MINUTE);
    const presence = ["offline", "unknown"].includes(condition) ? { state: condition } : ONLINE;
    assert.equal(clock.due(presence, false), null, condition);
    assert.equal(clock.due(presence, true), null, `${condition}: recovery`);
  }
});

test("unresponsive presence keeps sync and the periodic floor as liveness fallbacks", () => {
  const clock = setup({ complete: false });
  clock.scheduler.broker(true);
  clock.advance(30_000);
  assert.equal(clock.due({ state: "unresponsive" }, true), "recovery", "失活恢复优先于同步");
  assert.equal(clock.due(SYNCING, true), "recovery", "恢复原因在其他等待状态下同样优先");
  assert.equal(clock.due(ONLINE, true), "recovery");
  clock.requested();
  clock.advance(5 * MINUTE);
  clock.scheduler.onlineEvent();
  clock.advance(5_000);
  assert.equal(clock.due({ state: "unresponsive" }), "sync", "失活不挡死同步");
  clock.requested();
  clock.advance(5 * MINUTE);
  assert.equal(clock.due({ state: "unresponsive" }), null, "字段补全仍只在在线时提前触发");
  clock.advance(10 * MINUTE);
  assert.equal(clock.due({ state: "unresponsive" }), "periodic", "失活期间由周期兜底继续重试");
});

test("synchronization is not gated by the exhausted inactivity budget", () => {
  const clock = setup({ complete: false });
  clock.scheduler.broker(true);
  clock.advance(5_000);
  assert.equal(clock.due({ state: "syncing", autoAttempts: 2 }), "sync");
  clock.requested();
  clock.advance(5 * MINUTE);
  clock.scheduler.onlineEvent();
  clock.advance(5_000);
  assert.equal(clock.due({ state: "syncing", autoAttempts: 2 }), "sync");
});
