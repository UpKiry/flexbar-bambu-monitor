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

test("error channels distinguish missing, explicit unknown, clear and raw codes", () => {
  assert.deepEqual(mapReport({}), {});
  assert.deepEqual(mapReport({ print_error: null, mc_print_error_code: 0 }), { printError: null, printErrorCode: 0 });
  assert.deepEqual(mapReport({ print_error: "0", mc_print_error_code: "0x0300" }), { printError: 0, printErrorCode: "0x0300" });
  assert.deepEqual(mapReport({ print_error: false, mc_print_error_code: {} }), {});
  assert.equal(mapErrorCode({ print_error: 0, mc_print_error_code: "45" }), "45");
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
  assert.equal(patch.printError, 0);
  assert.equal(patch.printErrorCode, 0);
  assert.deepEqual(patch.hms, []);
  assert.equal(patch.bedCurrent, 25);
});

test("AMS maps only reported fields and keeps raw status and zero", () => {
  assert.deepEqual(mapReport({ ams: { tray_now: "0", ams: [{ id: "0", tray: [
    { id: "1", tray_color: "FF00AAFF", tray_type: "PLA", remain: 0, state: 0 },
    { id: "2", remain: -1, tray_color: "invalid", tray_type: "" },
  ] }] }, ams_status: 0 }), {
    ams: { rawTrayNow: "0", current: { unitId: "0", slotId: "0" }, units: [{ id: "0", slots: [
      { id: "1", color: "FF00AAFF", material: "PLA", remaining: 0, rawState: 0 },
      { id: "2", remaining: null, material: null },
    ] }] }, amsStatus: 0,
  });
  assert.deepEqual(mapReport({ ams: { tray_now: "254" } }).ams, { rawTrayNow: "254", current: null });
  assert.deepEqual(mapReport({ ams: { tray_now: 255 } }).ams, { rawTrayNow: 255, current: null });
  assert.deepEqual(mapReport({ ams: { tray_now: 128 } }).ams.current, { unitId: "128", slotId: "0" });
  assert.deepEqual(mapReport({ ams: { tray_now: 5 } }).ams.current, { unitId: "1", slotId: "1" });
  assert.deepEqual(mapReport({ ams: { ams: [{ id: "bad" }] } }), {});
});

test("AMS null lists remain distinct from missing and empty arrays", () => {
  assert.deepEqual(mapReport({ ams: { ams: null, tray_now: "1" } }).ams, {
    units: null, rawTrayNow: "1", current: { unitId: "0", slotId: "1" },
  });
  assert.deepEqual(mapReport({ ams: { ams: [] } }).ams, { units: [] });
  assert.deepEqual(mapReport({ ams: { ams: [{ id: "0", tray: null }] } }).ams, { units: [{ id: "0", slots: null }] });
  assert.deepEqual(mapReport({ ams: { ams: [{ id: "0", tray: [] }, { id: "1" }] } }).ams, { units: [{ id: "0", slots: [] }, { id: "1" }] });
});

test("reported AMS ids survive without inferred slot properties", () => {
  assert.deepEqual(mapReport({ ams: { ams: [{ id: "0", tray: [{ id: "1" }] }, { id: "2" }] } }), {
    ams: { units: [{ id: "0", slots: [{ id: "1" }] }, { id: "2" }] },
  });
});

test("heatbreak legacy steps follow BambuHelper ordinary mode without ten-percent quantization", () => {
  for (const [value, percent] of [[0, 0], ["0", 0], [" 8 ", 53], [10, 66], ["15", 100]]) {
    assert.deepEqual(mapReport({ heatbreak_fan_speed: value }), {
      fans: { heatbreak: percent }, rawFans: { heatbreak: value },
    });
  }
});

// 手工编写的脱敏协议标量；没有复制任何账号或设备完整报文。
test("legacy fan steps map independently to rounded percentages and retain raw values", () => {
  const patch = mapReport({ cooling_fan_speed: "15", big_fan1_speed: 6, big_fan2_speed: "0", heatbreak_fan_speed: "7" });
  assert.deepEqual(patch.fans, { part: 100, auxiliary: 40, chamber: 0, heatbreak: 46 });
  assert.deepEqual(patch.rawFans, { part: "15", auxiliary: 6, chamber: "0", heatbreak: "7" });
  for (let step = 0; step <= 15; step++) {
    assert.equal(mapReport({ cooling_fan_speed: String(step) }).fans.part, Math.round(step * 100 / 15));
  }
  assert.deepEqual(mapReport({ big_fan1_speed: " 3 " }).fans, { auxiliary: 20 });
  assert.deepEqual(emptyPrinterState().fans, { part: null, auxiliary: null, chamber: null, heatbreak: null });
});

test("unknown fan encodings stay raw without fabricating percentages", () => {
  for (const source of ["cooling_fan_speed", "big_fan1_speed", "big_fan2_speed", "heatbreak_fan_speed"]) {
    for (const value of [-1, 16, 100, 255, 1.5, "0x0f", "1e1", "", "future"]) {
      const patch = mapReport({ [source]: value });
      assert.equal(patch.fans, undefined);
      assert.equal(Object.values(patch.rawFans)[0], value);
    }
    for (const value of [true, false, {}, [], Infinity, NaN, undefined]) {
      assert.deepEqual(mapReport({ [source]: value }), {});
    }
  }
  assert.deepEqual(mapReport({ fan_gear: 0x00ff00, device: { airduct: { parts: [{ id: 160, state: 60 }] } } }), {});
});

test("fan nulls clear only explicitly reported channels", () => {
  assert.deepEqual(mapReport({ cooling_fan_speed: null, heatbreak_fan_speed: null }), {
    fans: { part: null, heatbreak: null }, rawFans: { part: null, heatbreak: null },
  });
  assert.deepEqual(mapReport({ nozzle_temper: 0 }), { nozzleCurrent: 0 });
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


test("chamber temperature uses only the printer field and validates values", () => {
  assert.equal(emptyPrinterState().chamber.current, null);
  for (const value of [0, -2, 32.5, "35.5", null]) {
    assert.deepEqual(mapReport({chamber_temper: value}), {chamberCurrent: value === null ? null : Number(value)});
  }
  for (const value of ["", "bad", true, {}, [], undefined, Infinity]) {
    assert.deepEqual(mapReport({chamber_temper: value}), {});
  }
  assert.equal(mapReport({ams: {ams: [{id: "0", temp: "40"}]}}).chamberCurrent, undefined);
});

test("AMS info retains only bounded hexadecimal text or explicit null", () => {
  for (const value of ["1", "00102", "0xAf04", " 0000 ", "f".repeat(128), null]) {
    assert.deepEqual(mapReport({ ams: { ams: [{ id: "0", info: value }] } }).ams.units,
      [{ id: "0", rawInfo: value === null ? null : value.trim() }]);
  }
  for (const value of [undefined, "", " ", "future", "f".repeat(129), 1, true, {}, [], Infinity]) {
    assert.deepEqual(mapReport({ ams: { ams: [{ id: "0", info: value }] } }).ams.units, [{ id: "0" }]);
  }
});


test("new printer temperatures decode independently and select extruder by ID", () => {
  const patch = mapReport({nozzle_temper: 0, nozzle_target_temper: 0, bed_temper: 20,
    device: {bed_temp: 60 * 65536 + 42, ctc: {info: {temp: 65 * 65536 + 35}},
      extruder: {state: 0x12, info: [{id: 0, temp: 200 * 65536 + 180}, {id: 1, temp: 240 * 65536 + 220}]}}});
  assert.equal(patch.bedCurrent, 42);
  assert.equal(patch.bedTarget, 60);
  assert.equal(patch.chamberCurrent, 35);
  assert.equal(patch.nozzleCurrent, 220);
  assert.equal(patch.nozzleTarget, 240);
  assert.deepEqual(mapReport({device: {bed: {info: {temp: 0}}}}), {bedCurrent: 0, bedTarget: 0});
  assert.deepEqual(mapReport({device: {extruder: {state: 1, info: [{id: 0, temp: 0}]}}}), {nozzleCurrent: 0, nozzleTarget: 0});
});

test("new temperatures reject invalid packed values and ambiguous active nozzles", () => {
  for (const temp of [-1, 0xffffffff, 0x100000000, 1.5, "123", true, {}, NaN, Infinity]) {
    assert.deepEqual(mapReport({device: {bed_temp: temp, ctc: {info: {temp}},
      extruder: {state: 1, info: [{id: 0, temp}]}}}), {});
    assert.equal(mapReport({bed_temper: 21, device: {bed_temp: temp}}).bedCurrent, 21);
  }
  assert.deepEqual(mapReport({device: {bed_temp: null}}), {bedCurrent: null, bedTarget: null});
  for (const extruder of [
    {info: [{id: 0, temp: 200}]},
    {state: 0x12, info: [{id: 0, temp: 200}]},
    {state: 1, info: [{id: 0, temp: 200}, {id: 0, temp: 210}]},
  ]) assert.deepEqual(mapReport({device: {extruder}}), {});
  assert.deepEqual(mapReport({nozzle_temper: 0, nozzle_target_temper: 0,
    device: {extruder: {state: 0x12, info: []}}}), {});
});
