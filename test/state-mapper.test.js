const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mapActivity,
  mapProgress,
  mapRemainingMinutes,
  mapTaskName,
  mapErrorCode,
  mapReport,
  isFullSnapshot,
  isTaskSwitch,
  emptyPrinterState,
} = require("../src/printer/state-mapper");

test("known gcode states map to a unified activity", () => {
  assert.equal(mapActivity("IDLE").activity, "idle");
  assert.equal(mapActivity("RUNNING").activity, "printing");
  assert.equal(mapActivity("pause").activity, "paused");
  assert.equal(mapActivity("FINISH").activity, "finished");
  assert.equal(mapActivity("FAILED").activity, "failed");
  assert.equal(mapActivity("PREPARE").activity, "preparing");
});

test("unknown states are kept rather than guessed", () => {
  const mapped = mapActivity("SOMETHING_NEW");
  assert.equal(mapped.activity, "unknown");
  assert.equal(mapped.rawActivity, "SOMETHING_NEW");
  assert.equal(mapActivity(null).activity, "unknown");
  assert.equal(mapActivity(undefined).rawActivity, null);
});

test("progress is validated to 0-100 instead of clamped", () => {
  assert.equal(mapProgress(0), 0);
  assert.equal(mapProgress("42"), 42);
  assert.equal(mapProgress(100), 100);
  assert.equal(mapProgress(101), null);
  assert.equal(mapProgress(-1), null);
  assert.equal(mapProgress("abc"), null);
  assert.equal(mapProgress(null), null);
});

test("remaining minutes reject negatives and garbage", () => {
  assert.equal(mapRemainingMinutes(0), 0);
  assert.equal(mapRemainingMinutes("120"), 120);
  assert.equal(mapRemainingMinutes(-5), null);
  assert.equal(mapRemainingMinutes(""), null);
});

test("task names are trimmed and truncated", () => {
  assert.equal(mapTaskName("  benchy  "), "benchy");
  assert.equal(mapTaskName(""), null);
  assert.equal(mapTaskName(null), null);
  const long = "x".repeat(200);
  const mapped = mapTaskName(long);
  assert.ok(mapped.length <= 60);
  assert.ok(mapped.endsWith("…"));
});

test("error codes keep the raw code and ignore zero", () => {
  assert.equal(mapErrorCode({ print_error: 0, mc_print_error_code: "0" }), null);
  assert.equal(mapErrorCode({ print_error: 1234 }), "1234");
  assert.equal(mapErrorCode({ mc_print_error_code: "0x0300" }), "0x0300");
  assert.equal(mapErrorCode({}), null);
});

test("mapReport only returns fields present in the report", () => {
  const patch = mapReport({ mc_percent: 55, nozzle_temper: 210.4 });
  assert.deepEqual(patch, { progressPercent: 55, nozzleCurrent: 210.4 });
  assert.equal(Object.hasOwn(patch, "bedCurrent"), false);
});

test("mapReport maps the full idle sample", () => {
  const patch = mapReport({
    gcode_state: "IDLE",
    mc_percent: 0,
    mc_remaining_time: 0,
    subtask_name: "",
    nozzle_temper: 25,
    nozzle_target_temper: 25,
    bed_temper: 25,
    bed_target_temper: 25,
    print_error: 0,
    mc_print_error_code: "0",
    hms: [],
    layer_num: 0,
    total_layer_num: 0,
  });
  assert.equal(patch.activity, "idle");
  assert.equal(patch.progressPercent, 0);
  assert.equal(patch.taskName, null);
  assert.equal(patch.errorCode, null);
  assert.deepEqual(patch.hms, []);
  assert.equal(patch.bedCurrent, 25);
});

test("mapReport tolerates junk input", () => {
  assert.deepEqual(mapReport(null), {});
  assert.deepEqual(mapReport([]), {});
  assert.deepEqual(mapReport("x"), {});
});

test("full snapshots are detected by the core print fields", () => {
  assert.equal(isFullSnapshot({ gcode_state: "IDLE", mc_percent: 0, nozzle_temper: 1, bed_temper: 2 }), true);
  assert.equal(isFullSnapshot({ mc_percent: 5 }), false);
});

test("task switches are detected only when a task name is present", () => {
  const previous = { ...emptyPrinterState("D1"), taskName: "benchy" };
  assert.equal(isTaskSwitch(previous, { subtask_name: "other" }), true);
  assert.equal(isTaskSwitch(previous, { subtask_name: "benchy" }), false);
  assert.equal(isTaskSwitch(previous, { mc_percent: 10 }), false);
  assert.equal(isTaskSwitch(null, { subtask_name: "other" }), false);
});
