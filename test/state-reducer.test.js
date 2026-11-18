const test = require("node:test");
const assert = require("node:assert/strict");
const {
  reduceReport,
  reduceConnection,
  resetForPrinter,
} = require("../src/printer/state-reducer");

test("incremental reports keep fields that were not included", () => {
  const first = reduceReport(null, {
    gcode_state: "RUNNING",
    mc_percent: 12,
    mc_remaining_time: 40,
    nozzle_temper: 220,
    bed_temper: 60,
    subtask_name: "benchy",
  }, { receivedAt: 1000 }).state;

  const second = reduceReport(first, { mc_percent: 18 }, { receivedAt: 2000 }).state;

  assert.equal(second.activity, "printing");
  assert.equal(second.progressPercent, 18);
  assert.equal(second.remainingMinutes, 40);
  assert.equal(second.taskName, "benchy");
  assert.equal(second.nozzle.current, 220);
  assert.equal(second.bed.current, 60);
  assert.equal(second.lastReportAt, 2000);
});

test("explicit nulls in a report overwrite the previous value", () => {
  const first = reduceReport(null, { mc_percent: 50, nozzle_temper: 200 }).state;
  const second = reduceReport(first, { mc_percent: null }).state;
  // 设计文档要求：显式空值按已验证的字段语义处理，这里视为"变为未知"。
  assert.equal(second.progressPercent, null);
  assert.equal(second.nozzle.current, 200);
});

test("reducer does not mutate the input state", () => {
  const first = reduceReport(null, { mc_percent: 1, nozzle_temper: 10 }).state;
  const before = JSON.stringify(first);
  reduceReport(first, { mc_percent: 2, nozzle_temper: 30 });
  assert.equal(JSON.stringify(first), before);
});

test("task switch clears task-scoped fields only", () => {
  const first = reduceReport(null, {
    gcode_state: "RUNNING",
    mc_percent: 42,
    mc_remaining_time: 30,
    subtask_name: "old-task",
    nozzle_temper: 210,
    bed_temper: 55,
    layer_num: 3,
    total_layer_num: 20,
    print_error: 0,
  }, { receivedAt: 1000 }).state;

  const result = reduceReport(first, { subtask_name: "new-task", mc_percent: 0 }, { receivedAt: 2000 });
  assert.equal(result.taskSwitched, true);
  assert.equal(result.reason, "task-switched");
  assert.equal(result.state.taskName, "new-task");
  assert.equal(result.state.progressPercent, 0);
  // 旧任务的剩余时间、层数和错误码不能带入新任务
  assert.equal(result.state.remainingMinutes, null);
  assert.equal(result.state.layerNum, null);
  assert.equal(result.state.totalLayerNum, null);
  assert.equal(result.state.errorCode, null);
  // 温度是设备级信息，保留
  assert.equal(result.state.nozzle.current, 210);
  assert.equal(result.state.bed.current, 55);
});

test("full snapshots are recognised and reported", () => {
  const first = reduceReport(null, { mc_percent: 10, nozzle_temper: 20, bed_temper: 30, gcode_state: "RUNNING" }).state;
  const result = reduceReport(first, {
    gcode_state: "IDLE",
    mc_percent: 0,
    nozzle_temper: 25,
    bed_temper: 25,
  });
  assert.equal(result.reason, "full-snapshot");
  assert.equal(result.state.activity, "idle");
});

test("invalid reports leave the state untouched", () => {
  const first = reduceReport(null, { mc_percent: 10 }).state;
  for (const bad of [null, [], "x", 42]) {
    const result = reduceReport(first, bad);
    assert.equal(result.reason, "invalid-report");
    assert.equal(result.state.progressPercent, 10);
  }
});

test("connection changes do not drop received data but mark it disconnected", () => {
  const first = reduceReport(null, { gcode_state: "RUNNING", mc_percent: 30 }).state;
  const offline = reduceConnection(first, "disconnected");
  assert.equal(offline.connection, "disconnected");
  assert.equal(offline.progressPercent, 30);
  assert.equal(offline.lastReportAt, first.lastReportAt);
});

test("printer switch resets everything", () => {
  const fresh = resetForPrinter("NEW");
  assert.equal(fresh.printerId, "NEW");
  assert.equal(fresh.lastReportAt, null);
  assert.equal(fresh.activity, "unknown");
  assert.deepEqual(fresh.nozzle, { current: null, target: null });
});

test("error codes from an incremental report are kept", () => {
  const result = reduceReport(null, { gcode_state: "FAILED", print_error: 50348044 }, { receivedAt: 5 });
  assert.equal(result.state.activity, "failed");
  assert.equal(result.state.errorCode, "50348044");
});

test("arrays are not deep merged", () => {
  const first = reduceReport(null, { hms: [{ code: "1", attr: "2", module: "3" }] }).state;
  const second = reduceReport(first, { hms: [] }).state;
  assert.deepEqual(second.hms, []);
});
