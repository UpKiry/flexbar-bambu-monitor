const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { mapAmsIdentities, mapReport } = require("../src/printer/state-mapper");
const { reduceReport, reduceConnection, resetForPrinter } = require("../src/printer/state-reducer");
const { createCloudMqttClient } = require("../src/cloud/cloud-mqtt");
const { createPrinterManager } = require("../src/printer/printer-manager");

// Handwritten synthetic protocol samples: no copied account or device responses.
const identity = [{ id: "32", model: "AMS 3H" }];
const print = (unit) => ({ ams: { ams: [{ id: "32", ...unit }] } });

test("3H module identities use only explicit n10a names and validated ids", () => {
  assert.deepEqual(mapAmsIdentities([
    { name: "n10a", id: "32", sn: "SYNTHETIC-SECRET", sw_ver: "test" },
    { name: "n10a/1", id: 2 }, { name: "n10a/3" },
    { name: "n10a" }, { name: "n10a/4", id: null },
    { name: "n10a/5", id: -1 }, { name: "n10a/6", id: false },
    { name: "n10a/7", id: 1.5 }, { name: "n10a/8", id: {} },
    { name: "n10a/9", id: "1e2" }, { name: "n10a/9007199254740992" },
    { name: "n10a/invalid", id: 10 }, { name: "unknown/0", info: "7" },
    null, [], "n10a/0",
  ]), [...identity, { id: "2", model: "AMS 3H" }, { id: "3", model: "AMS 3H" }]);
  assert.deepEqual(mapAmsIdentities({ name: "n10a/0" }), []);
  assert.equal(mapReport({ ams: { ams: [{ id: 0, info: "7" }] } }).ams.units[0].model, undefined);
});

test("zone fields are allowlisted, missing and malformed values do not fabricate readings", () => {
  const patch = mapReport(print({ temp: 90, humidity: 5, zone_info: [
    { zone_id: 0, temp: "29.5", humidity_raw: "0", dry_time: 0, sn: "SYNTHETIC-SECRET", humidity: 5 },
    { zone_id: "1", temp: false, humidity_raw: 101, dry_time: -1 },
    { zone_id: -1, temp: 20 }, null,
  ] }));
  assert.deepEqual(patch.ams.units[0], { id: "32", zones: [
    { id: "0", temperature: 29.5, humidity: 0, dryingMinutes: 0 }, { id: "1" },
  ] });
  for (const zones of ["wrong", {}, [null, { zone_id: -1 }]]) {
    assert.equal(mapReport(print({ zone_info: zones })).ams.units[0].zones, undefined);
  }
});

test("identity before print and later metadata merge per unit without refreshing telemetry", () => {
  const first = reduceReport(null, undefined, { receivedAt: 100, amsIdentities: identity }).state;
  assert.deepEqual(first.ams.units, [{ id: "32", model: "AMS 3H", slots: null }]);
  assert.equal(first.lastReportAt, null);
  assert.equal(first.reportStale, true);
  assert.deepEqual(first.freshness.ams.units[32].model, { at: 100, stale: false });
  const second = reduceReport(first, print({ zone_info: [{ zone_id: 0, temp: 30, humidity_raw: 35, dry_time: 10 }] }), { receivedAt: 200 }).state;
  const third = reduceReport(second, print({ zone_info: [{ zone_id: 0, temp: 31 }, { zone_id: 1, temp: 29 }] }), { receivedAt: 300 }).state;
  assert.equal(third.ams.units[0].model, "AMS 3H");
  assert.deepEqual(third.ams.units[0].zones, [
    { id: "0", temperature: 31, humidity: 35, dryingMinutes: 10 },
    { id: "1", temperature: 29, humidity: null, dryingMinutes: null },
  ]);
  assert.deepEqual(third.freshness.ams.units[32].zones[0], {
    temperature: { at: 300, stale: false }, humidity: { at: 200, stale: false }, dryingMinutes: { at: 200, stale: false },
  });
  const offline = reduceConnection(third, "disconnected");
  const online = reduceReport(offline, print({ zone_info: [{ zone_id: 0, humidity_raw: 0, dry_time: null }] }), { receivedAt: 400 }).state;
  assert.deepEqual(online.freshness.ams.units[32].zones[0].temperature, { at: 300, stale: true });
  assert.deepEqual(online.freshness.ams.units[32].zones[0].humidity, { at: 400, stale: false });
  assert.equal(online.ams.units[0].zones[0].dryingMinutes, null);
  assert.equal(third.freshness.ams.units[32].zones[0].temperature.stale, false);
  assert.equal(first.ams.units[0].zones, undefined);
  assert.equal(resetForPrinter("another").ams, null);
  const cleared = reduceReport(online, print({ zone_info: [] })).state;
  assert.deepEqual(cleared.ams.units[0].zones, []);
  assert.deepEqual(cleared.freshness.ams.units[32].zones, {});
  assert.equal(cleared.ams.units[0].model, "AMS 3H");
});

test("legacy masks cannot overwrite nine-slot layouts, 3H or unconfirmed bus ids", () => {
  for (const id of ["0", "1", "32"]) {
    const raw = { ams: { tray_exist_bits: "0", ams: [{ id, tray: Array.from({ length: 9 }, (_, index) => ({ id: index, tray_type: "PLA", remain: 50 })) }] } };
    const state = reduceReport(null, raw, { receivedAt: 100 }).state;
    assert.equal(state.ams.units[0].slots.length, 9);
    for (const slot of state.ams.units[0].slots) {
      assert.equal(slot.exists, null);
      assert.equal(slot.material, "PLA");
      assert.equal(state.freshness.ams.units[id].slots[slot.id].exists, undefined);
    }
    const next = reduceReport(state, { ams: { tray_exist_bits: "0" } }, { receivedAt: 200 }).state;
    assert.deepEqual(next.ams.units[0].slots, state.ams.units[0].slots);
  }
  const raw = { ams: { tray_exist_bits: "0", ams: [{ id: 0, tray: [{ id: 0, tray_type: "PLA" }] }] } };
  const legacy = reduceReport(null, raw, { receivedAt: 100 }).state;
  assert.equal(legacy.ams.units[0].slots[0].exists, false);
  const identified = reduceReport(legacy, undefined, { receivedAt: 200, amsIdentities: [{ id: "0", model: "AMS 3H" }] }).state;
  assert.equal(identified.ams.units[0].slots[0].exists, null);
  assert.equal(identified.freshness.ams.units[0].slots[0].exists, undefined);
  const update = reduceReport(identified, raw, { receivedAt: 300 }).state;
  assert.equal(update.ams.units[0].slots[0].material, "PLA");
  assert.equal(update.ams.units[0].slots[0].exists, null);
});

test("incoming extended layout protects earlier slot metadata in the same mask report", () => {
  let state = reduceReport(null, { ams: { ams: [{ id: 0, tray: [{ id: 0, tray_type: "PETG" }] }] } }).state;
  state = reduceReport(state, { ams: { tray_exist_bits: "0", ams: [{ id: 0, tray: [{ id: 8, tray_type: "PLA" }] }] } }).state;
  assert.equal(state.ams.units[0].slots[0].material, "PETG");
  assert.equal(state.ams.units[0].slots[0].exists, null);
});

test("real MQTT-manager pipeline accepts info-only and mixed reports without automatic writes", async () => {
  const transports = [];
  const manager = createPrinterManager({ createMqttClient(options) {
    return createCloudMqttClient({ ...options, createClient() {
      const transport = new EventEmitter();
      transport.subscribe = (_topic, _opts, done) => done(null);
      transport.published = [];
      transport.publish = (...args) => transport.published.push(args);
      transport.end = (_force, done) => done();
      transports.push(transport);
      return transport;
    } });
  } });
  manager.selectPrinter("SYNTHETIC-PRINTER-A");
  manager.connect({ host: "mqtt.example.test", userId: "test", accessToken: "synthetic" });
  const transport = transports[0];
  transport.emit("connect");
  const emit = (payload) => transport.emit("message", "device/SYNTHETIC-PRINTER-A/report", Buffer.from(JSON.stringify(payload)));
  emit({ info: { module: [{ name: "n10a", id: 32, sn: "SYNTHETIC-SECRET" }] } });
  assert.equal(manager.state.ams.units[0].model, "AMS 3H");
  emit({ print: { command: "push_status", ...print({ tray: [{ id: 8, tray_type: "PLA" }], zone_info: [{ zone_id: 0, temp: 25 }] }) } });
  assert.equal(manager.state.ams.units[0].slots[0].id, "8");
  emit({ print: { command: "push_status", mc_percent: 50 }, info: { module: [{ name: "n10a/33" }] } });
  assert.equal(manager.state.progressPercent, 50);
  assert.equal(manager.state.ams.units[1].model, "AMS 3H");
  emit({ info: { module: [] } });
  assert.equal(manager.state.ams.units[0].model, "AMS 3H");
  assert.ok(!JSON.stringify(manager.state).includes("SYNTHETIC-SECRET"));
  assert.deepEqual(transport.published, []);
  manager.selectPrinter("SYNTHETIC-PRINTER-B");
  assert.equal(manager.state.ams, null);
  emit({ info: { module: [{ name: "n10a/32" }] } });
  assert.equal(manager.state.ams, null);
  await manager.disconnect();
});

test("mixed AMS identity modules stay attached to their own unit", () => {
  const identities = mapAmsIdentities([
    { name: "ams/0" }, { name: "ams_f1/1" }, { name: "n3f/2" },
    { name: "n3s/128" }, { name: "n10a/32", sn: "SYNTHETIC-SECRET" },
  ]);
  assert.deepEqual(identities, [
    { id: "0", model: "AMS" }, { id: "1", model: "AMS Lite" },
    { id: "2", model: "AMS 2 Pro" }, { id: "128", model: "AMS HT" },
    { id: "32", model: "AMS 3H" },
  ]);
  const state = reduceReport(null, undefined, { amsIdentities: identities }).state;
  assert.deepEqual(state.ams.units.map(({ id, model }) => ({ id, model })), identities);
});

test("confirmed model replacement clears old nine slots, raw info, zones and freshness", () => {
  const first = reduceReport(null, print({ info: "7", tray: Array.from({ length: 9 }, (_, id) => ({ id, tray_type: "PLA" })),
    zone_info: [{ zone_id: 0, temp: 30 }] }), { receivedAt: 100, amsIdentities: identity }).state;
  const nextIdentity = [{ id: "32", model: "AMS 2 Pro" }];
  const replaced = reduceReport(first, undefined, { receivedAt: 200, amsIdentities: nextIdentity }).state;
  assert.deepEqual(replaced.ams.units, [{ id: "32", model: "AMS 2 Pro", slots: null }]);
  assert.deepEqual(replaced.freshness.ams.units[32], { slots: {}, model: { at: 200, stale: false } });
  const updated = reduceReport(replaced, print({ tray: [{ id: 1, tray_type: "PETG" }] }), { receivedAt: 300 }).state;
  assert.equal(updated.ams.units[0].slots.length, 1);
  assert.equal(updated.ams.units[0].slots[0].id, "1");
  assert.equal(updated.ams.units[0].zones, undefined);
  assert.equal(first.ams.units[0].slots.length, 9);
});

test("first identification preserves prior slots, zone measurements and their freshness", () => {
  const initial = reduceReport(null, print({ tray: [{ id: 8, tray_type: "PLA" }], zone_info: [{ zone_id: 1, temp: 25 }] }), { receivedAt: 100 }).state;
  const identified = reduceReport(initial, undefined, { receivedAt: 200, amsIdentities: identity }).state;
  assert.deepEqual(identified.ams.units[0].slots, initial.ams.units[0].slots);
  assert.deepEqual(identified.ams.units[0].zones, initial.ams.units[0].zones);
  assert.deepEqual(identified.freshness.ams.units[32].zones, initial.freshness.ams.units[32].zones);
  assert.deepEqual(identified.freshness.ams.units[32].slots, initial.freshness.ams.units[32].slots);
});

test("model replacement invalidates a preceding mask until new mask telemetry arrives", () => {
  let state = reduceReport(null, { ams: { tray_exist_bits: "0", ams: [{ id: 0, tray: [{ id: 8, tray_type: "PLA" }] }] } },
    { receivedAt: 100, amsIdentities: [{ id: "0", model: "AMS 3H" }] }).state;
  state = reduceReport(state, undefined, { receivedAt: 200, amsIdentities: [{ id: "0", model: "AMS 2 Pro" }] }).state;
  assert.equal(state.freshness.ams.fields.existBits.stale, true);
  state = reduceReport(state, { ams: { ams: [{ id: 0, tray: [{ id: 0, tray_type: "PETG" }] }] } }, { receivedAt: 300 }).state;
  assert.equal(state.ams.units[0].slots[0].material, "PETG");
  assert.equal(state.ams.units[0].slots[0].exists, null);
  state = reduceReport(state, { ams: { tray_exist_bits: "0" } }, { receivedAt: 400 }).state;
  assert.equal(state.ams.units[0].slots[0].material, null);
  assert.equal(state.ams.units[0].slots[0].exists, false);
});
