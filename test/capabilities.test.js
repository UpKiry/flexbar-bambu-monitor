const test = require("node:test");
const assert = require("node:assert/strict");
const { getPrinterCapabilities } = require("../src/printer/capabilities");
const { emptyPrinterState } = require("../src/printer/state-mapper");
const { reduceReport, resetForPrinter } = require("../src/printer/state-reducer");

const hiddenSensors = {
  nozzle: false, bed: false, chamber: false, fanPart: false,
  fanAuxiliary: false, fanChamber: false, fanHeatbreak: false,
};

function withReadings(value) {
  return {
    nozzle: { current: value }, bed: { current: value }, chamber: { current: value },
    fans: { part: value, auxiliary: value, chamber: value, heatbreak: value },
  };
}

test("normalizes only explicit known model names without guessing cloud aliases", () => {
  for (const [input, model] of [
    ["Bambu Lab A1", "A1"], [" bambu lab A1 mini ", "A1 mini"], ["A1mini", "A1 mini"],
    ["Bambu Lab P1P", "P1P"], ["p1s", "P1S"], ["X1 Carbon", "X1C"],
    ["Bambu Lab X1C", "X1C"], ["x1e", "X1E"],
    ["N1", "A1 mini"], ["N2S", "A1"], ["C11", "P1P"], ["C12", "P1S"],
    ["BL-P001", "X1C"], ["3DPrinter-X1-Carbon", "X1C"], ["C13", "X1E"],
  ]) {
    const caps = getPrinterCapabilities(input, null);
    assert.equal(caps.model, model);
    assert.equal(caps.sensors.nozzle, true);
    assert.equal(caps.sensors.bed, true);
    assert.equal(caps.sensors.fanPart, true);
  }
  for (const name of ["C99", "N2S Plus", "X1 future", "H2D future", "A1 future", "P1S Plus"]) {
    const caps = getPrinterCapabilities(name, null);
    assert.equal(caps.model, name);
    assert.deepEqual(caps.sensors, hiddenSensors);
  }
  for (const value of [undefined, null, "", "  ", 0, {}]) {
    assert.deepEqual(getPrinterCapabilities(value, null), { model: null, sensors: hiddenSensors, ams: {} });
  }
});

test("unknown models degrade to actual readings, including zero", () => {
  assert.deepEqual(getPrinterCapabilities("Future", withReadings(0)).sensors, {
    ...hiddenSensors, nozzle: true, bed: true, chamber: true,
    fanPart: true, fanAuxiliary: true, fanChamber: true, fanHeatbreak: true,
  });
  for (const value of [undefined, null, NaN, Infinity, -Infinity, "0", "", false, {}]) {
    assert.deepEqual(getPrinterCapabilities("Future", withReadings(value)).sensors, hiddenSensors);
  }
  const targetOnly = { nozzle: { target: 200 }, bed: { target: 60 }, rawFans: { part: 15 } };
  assert.deepEqual(getPrinterCapabilities("Future", targetOnly).sensors, hiddenSensors);
});

test("A1 series hardware vetoes even valid placeholder zeros and nonzero readings", () => {
  for (const model of ["A1", "A1 mini", "Bambu Lab A1mini"]) {
    for (const value of [0, 30]) {
      const caps = getPrinterCapabilities(model, withReadings(value));
      assert.deepEqual(caps.sensors, {
        ...hiddenSensors, nozzle: true, bed: true, fanPart: true, fanHeatbreak: true,
      });
    }
  }
});

test("P1S has no chamber sensor; P1P retrofit fans require actual data", () => {
  for (const model of ["P1P", "P1S", "X1C", "X1E"]) {
    const empty = getPrinterCapabilities(model, emptyPrinterState());
    assert.deepEqual(empty.sensors, { ...hiddenSensors, nozzle: true, bed: true, fanPart: true });
    const caps = getPrinterCapabilities(model, withReadings(0));
    assert.equal(caps.sensors.chamber, model === "X1C" || model === "X1E");
    assert.equal(caps.sensors.fanAuxiliary, true);
    assert.equal(caps.sensors.fanChamber, true);
    assert.equal(caps.sensors.fanHeatbreak, true);
  }
  for (const value of [-1, 101, NaN, null]) {
    const caps = getPrinterCapabilities("P1P", withReadings(value));
    assert.equal(caps.sensors.fanAuxiliary, false);
    assert.equal(caps.sensors.fanChamber, false);
    assert.equal(caps.sensors.fanHeatbreak, false);
  }
});

test("AMS lite is inferred only for real A1 units and always hides remaining", () => {
  assert.deepEqual(getPrinterCapabilities("A1", {}).ams, {});
  assert.deepEqual(getPrinterCapabilities("A1 mini", { ams: { units: null } }).ams, {});
  for (const model of ["A1", "A1 mini"]) {
    assert.deepEqual(getPrinterCapabilities(model, { ams: { units: [
      { id: "0", slots: [{ remaining: 0 }] },
    ] } }).ams, { 0: { type: "ams-lite", label: "AMS lite", remaining: false } });
  }
  assert.deepEqual(getPrinterCapabilities("P1S", { ams: { units: [{ id: "0" }] } }).ams,
    { 0: { type: "unknown", label: "AMS（类型未知）", remaining: false } });
});

test("multiple AMS units use explicit product metadata and independent valid remaining", () => {
  const caps = getPrinterCapabilities("X1C", { ams: { units: [
    { id: "0", model: "AMS", slots: [{ remaining: 0 }] },
    { id: "1", rawType: "AMS 2 Pro", slots: [{ remaining: 100 }] },
    { id: "2", type: "Bambu Lab AMS HT", slots: [{ remaining: null }] },
    { id: "3", model: "AMS lite", slots: [{ remaining: 55 }] },
    { id: "4", rawType: 1, slots: [{ remaining: 20 }] },
    { id: "5", rawType: "2", slots: [{ remaining: -1 }] },
    { id: "6", model: "AMS", rawType: "AMS HT", slots: [] },
  ] } });
  assert.deepEqual(caps.ams, {
    0: { type: "ams", label: "AMS", remaining: true },
    1: { type: "ams-2-pro", label: "AMS 2 Pro", remaining: true },
    2: { type: "ams-ht", label: "AMS HT", remaining: false },
    3: { type: "ams-lite", label: "AMS lite", remaining: false },
    4: { type: "unknown", label: "AMS（类型未知）", remaining: true },
    5: { type: "unknown", label: "AMS（类型未知）", remaining: false },
    6: { type: "unknown", label: "AMS（类型未知）", remaining: false },
  });
});

test("AMS invalid readings and malformed entries never imply remaining support", () => {
  const units = [null, {}, [], { id: "__proto__" }, { id: -1 },
    { id: "0", slots: [{ remaining: null }, { remaining: -1 }, { remaining: 101 },
      { remaining: NaN }, { remaining: Infinity }, { remaining: "0" }, { remaining: false }] },
    { id: 1, slots: null },
  ];
  const ams = getPrinterCapabilities(null, { ams: { units } }).ams;
  assert.deepEqual(ams, {
    0: { type: "unknown", label: "AMS（类型未知）", remaining: false },
    1: { type: "unknown", label: "AMS（类型未知）", remaining: false },
  });
});

test("model switches recompute capabilities without caching or mutating input", () => {
  const state = { ...withReadings(0), ams: { units: [{ id: "0", slots: [{ remaining: 0 }] }] } };
  const original = structuredClone(state);
  const x1 = getPrinterCapabilities("X1C", state);
  const a1 = getPrinterCapabilities("A1", state);
  assert.equal(x1.sensors.chamber, true);
  assert.equal(x1.ams[0].remaining, true);
  assert.equal(a1.sensors.chamber, false);
  assert.equal(a1.ams[0].remaining, false);
  assert.deepEqual(getPrinterCapabilities("X1C", state), x1);
  x1.ams[0].label = "changed";
  assert.equal(getPrinterCapabilities("X1C", state).ams[0].label, "AMS（类型未知）");
  assert.deepEqual(state, original);
  const reset = resetForPrinter("next");
  assert.deepEqual(getPrinterCapabilities("unknown", reset).sensors, hiddenSensors);
  assert.deepEqual(getPrinterCapabilities("A1", reset).ams, {});
});

test("verified AMS info low nibble takes precedence over A1 inference", () => {
  for (const [info, type] of [["1", "ams"], ["0102", "ams-lite"], ["ffff03", "ams-2-pro"],
    ["0x104", "ams-ht"], ["0", "unknown"], ["fffff", "unknown"], [null, "unknown"],
    ["junk", "unknown"], [2, "unknown"]]) {
    const caps = getPrinterCapabilities("A1", { ams: { units: [{ id: "0", rawInfo: info, slots: [{ remaining: 0 }] }] } });
    assert.equal(caps.ams[0].type, type, String(info));
    assert.equal(caps.ams[0].remaining, type !== "ams-lite");
  }
  const { state } = reduceReport(null, { ams: { ams: [
    { id: "0", info: "101", tray: [{ id: "0", remain: 0 }] },
    { id: "1", info: "102", tray: [{ id: "0", remain: 50 }] },
  ] } });
  const caps = getPrinterCapabilities("A1", state);
  assert.equal(caps.ams[0].type, "ams");
  assert.equal(caps.ams[0].remaining, true);
  assert.equal(caps.ams[1].type, "ams-lite");
  assert.equal(caps.ams[1].remaining, false);
});

test("old empty-slot observations do not hide subsequently valid remaining", () => {
  const caps = getPrinterCapabilities("P1S", { ams: { units: [
    { id: "0", slots: [{ exists: false, remaining: 0 }] },
  ] } });
  assert.equal(caps.ams[0].remaining, true);
});

test("new product names and official IDs cover the missing printer families", () => {
  for (const [id, name] of [["BL-P002", "X1"], ["N6", "X2D"], ["N7", "P2S"],
    ["N9", "A2L"], ["N10", "H3C"], ["O1C", "H2C"], ["O1C2", "H2C"],
    ["O1D", "H2D"], ["O1E", "H2D Pro"], ["O1S", "H2S"]]) {
    for (const alias of [id, name, `Bambu Lab ${name}`]) {
      const result = getPrinterCapabilities(alias, withReadings(0));
      assert.equal(result.model, name, alias);
      assert.equal(result.sensors.chamber, name !== "A2L", alias);
      assert.equal(result.sensors.fanAuxiliary, name !== "A2L", alias);
      assert.equal(result.sensors.fanChamber, name !== "A2L", alias);
    }
  }
  for (const [code, type] of [["5", "ams-lite-mixed"], ["6", "zmulti-a"], ["7", "zmulti-b"]]) {
    const result = getPrinterCapabilities("A2L", {ams: {units: [{id: "0", rawInfo: code}]}});
    assert.equal(result.ams[0].type, type);
  }
  // A2L 支持多种 AMS，不能因 A 字头或缺少 info 就猜成 lite。
  assert.equal(getPrinterCapabilities("A2L", {ams: {units: [{id: "0"}]}}).ams[0].type, "unknown");
});

test("N8 incomplete official hardware profile requires actual readings", () => {
  assert.deepEqual(getPrinterCapabilities("N8", emptyPrinterState()).sensors, hiddenSensors);
  assert.equal(getPrinterCapabilities("N8-V2", withReadings(0)).sensors.nozzle, true);
});

test("AMS 3H zone visibility uses independent actual readings including zero", () => {
  const unit = {id: "0", model: "AMS 3H", zones: [
    {id: "0", temperature: 0, humidity: 0, dryingMinutes: 0},
    {id: "1", temperature: null, humidity: 101, dryingMinutes: -1},
    {id: "2", temperature: 45.5, humidity: 32, dryingMinutes: 60},
  ]};
  const result = getPrinterCapabilities("H3C", {ams: {units: [unit]}}).ams[0];
  assert.deepEqual(result.zones[0], {temperature: true, humidity: true, dryingMinutes: true});
  assert.deepEqual(result.zones[1], {temperature: false, humidity: false, dryingMinutes: false});
  assert.deepEqual(result.zones[2], {temperature: true, humidity: true, dryingMinutes: true});
});

test("version identities distinguish mixed AMS generations after telemetry", () => {
  const first = reduceReport(null, {ams: {ams: [
    {id: "32", info: "7", tray: [{id: 8, remain: 12}], zone_info: [{zone_id: 0, temp: 35}]},
    {id: "0", info: "3", tray: [{id: 0, remain: 30}]},
  ]}}, {receivedAt: 100}).state;
  const identified = reduceReport(first, undefined, {receivedAt: 200, amsIdentities: [
    {id: "32", model: "AMS 3H"}, {id: "0", model: "AMS 2 Pro"},
  ]}).state;
  const caps = getPrinterCapabilities("H3C", identified);
  assert.equal(caps.ams[32].type, "ams-3h");
  assert.equal(caps.ams[32].zones[0].temperature, true);
  assert.equal(caps.ams[0].type, "ams-2-pro");
  assert.equal(caps.ams[0].zones, undefined);
  assert.equal(getPrinterCapabilities("H3C", first).ams[32].type, "zmulti-b");
  assert.equal(first.ams.units[0].model, undefined);
});
