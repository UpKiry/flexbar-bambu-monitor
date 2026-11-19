const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createDiagnostics } = require("../src/admin/diagnostics");
const { sanitizePayload } = require("../src/admin/debug-redaction");
const { CloudApi } = require("../src/cloud/cloud-api");
const { createCloudMqttClient } = require("../src/cloud/cloud-mqtt");
const { createPrinterManager } = require("../src/printer/printer-manager");

test("frames recursively hide credentials, personal fields, free text and signed URLs", () => {
  const diagnostics = createDiagnostics();
  diagnostics.recordFrame({ protocol: "http", source: "/devices?token=secret", payload: {
    devices: [{ name: "PRIVATE-NAME", nested: { access_token: "TOKEN", dev_access_code: "ACCESS", password: "PASSWORD", code: "CODE", email: "PRIVATE-EMAIL", uid: 123456789, phone: "PRIVATE-PHONE", authorization: "AUTH" } }],
    print: { mc_percent: 42, url: "https://example.test/file?signature=URLSECRET", note: "email person@example.test password=NOTSAFE" },
  } });
  const [frame] = diagnostics.snapshot().frames;
  assert.equal(frame.source, "/devices");
  assert.equal(frame.payload.print.mc_percent, 42);
  for (const secret of ["PRIVATE-NAME", "TOKEN", "ACCESS", "PASSWORD", "CODE", "PRIVATE-EMAIL", "123456789", "PRIVATE-PHONE", "AUTH", "URLSECRET", "person@example.test", "NOTSAFE"]) {
    assert.ok(!JSON.stringify(frame).includes(secret), secret);
  }
  frame.payload.print.mc_percent = -1;
  assert.equal(diagnostics.snapshot().frames[0].payload.print.mc_percent, 42);
});

test("diagnostic logs recursively hide structured sensitive objects and limit text", () => {
  const diagnostics = createDiagnostics();
  diagnostics.recordLog({ message: JSON.stringify({ nested: { access_token: { value: "NESTEDSECRET" }, name: "PERSONAL" }, value: "https://example.test?sig=SIGNATURE" }) });
  diagnostics.recordLog({ message: "x".repeat(10000) });
  const text = JSON.stringify(diagnostics.snapshot().logs);
  for (const secret of ["NESTEDSECRET", "PERSONAL", "SIGNATURE"]) assert.ok(!text.includes(secret));
  assert.ok(diagnostics.snapshot().logs[0].message.length <= 4096);
});

test("frames enforce count, single-frame and total bytes, newest first; clear retains monotonic ids", () => {
  const diagnostics = createDiagnostics({ frameCapacity: 3, frameMaxBytes: 1024, frameTotalBytes: 1500 });
  for (let i = 0; i < 20; i++) diagnostics.recordFrame({ protocol: "mqtt", source: "device/a/report", payload: { i, huge: "x".repeat(9000) } });
  let frames = diagnostics.snapshot().frames;
  assert.ok(frames.length <= 3 && frames.length > 0);
  assert.ok(frames.every((f) => f.truncated && Buffer.byteLength(JSON.stringify(f)) <= 1024));
  assert.ok(frames.reduce((sum, f) => sum + Buffer.byteLength(JSON.stringify(f)), 0) <= 1500);
  assert.equal(frames[0].id, 20);
  assert.ok(frames.every((f, i) => i === 0 || frames[i - 1].id > f.id));
  diagnostics.clear();
  assert.deepEqual(diagnostics.snapshot().frames, []);
  diagnostics.recordFrame({ protocol: "mqtt", payload: {} });
  assert.equal(diagnostics.snapshot().frames[0].id, 21);
  assert.equal(sanitizePayload({ deep: { nested: {} } }, { maxDepth: 1 }).truncated, true);
  const total = createDiagnostics({ frameCapacity: 100, frameMaxBytes: 1024, frameTotalBytes: 1024 });
  for (let i = 0; i < 100; i++) total.recordFrame({ protocol: "mqtt", payload: { i, value: "x".repeat(40) } });
  frames = total.snapshot().frames;
  assert.ok(frames.length > 0 && frames.length < 100);
  assert.ok(frames.reduce((sum, f) => sum + Buffer.byteLength(JSON.stringify(f)), 0) <= 1024);
  assert.equal(frames[0].id, 100);
});

test("HTTP adapter emits only redacted response data, auth metadata, and isolates observers", async () => {
  const frames = [];
  const response = { devices: [{ dev_id: "DEV", dev_access_code: "ACCESS", nested: { refreshToken: "REFRESH" } }] };
  const api = new CloudApi({ requestFn: async () => ({ status: 200, text: JSON.stringify(response) }), onFrame: (f) => frames.push(f) });
  assert.equal((await api.fetchDevices("REQUEST-TOKEN"))[0].id, "DEV");
  assert.ok(!JSON.stringify(frames).includes("ACCESS"));
  assert.ok(!JSON.stringify(frames).includes("REFRESH"));
  assert.ok(!JSON.stringify(frames).includes("REQUEST-TOKEN"));
  api.requestFn = async () => ({ status: 200, text: JSON.stringify({ accessToken: "AUTH-TOKEN", arbitrary: "PRIVATE" }) });
  await api.login({ account: "ACCOUNT", password: "PASSWORD" });
  assert.deepEqual(frames[1].payload, { metadataOnly: true, json: true });
  api.onFrame = () => { throw new Error("observer"); };
  assert.equal((await api.login({ account: "ACCOUNT", password: "PASSWORD" })).accessToken, "AUTH-TOKEN");
  api.onFrame = async () => { throw new Error("async observer"); };
  await api.login({ account: "ACCOUNT", code: "123456" });
  await new Promise(setImmediate);
});

function makeMqtt(onFrame) {
  const transport = new EventEmitter();
  transport.subscribe = (_topic, _opts, callback) => callback(null);
  transport.end = (_force, callback) => callback();
  const client = createCloudMqttClient({ host: "example.test", username: "u_1", password: "TOKEN", deviceId: "DEV", createClient: () => transport, onFrame });
  client.start();
  transport.emit("connect");
  return { client, transport };
}

test("MQTT captures non-print JSON and filtered print commands before business filtering", async () => {
  const frames = [];
  const { client, transport } = makeMqtt((frame) => frames.push(frame));
  const reports = [];
  client.onReport((report) => reports.push(report));
  const emit = (value, topic = "device/DEV/report") => transport.emit("message", topic, Buffer.from(value));
  emit(JSON.stringify({ system: { command: "version", nested: [{ accessToken: "TOKEN" }] } }));
  emit(JSON.stringify({ print: { command: "other", mc_percent: 1 } }));
  emit("null");
  emit("{broken");
  emit("{}", "device/OTHER/report");
  assert.equal(frames.length, 4);
  assert.equal(frames[0].payload.system.command, "version");
  assert.ok(!JSON.stringify(frames).includes("TOKEN"));
  assert.equal(frames[2].payload, null);
  assert.equal(frames[3].payload.parseError, true);
  assert.equal(frames[3].payload.bytes, 7);
  assert.equal(reports.length, 0);
  await client.stop();
});

test("malformed and oversized MQTT frames retain metadata without unsafe body text", async () => {
  const diagnostics = createDiagnostics();
  const { client, transport } = makeMqtt((frame) => diagnostics.recordFrame(frame));
  const invalid = Buffer.from('{password: "UNSAFE-BODY"}');
  const oversized = Buffer.from("UNSAFE-BODY".repeat(30000));
  transport.emit("message", "device/OTHER/report", oversized);
  assert.equal(diagnostics.snapshot().frames.length, 0);
  transport.emit("message", "device/DEV/report", invalid);
  transport.emit("message", "device/DEV/report", oversized);
  const frames = diagnostics.snapshot().frames;
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0].payload, { oversize: true, bodyOmitted: true, bytes: oversized.length });
  assert.equal(frames[0].truncated, true);
  assert.deepEqual(frames[1].payload, { parseError: true, bodyOmitted: true, bytes: invalid.length });
  assert.ok(!JSON.stringify(frames).includes("UNSAFE-BODY"));
  await client.stop();
});

test("HTTP non-JSON responses expose omission metadata without body content", async () => {
  const frames = [];
  const text = '<html>UNSAFE-BODY password="PRIVATE"</html>';
  const api = new CloudApi({ requestFn: async () => ({ status: 502, text }), onFrame: (frame) => frames.push(frame) });
  await assert.rejects(api.call("/v1/iot-service/api/user/bind"));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].payload, { metadataOnly: true, json: false, parseError: true, bodyOmitted: true, bytes: Buffer.byteLength(text) });
  assert.ok(!JSON.stringify(frames).includes("UNSAFE-BODY"));
  api.requestFn = async () => ({ status: 200, text: "null" });
  assert.equal(await api.call("/null"), null);
  assert.equal(frames[1].payload, null);
});

test("MQTT and manager diagnostics callback exceptions cannot prevent print reports", async () => {
  for (const callback of [() => { throw new Error("observer"); }, async () => { throw new Error("observer"); }]) {
    const { client, transport } = makeMqtt(callback);
    let reports = 0;
    client.onReport(() => reports++);
    transport.emit("message", "device/DEV/report", Buffer.from('{"print":{"mc_percent":42}}'));
    assert.equal(reports, 1);
    await client.stop();
  }
  let mqttOptions;
  const manager = createPrinterManager({ onFrame: () => { throw new Error("observer"); }, createMqttClient: (options) => {
    mqttOptions = options;
    return { onReport() {}, onStatus() {}, start() {}, stop() {} };
  } });
  manager.selectPrinter("DEV");
  manager.connect({ host: "host", userId: "1", accessToken: "TOKEN" });
  assert.doesNotThrow(() => mqttOptions.onFrame({ protocol: "mqtt", payload: {} }));
  await manager.disconnect();
  await new Promise(setImmediate);
});
