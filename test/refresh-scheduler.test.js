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
  assert.equal(clock.due(), null);
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
  assert.equal(clock.due(), null);
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

test("fifteen-minute periodic polling cannot bypass an exhausted field budget", () => {
  const clock = setup();
  exhaustFieldBatch(clock);
  for (let cycle = 0; cycle < 3; cycle++) {
    clock.advance(15 * MINUTE);
    assert.equal(clock.due(), null);
  }
});

test("broker reconnect and repeated online events cannot bypass an exhausted field budget", () => {
  const clock = setup();
  exhaustFieldBatch(clock);
  clock.advance(5 * MINUTE);
  clock.scheduler.broker(false);
  clock.scheduler.broker(true);
  clock.advance(5_000);
  assert.equal(clock.due(), null);
  clock.scheduler.onlineEvent();
  clock.advance(5_000);
  assert.equal(clock.due(), null);
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

test("unresponsive presence only requests recovery, which takes priority over sync and fields", () => {
  const clock = setup({ complete: false });
  clock.scheduler.broker(true);
  clock.advance(30_000);
  assert.equal(clock.due({ state: "unresponsive" }), null);
  assert.equal(clock.due({ state: "unresponsive" }, true), "recovery");
  assert.equal(clock.due(SYNCING, true), "recovery");
  assert.equal(clock.due(ONLINE, true), "recovery");
});

test("syncing presence respects the existing inactivity recovery budget", () => {
  const clock = setup({ complete: false });
  clock.scheduler.broker(true);
  clock.advance(5_000);
  assert.equal(clock.due({ state: "syncing", autoAttempts: 2 }), null);
  clock.advance(30_000);
  assert.equal(clock.due({ state: "syncing", autoAttempts: 2 }), null);
});
