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

test("task identity uses upstream task_id and untruncated names", () => {
  const name = "a".repeat(70);
  const first = reduceReport(null, { task_id: "101", subtask_name: name + "A", mc_percent: 80, layer_num: 9 }).state;
  const renamed = reduceReport(first, { task_id: "101", subtask_name: name + "B" });
  assert.equal(renamed.taskSwitched, false);
  assert.equal(renamed.state.progressPercent, 80);
  const changed = reduceReport(renamed.state, { task_id: "102", subtask_name: name + "B", mc_percent: 0 });
  assert.equal(changed.taskSwitched, true);
  assert.equal(changed.state.progressPercent, 0);
  assert.equal(changed.state.layerNum, null);
  assert.equal(changed.state.taskId, "102");

  const nameOnly = reduceReport(null, { subtask_name: name + "A", mc_percent: 50 }).state;
  const changedName = reduceReport(nameOnly, { subtask_name: name + "B" });
  assert.equal(changedName.taskSwitched, true);
  assert.equal(changedName.state.progressPercent, null);
  assert.equal(changedName.state.taskName, nameOnly.taskName);
});

test("missing and empty task identifiers do not by themselves trigger a switch", () => {
  const first = reduceReport(null, { task_id: "101", subtask_name: "same", mc_percent: 50 }).state;
  const partial = reduceReport(first, { mc_remaining_time: 2 });
  assert.equal(partial.taskSwitched, false);
  assert.equal(partial.state.taskId, "101");
  for (const value of [null, "", "0", 0]) {
    const unknown = reduceReport(first, { task_id: value });
    assert.equal(unknown.taskSwitched, false);
    assert.equal(unknown.state.taskId, null);
    assert.equal(unknown.state.progressPercent, 50);
  }
  const byId = reduceReport(first, { task_id: "102" });
  assert.equal(byId.taskSwitched, true);
  assert.equal(byId.state.taskName, null);
  assert.equal(byId.state.rawTaskName, null);
  assert.equal(byId.state.progressPercent, null);
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

test("reconnecting retains stale status until a valid new report", () => {
  const fresh = resetForPrinter("device");
  assert.equal(fresh.reportStale, true);
  const connected = reduceConnection(fresh, "connected");
  assert.equal(connected.reportStale, true);
  const reported = reduceReport(connected, { gcode_state: "IDLE", mc_percent: 0, nozzle_temper: 20, bed_temper: 20 }).state;
  assert.equal(reported.reportStale, false);
  const offline = reduceConnection(reported, "disconnected");
  const reconnected = reduceConnection(offline, "connected");
  assert.equal(reconnected.progressPercent, 0);
  assert.equal(reconnected.reportStale, true);
  assert.equal(reduceReport(reconnected, null).state.reportStale, true);
  assert.equal(reduceReport(reconnected, { mc_percent: 1 }).state.reportStale, false);
  assert.equal(reduceReport(reconnected, { gcode_state: "IDLE", mc_percent: 1, nozzle_temper: 20, bed_temper: 20 }).state.reportStale, false);
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

test("AMS deltas merge by identity without mutating earlier snapshots", () => {
  const first = reduceReport(null, { ams: { tray_now: "1", ams: [
    { id: "0", tray: [{ id: "0", tray_type: "PLA", remain: 90 }, { id: "1", tray_color: "ABCDEF88", remain: 20 }] },
    { id: "1", tray: [{ id: "0", tray_type: "PETG" }] },
  ] }, ams_status: "999" }).state;
  const before = JSON.stringify(first);
  const second = reduceReport(first, { ams: { ams: [{ id: 0, tray: [{ id: 1, remain: 0 }] }] } }).state;
  assert.equal(JSON.stringify(first), before);
  assert.equal(second.ams.units[0].slots[1].remaining, 0);
  assert.equal(second.ams.units[0].slots[1].color, "ABCDEF88");
  assert.equal(second.ams.units[0].slots[0].material, "PLA");
  assert.equal(second.ams.units[1].slots[0].material, "PETG");
  assert.deepEqual(second.ams.current, { unitId: "0", slotId: "1" });
  assert.equal(second.ams.rawStatus, "999");
  const third = reduceReport(second, { ams: { ams: [{ id: "0", tray: [{ id: "1", remain: null, state: "future" }] }] } }).state;
  assert.equal(third.ams.units[0].slots[1].remaining, null);
  assert.equal(third.ams.units[0].slots[1].rawState, "future");
  assert.equal(reduceConnection(third, "disconnected").ams.units[1].slots[0].material, "PETG");
  assert.equal(resetForPrinter("other").ams, null);
});

test("AMS explicit clearing and invalid partial arrays remain distinct", () => {
  const first = reduceReport(null, { ams: { ams: [{ id: "0", tray: [{ id: "0", remain: 42 }] }] } }).state;
  const invalid = reduceReport(first, { ams: { ams: [{ id: 0, tray: [{ id: "invalid" }] }] } }).state;
  assert.equal(invalid.ams.units[0].slots[0].remaining, 42);
  const slotsCleared = reduceReport(invalid, { ams: { ams: [{ id: 0, tray: [] }] } }).state;
  assert.deepEqual(slotsCleared.ams.units[0].slots, []);
  assert.deepEqual(reduceReport(first, { ams: { ams: [] } }).state.ams.units, []);
  assert.equal(reduceReport(first, { ams: null }).state.ams, null);
  const statusOnly = reduceReport(null, { ams_status: 0 }).state.ams;
  assert.equal(statusOnly.rawStatus, 0);
  assert.deepEqual(statusOnly.units, []);
});

test("AMS null list clears old data but preserves other fields and supports recovery", () => {
  const first = reduceReport(null, { ams: { tray_now: "1", ams: [
    { id: "0", tray: [{ id: "0", tray_type: "PLA", remain: 90 }] },
    { id: "1", tray: [{ id: "0", tray_type: "PETG" }] },
  ] }, ams_status: 7 }, { receivedAt: 100 }).state;
  const missing = reduceReport(first, { ams: { tray_now: "2" } }, { receivedAt: 200 }).state;
  assert.equal(missing.ams.units[0].slots[0].material, "PLA");
  const unknown = reduceReport(missing, { ams: { ams: null, tray_now: "0" }, mc_percent: 0 }, { receivedAt: 300 }).state;
  assert.equal(unknown.ams.units, null);
  assert.equal(unknown.ams.rawStatus, 7);
  assert.equal(unknown.ams.rawTrayNow, "0");
  assert.equal(unknown.progressPercent, 0);
  assert.deepEqual(unknown.freshness.ams.units, {});
  assert.equal(reduceReport(unknown, { ams: { tray_now: "1" } }).state.ams.units, null);
  const recovered = reduceReport(unknown, { ams: { ams: [{ id: "0", tray: [{ id: "1", tray_type: "ABS", remain: 0 }] }] } }, { receivedAt: 400 }).state;
  assert.equal(recovered.ams.units.length, 1);
  assert.equal(recovered.ams.units[0].slots[0].material, "ABS");
  assert.equal(recovered.ams.units[0].slots[0].remaining, 0);
  assert.equal(recovered.ams.units[0].slots.some((slot) => slot.material === "PLA"), false);
  assert.deepEqual(reduceReport(unknown, { ams: { ams: [] } }).state.ams.units, []);
  assert.equal(first.ams.units[0].slots[0].material, "PLA");
});

test("explicit null tray clears just that unit and later partial updates recover", () => {
  const first = reduceReport(null, { ams: { ams: [
    { id: "0", tray: [{ id: "0", tray_type: "PLA" }] },
    { id: "1", tray: [{ id: "0", tray_type: "PETG" }] },
  ] } }, { receivedAt: 100 }).state;
  const missing = reduceReport(first, { ams: { ams: [{ id: "0" }] } }).state;
  assert.equal(missing.ams.units[0].slots[0].material, "PLA");
  const unknown = reduceReport(missing, { ams: { ams: [{ id: "0", tray: null }], tray_now: "4" } }, { receivedAt: 200 }).state;
  assert.equal(unknown.ams.units[0].slots, null);
  assert.equal(unknown.ams.units[1].slots[0].material, "PETG");
  assert.equal(unknown.ams.rawTrayNow, "4");
  assert.equal(unknown.freshness.ams.units["0"], undefined);
  assert.equal(reduceReport(unknown, { ams: { ams: [{ id: "0" }] } }).state.ams.units[0].slots, null);
  assert.deepEqual(reduceReport(unknown, { ams: { ams: [{ id: "0", tray: [] }] } }).state.ams.units[0].slots, []);
  const recovered = reduceReport(unknown, { ams: { ams: [{ id: "0", tray: [{ id: "0", tray_type: "ABS" }] }] } }).state;
  assert.equal(recovered.ams.units[0].slots[0].material, "ABS");
  assert.equal(recovered.ams.units[1].slots[0].material, "PETG");
});

test("unknown lists do not reuse an earlier empty-slot mask on recovery", () => {
  let state = reduceReport(null, { ams: { tray_exist_bits: "0", ams: [{ id: "0", tray: [{ id: "0" }] }] } }, { receivedAt: 100 }).state;
  state = reduceReport(state, { ams: { ams: [{ id: "0", tray: null }] } }, { receivedAt: 200 }).state;
  assert.equal(state.ams.existBits, "0");
  assert.equal(state.freshness.ams.fields.existBits.stale, true);
  state = reduceReport(state, { ams: { ams: [{ id: "0", tray: [{ id: "0", tray_type: "NEW" }] }] } }, { receivedAt: 300 }).state;
  assert.equal(state.ams.units[0].slots[0].exists, null);
  assert.equal(state.ams.units[0].slots[0].material, "NEW");

  state = reduceReport(state, { ams: { tray_exist_bits: "1", ams: null } }, { receivedAt: 400 }).state;
  assert.equal(state.freshness.ams.fields.existBits.stale, false);
  state = reduceReport(state, { ams: { ams: [{ id: "0", tray: [{ id: "0" }] }] } }, { receivedAt: 500 }).state;
  assert.equal(state.ams.units[0].slots[0].exists, true);
});

test("independent error channels survive unrelated clears and task switches", () => {
  let state = reduceReport(null, { print_error: 123, mc_print_error_code: "0x45", task_id: "1" }).state;
  state = reduceReport(state, { print_error: 0 }).state;
  assert.equal(state.printError, 0);
  assert.equal(state.printErrorCode, "0x45");
  assert.equal(state.errorCode, "0x45");
  state = reduceReport(state, { print_error: 222, mc_print_error_code: 0, task_id: "2" }).state;
  assert.equal(state.errorCode, "222");
  state = reduceReport(state, { mc_print_error_code: "88" }).state;
  assert.equal(state.errorCode, "222");
  state = reduceReport(state, { mc_print_error_code: "0" }).state;
  assert.equal(state.errorCode, "222");
  state = reduceReport(state, { print_error: 0 }).state;
  assert.equal(state.errorCode, null);
});

test("AMS reported slot identities appear without fabricated material", () => {
  const state = reduceReport(null, { ams: { tray_exist_bits: "2", ams: [{ id: 0, tray: [{ id: 0 }, { id: 1, tray_type: "PLA" }, { id: 2 }, { id: 3 }] }] } }, { receivedAt: 100 }).state;
  assert.deepEqual(state.ams.units[0].slots.map((slot) => slot.id), ["0", "1", "2", "3"]);
  assert.equal(state.ams.units[0].slots[0].exists, false);
  assert.equal(state.ams.units[0].slots[0].material, null);
  assert.equal(state.ams.units[0].slots[1].material, "PLA");
});

test("AMS hexadecimal presence tracks identity, absence and reappearance", () => {
  let state = reduceReport(null, { ams: { tray_exist_bits: "11", ams: [
    { id: 0, tray: [{ id: 0, tray_type: "PLA", tray_color: "FFFFFFFF", remain: 50 }, { id: 1, tray_type: "PETG" }] },
    { id: 1, tray: [{ id: 0, tray_type: "ABS" }] },
    { id: 128, tray: [{ id: 0, tray_type: "EXT" }] },
  ] } }).state;
  const slot = () => state.ams.units[0].slots[0];
  assert.equal(slot().exists, true);
  assert.equal(state.ams.units[0].slots[1].exists, false);
  assert.equal(state.ams.units[0].slots[1].material, null);
  assert.equal(state.ams.units[1].slots[0].exists, true);
  assert.equal(state.ams.units[2].slots[0].exists, null);
  state = reduceReport(state, { ams: { tray_exist_bits: "10" } }).state;
  assert.equal(slot().exists, false);
  assert.equal(slot().material, null);
  assert.equal(slot().color, null);
  assert.equal(slot().remaining, null);
  state = reduceReport(state, { ams: { ams: [{ id: 0, tray: [{ id: 0, tray_type: "OLD" }] }] } }).state;
  assert.equal(slot().material, null);
  state = reduceReport(state, { ams: { tray_exist_bits: "11" } }).state;
  assert.equal(slot().exists, true);
  assert.equal(slot().material, null);
  state = reduceReport(state, { ams: { tray_exist_bits: "10" } }).state;
  state = reduceReport(state, { ams: { tray_exist_bits: "11", ams: [{ id: 0, tray: [{ id: 0, tray_type: "NEW", remain: 0 }] }] } }).state;
  assert.equal(slot().material, "NEW");
  assert.equal(slot().remaining, 0);
  const before = JSON.stringify(state);
  state = reduceReport(state, { ams: { tray_exist_bits: "not-hex" } }).state;
  assert.equal(JSON.stringify(state), before);
});

test("unknown, empty and invalid reports do not refresh stale data", () => {
  const state = reduceConnection(reduceReport(null, { gcode_state: "RUNNING", mc_percent: 1, nozzle_temper: 20, bed_temper: 20 }, { receivedAt: 100 }).state, "disconnected");
  for (const raw of [{}, { command: "push_status" }, { ams: {} }, { ams: { tray_exist_bits: "wrong" } }, { mc_percent: "bad" }]) {
    const result = reduceReport(state, raw, { receivedAt: 200 });
    assert.equal(result.state.lastReportAt, 100);
    assert.equal(result.state.reportStale, true);
  }
  const partial = reduceReport(state, { ams: { tray_exist_bits: "0" } }, { receivedAt: 201 }).state;
  assert.equal(partial.lastReportAt, 201);
  assert.equal(partial.reportStale, false);
  const malformedCore = reduceReport(partial, { gcode_state: "RUNNING", mc_percent: "bad", nozzle_temper: 20, bed_temper: 20 }).state;
  assert.equal(malformedCore.reportStale, false);
  assert.equal(malformedCore.freshness.fields.progressPercent.stale, true);
});

test("freshness is tracked independently across reconnect and partial updates", () => {
  const initial = reduceReport(null, {
    gcode_state: "RUNNING", mc_percent: 20, subtask_name: "job", print_error: 8,
    hms: [], ams: { tray_exist_bits: "1", ams: [{ id: 0, tray: [{ id: 0, tray_type: "PLA", remain: 10, state: "7" }] }] },
  }, { receivedAt: 100 }).state;
  const before = JSON.stringify(initial);
  const offline = reduceConnection(initial, "disconnected");
  assert.equal(JSON.stringify(initial), before);
  const reconnected = reduceConnection(offline, "connected");
  const updated = reduceReport(reconnected, { mc_percent: 0, print_error: 0, ams: { ams: [{ id: 0, tray: [{ id: 0, remain: 0 }] }] } }, { receivedAt: 200 }).state;
  assert.deepEqual(updated.freshness.fields.progressPercent, { at: 200, stale: false });
  assert.deepEqual(updated.freshness.fields.taskName, { at: 100, stale: true });
  assert.deepEqual(updated.freshness.fields.printError, { at: 200, stale: false });
  assert.deepEqual(updated.freshness.fields.hms, { at: 100, stale: true });
  const slot = updated.freshness.ams.units["0"].slots["0"];
  assert.deepEqual(slot.remaining, { at: 200, stale: false });
  assert.deepEqual(slot.material, { at: 100, stale: true });
  assert.deepEqual(slot.exists, { at: 100, stale: true });
  assert.equal(updated.progressPercent, 0);
  assert.equal(updated.taskName, "job");
  const explicitNull = reduceReport(updated, { mc_percent: null }, { receivedAt: 300 }).state;
  assert.equal(explicitNull.progressPercent, null);
  assert.deepEqual(explicitNull.freshness.fields.progressPercent, { at: 300, stale: false });
  assert.equal(explicitNull.freshness.fields.layerNum, undefined);
});

test("slot removal invalidates old state and replacement only refreshes supplied fields", () => {
  let state = reduceReport(null, { ams: { tray_exist_bits: "1", ams: [{ id: 0, tray: [{ id: 0, tray_type: "PLA", state: "old" }] }] } }, { receivedAt: 1 }).state;
  state = reduceReport(state, { ams: { tray_exist_bits: "0" } }, { receivedAt: 2 }).state;
  assert.equal(state.ams.units[0].slots[0].rawState, null);
  assert.equal(state.freshness.ams.units[0].slots[0].rawState, undefined);
  state = reduceReport(state, { ams: { tray_exist_bits: "1", ams: [{ id: 0, tray: [{ id: 0, state: "new" }] }] } }, { receivedAt: 3 }).state;
  assert.equal(state.ams.units[0].slots[0].rawState, "new");
  assert.deepEqual(state.freshness.ams.units[0].slots[0].rawState, { at: 3, stale: false });
  assert.equal(state.freshness.ams.units[0].slots[0].material, undefined);
});

test("stale absence does not discard new slot metadata after reconnect", () => {
  let state = reduceReport(null, { ams: { tray_exist_bits: "0", ams: [{ id: 0, tray: [{ id: 0, state: "x" }] }] } }, { receivedAt: 1 }).state;
  state = reduceConnection(state, "disconnected");
  state = reduceConnection(state, "connected");
  state = reduceReport(state, { ams: { ams: [{ id: 0, tray: [{ id: 0, tray_type: "PETG" }] }] } }, { receivedAt: 2 }).state;
  assert.equal(state.ams.units[0].slots[0].material, "PETG");
  assert.deepEqual(state.freshness.ams.units["0"].slots["0"].exists, { at: 1, stale: true });
  assert.deepEqual(state.freshness.ams.units["0"].slots["0"].material, { at: 2, stale: false });
});

test("expired AMS absence does not suppress new slot metadata", () => {
  const initial = reduceReport(null, { ams: { tray_exist_bits: "0", ams: [{ id: 0, tray: [{ id: 0, state: "x" }] }] } }, { receivedAt: 1000 }).state;
  const update = { ams: { ams: [{ id: 0, tray: [{ id: 0, tray_type: "PETG", remain: 0 }, { id: 1, tray_type: "PLA" }] }] } };
  const stillFresh = reduceReport(initial, update, { receivedAt: 300999 }).state;
  assert.equal(stillFresh.ams.units[0].slots[0].material, null);
  assert.equal(stillFresh.ams.units[0].slots[1].exists, false);
  const expired = reduceReport(initial, update, { receivedAt: 301000 }).state;
  const [existing, added] = expired.ams.units[0].slots;
  assert.equal(existing.exists, false); // 旧观测仅供标旧显示。
  assert.equal(existing.material, "PETG");
  assert.equal(existing.remaining, 0);
  assert.deepEqual(expired.freshness.ams.units[0].slots[0].exists, { at: 1000, stale: true });
  assert.deepEqual(expired.freshness.ams.units[0].slots[0].material, { at: 301000, stale: false });
  assert.equal(added.exists, null); // 不能根据过期掩码断言存在与否。
  assert.equal(added.material, "PLA");
  assert.equal(expired.freshness.ams.units[0].slots[1].exists, undefined);
  assert.equal(initial.freshness.ams.fields.existBits.stale, false);
});

test("absence masks with missing or future timestamps are not fresh", () => {
  const initial = reduceReport(null, { ams: { tray_exist_bits: "0", ams: [{ id: 0, tray: [{ id: 0, state: "x" }] }] } }, { receivedAt: 1000 }).state;
  const update = { ams: { ams: [{ id: 0, tray: [{ id: 0, tray_type: "PETG" }] }] } };
  const backwards = reduceReport(initial, update, { receivedAt: 999 }).state;
  assert.equal(backwards.ams.units[0].slots[0].material, "PETG");
  assert.equal(backwards.freshness.ams.units[0].slots[0].exists.stale, true);
  delete initial.freshness.ams.fields.existBits.at;
  const missing = reduceReport(initial, update, { receivedAt: 1001 }).state;
  assert.equal(missing.ams.units[0].slots[0].material, "PETG");
  assert.equal(missing.freshness.ams.units[0].slots[0].exists.stale, true);
});

test("a newly reported absence still overrides expired mask and metadata", () => {
  const initial = reduceReport(null, { ams: { tray_exist_bits: "0", ams: [{ id: 0, tray: [{ id: 0, state: "x" }] }] } }, { receivedAt: 1000 }).state;
  const updated = reduceReport(initial, { ams: { tray_exist_bits: "0", ams: [{ id: 0, tray: [{ id: 0, tray_type: "PLA" }] }] } }, { receivedAt: 301000 }).state;
  assert.equal(updated.ams.units[0].slots[0].material, null);
  assert.deepEqual(updated.freshness.ams.units[0].slots[0].exists, { at: 301000, stale: false });
});

test("AMS state and tracking have matching bounded unit and slot counts", () => {
  const units = Array.from({ length: 70 }, (_, id) => ({ id, tray: Array.from({ length: 20 }, (__, slot) => ({ id: slot, remain: 10 })) }));
  const state = reduceReport(null, { ams: { ams: units } }, { receivedAt: 1 }).state;
  assert.equal(state.ams.units.length, 64);
  assert.equal(Object.keys(state.freshness.ams.units).length, 64);
  assert.equal(state.ams.units[0].slots.length, 16);
  assert.equal(Object.keys(state.freshness.ams.units["0"].slots).length, 16);
});

test("arrays are not deep merged", () => {
  const first = reduceReport(null, { hms: [{ code: "1", attr: "2", module: "3" }] }).state;
  const second = reduceReport(first, { hms: [] }).state;
  assert.deepEqual(second.hms, []);
});
