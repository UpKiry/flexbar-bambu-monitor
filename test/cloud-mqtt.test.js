const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  backoffDelay,
  createCloudMqttClient,
  randomClientId,
  reportTopic,
  requestTopic,
  CONNECTION_STATES,
} = require("../src/cloud/cloud-mqtt");

/** 假 MQTT 客户端：把 mqtt 库的回调行为显式暴露给测试。 */
function makeFakeClientFactory() {
  const created = [];
  const factory = (url, options) => {
    const client = new EventEmitter();
    client.url = url;
    client.options = options;
    client.subscriptions = [];
    client.published = [];
    client.ended = false;
    client.subscribe = (topic, opts, callback) => {
      client.subscriptions.push(topic);
      callback?.(null);
    };
    client.publish = (topic, payload, opts) => {
      client.published.push({ topic, payload, opts });
    };
    client.end = (_force, callback) => {
      client.ended = true;
      callback?.();
    };
    created.push(client);
    return client;
  };
  return { factory, created };
}

function makeClient(overrides = {}) {
  const { factory, created } = makeFakeClientFactory();
  const statuses = [];
  const reports = [];
  const client = createCloudMqttClient({
    host: "us.mqtt.bambulab.com",
    port: 8883,
    username: "u_42",
    password: "token",
    deviceId: "DEV1",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    createClient: factory,
    random: () => 0.5,
    ...overrides,
  });
  client.onStatus((status) => statuses.push(status));
  client.onReport((report) => reports.push(report));
  return { client, created, statuses, reports };
}

test("topic helpers match the community documented layout", () => {
  assert.equal(reportTopic("DEV1"), "device/DEV1/report");
  assert.equal(requestTopic("DEV1"), "device/DEV1/request");
});

test("client ids are unique-ish and prefixed", () => {
  const id = randomClientId(() => 0.123456);
  assert.match(id, /^flexbar-bambu-monitor-/);
  assert.notEqual(randomClientId(() => 0.1), randomClientId(() => 0.9));
});

test("backoff grows exponentially with bounded jitter", () => {
  assert.equal(backoffDelay(1, { baseMs: 1000, maxMs: 60000, random: () => 0 }), 1000);
  assert.equal(backoffDelay(2, { baseMs: 1000, maxMs: 60000, random: () => 0 }), 2000);
  assert.equal(backoffDelay(3, { baseMs: 1000, maxMs: 60000, random: () => 0 }), 4000);
  // 上限不会超过 maxMs * 1.4
  assert.ok(backoffDelay(50, { baseMs: 1000, maxMs: 60000, random: () => 1 }) <= 84000);
  assert.ok(backoffDelay(1, { baseMs: 1000, maxMs: 60000, random: () => 1 }) <= 1400);
});

test("start refuses to connect without complete credentials", () => {
  for (const override of [{ host: "" }, { username: "" }, { password: "" }, { deviceId: "" }]) {
    const { client, created } = makeClient(override);
    assert.equal(client.start(), false);
    assert.equal(created.length, 0);
    assert.equal(client.state, CONNECTION_STATES.failed);
  }
});

test("connecting subscribes to the device report topic over TLS", () => {
  const { client, created, statuses } = makeClient();
  assert.equal(client.start(), true);

  const fake = created[0];
  assert.equal(fake.url, "mqtts://us.mqtt.bambulab.com:8883");
  assert.equal(fake.options.username, "u_42");
  assert.equal(fake.options.password, "token");
  // 必须验证证书，且重连由本模块控制
  assert.equal(fake.options.rejectUnauthorized, true);
  assert.equal(fake.options.reconnectPeriod, 0);

  fake.emit("connect");
  assert.deepEqual(fake.subscriptions, ["device/DEV1/report"]);
  assert.equal(client.state, CONNECTION_STATES.connected);
  assert.equal(client.subscribed, true);
  assert.ok(statuses.some((status) => status.state === CONNECTION_STATES.connected));
});

test("unparsable payloads are ignored instead of crashing", () => {
  const { client, created, reports } = makeClient();
  client.start();
  const fake = created[0];
  fake.emit("connect");
  fake.emit("message", "device/DEV1/report", Buffer.from("not json"));
  fake.emit("message", "device/DEV1/report", Buffer.from(JSON.stringify({ other: {} })));
  assert.equal(reports.length, 0);
});

test("oversized device reports are ignored without logging payloads", () => {
  const logs = [];
  const { client, created, reports } = makeClient({ logger: { info() {}, warn: (text) => logs.push(text), error: (text) => logs.push(text) } });
  client.start();
  created[0].emit("connect");
  const text = JSON.stringify({ print: { gcode_state: "IDLE", padding: "X".repeat(256 * 1024) } });
  created[0].emit("message", "device/DEV1/report", Buffer.from(text));
  assert.equal(reports.length, 0);
  assert.ok(!logs.join(" ").includes("XXXX"));
});

test("status reports are parsed and forwarded with a receive time", () => {
  const { client, created, reports } = makeClient({ now: () => 777 });
  client.start();
  const fake = created[0];
  fake.emit("connect");
  fake.emit("message", "device/DEV1/report", Buffer.from(JSON.stringify({
    print: { command: "push_status", gcode_state: "RUNNING", mc_percent: 20 },
  })));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].raw.gcode_state, "RUNNING");
  assert.equal(reports[0].receivedAt, 777);
});

test("reports for other devices and other commands are ignored", () => {
  const { client, created, reports } = makeClient();
  client.start();
  const fake = created[0];
  fake.emit("connect");
  fake.emit("message", "device/OTHER/report", Buffer.from(JSON.stringify({ print: { gcode_state: "RUNNING" } })));
  fake.emit("message", "device/DEV1/report", Buffer.from(JSON.stringify({ print: { command: "get_version" } })));
  assert.equal(reports.length, 0);
});

test("a thrown report handler does not break the connection", () => {
  const logs = [];
  const { client, created } = makeClient({ logger: { info: () => {}, warn: () => {}, error: (m) => logs.push(m) } });
  client.onReport(() => {
    throw new Error("handler exploded");
  });
  client.start();
  const fake = created[0];
  fake.emit("connect");
  fake.emit("message", "device/DEV1/report", Buffer.from(JSON.stringify({ print: { gcode_state: "IDLE" } })));
  assert.ok(logs.includes("处理云端报文失败"));
  assert.ok(logs.every((line) => !line.includes("handler exploded")));
});

test("unauthorized errors stop retrying and surface an auth failure", () => {
  let clock = 0;
  const { client, created, statuses } = makeClient({ now: () => clock });
  client.start();
  const fake = created[0];
  fake.emit("error", { code: 5, message: "not authorized" });
  assert.equal(client.state, CONNECTION_STATES.failed);
  assert.equal(client.status().lastError.kind, "unauthorized");
  // 不应再排重连
  clock += 10 * 60 * 1000;
  assert.equal(created.length, 1);
  assert.ok(statuses.some((status) => status.state === CONNECTION_STATES.failed));
});

test("a closed connection schedules a single jittered reconnect", () => {
  let clock = 0;
  const { client, created } = makeClient({ now: () => clock, random: () => 0 });
  client.start();
  const fake = created[0];
  fake.emit("connect");
  fake.emit("close");
  assert.equal(client.state, CONNECTION_STATES.reconnecting);
  assert.equal(client.attempt, 1);
});

test("stop clears timers and ends the connection", () => {
  const { client, created } = makeClient();
  client.start();
  const fake = created[0];
  fake.emit("connect");
  client.stop();
  assert.equal(client.state, CONNECTION_STATES.idle);
  assert.equal(fake.ended, true);
});

test("stop waits for actual close before restart", async () => {
  const { client, created } = makeClient();
  client.start();
  let done;
  created[0].end = (_force, callback) => { done = callback; };
  const stopped = client.stop();
  let closed = false;
  stopped.then(() => { closed = true; });
  client.start();
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(created.length, 1);
  done();
  await stopped;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 2);
  await client.stop();
});

test("unconfirmed MQTT close times out and does not restart", async () => {
  const { client, created } = makeClient({ closeTimeoutMs: 10 });
  client.start();
  created[0].end = () => {};
  const stopped = client.stop();
  client.start();
  await assert.rejects(stopped, /关闭/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 1);
  assert.equal(client.state, CONNECTION_STATES.failed);
});

test("pushall requests enforce a five-second per-device cooldown", () => {
  let monotonic = 50;
  const { client, created } = makeClient({ deviceId: "COOLDOWN-5S", cooldownNow: () => monotonic });
  client.start();

  assert.deepEqual(client.requestFullState(), { sent: false, reason: "not-connected" });

  const fake = created[0];
  fake.emit("connect");
  assert.equal(client.requestFullState().sent, true);
  assert.equal(fake.published.length, 1);
  assert.equal(client.requestFullState().reason, "cooldown");
  assert.equal(client.requestFullState().retryInMs, 5000);

  monotonic += 4999;
  assert.equal(client.requestFullState().reason, "cooldown");
  assert.equal(client.requestFullState().retryInMs, 1);
  assert.equal(fake.published.length, 1);

  monotonic += 1;
  assert.equal(client.requestFullState().sent, true);
  assert.equal(fake.published.length, 2);
  assert.equal(fake.published[0].topic, "device/COOLDOWN-5S/request");
  assert.equal(JSON.parse(fake.published[0].payload).pushing.command, "pushall");
});

test("publish failures are reported instead of thrown and observe cooldown", () => {
  let monotonic = 0;
  const { client, created } = makeClient({ deviceId: "FAIL-5S", cooldownNow: () => monotonic });
  client.start();
  const fake = created[0];
  fake.emit("connect");
  fake.publish = () => {
    throw new Error("publish exploded");
  };
  const result = client.requestFullState();
  assert.deepEqual(result, { sent: false, reason: "publish-failed" });
  fake.publish = () => {};
  assert.equal(client.requestFullState().reason, "cooldown");
  monotonic = 5000;
  assert.equal(client.requestFullState().sent, true);
  client.stop();
});

test("connection becomes ready only after subscription is acknowledged", () => {
  const { client, created, statuses } = makeClient();
  client.start();
  let complete;
  created[0].subscribe = (topic, options, callback) => { complete = callback; };
  created[0].emit("connect");
  assert.equal(client.state, CONNECTION_STATES.connecting);
  assert.equal(client.subscribed, false);
  assert.equal(client.requestFullState().reason, "not-connected");
  complete(null, [{ topic: reportTopic("DEV1"), qos: 0 }]);
  assert.equal(client.state, CONNECTION_STATES.connected);
  assert.ok(statuses.filter((status) => status.state === CONNECTION_STATES.connected).every((status) => status.subscribed));
  client.stop();
});

test("subscription errors, rejected grants, and throws schedule reconnect", () => {
  for (const outcome of ["error", "rejected", "throw"]) {
    const { client, created, statuses } = makeClient();
    client.start();
    const fake = created[0];
    fake.subscribe = (topic, options, callback) => {
      if (outcome === "throw") throw new Error("subscribe failed");
      if (outcome === "error") callback(new Error("subscribe failed"));
      else callback(null, [{ topic, qos: 128 }]);
    };
    fake.emit("connect");
    assert.equal(fake.ended, true, outcome);
    assert.equal(client.state, CONNECTION_STATES.reconnecting, outcome);
    assert.equal(client.subscribed, false, outcome);
    assert.equal(client.status().lastError.kind, "network", outcome);
    assert.ok(statuses.some((status) => status.reason === "subscribe-failed"));
    client.stop();
  }
});

test("late callbacks from a stopped or replaced connection have no effect", async () => {
  const { client, created, reports } = makeClient();
  client.start();
  const old = created[0];
  let complete;
  old.subscribe = (topic, options, callback) => { complete = callback; };
  old.emit("connect");
  const oldClose = old.listeners("close")[0];
  const oldError = old.listeners("error")[0];
  const oldMessage = old.listeners("message")[0];
  const closed = client.stop();
  client.start();
  await closed;
  await new Promise((resolve) => setImmediate(resolve));
  created[1].emit("connect");
  complete(null);
  oldClose();
  oldError({ code: 5 });
  oldMessage(reportTopic("DEV1"), Buffer.from(JSON.stringify({ print: { gcode_state: "RUNNING" } })));
  assert.equal(client.state, CONNECTION_STATES.connected);
  assert.equal(client.subscribed, true);
  assert.equal(reports.length, 0);
  assert.equal(created[1].ended, false);
  client.stop();
});

test("asynchronous publish failure retains cooldown and hides errors", () => {
  let monotonic = 0;
  const logs = [];
  const { client, created } = makeClient({ deviceId: "ASYNC-5S", cooldownNow: () => monotonic,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) } });
  client.start();
  created[0].emit("connect");
  let callback;
  created[0].publish = (topic, payload, options, done) => { callback = done; };
  assert.equal(client.requestFullState().sent, true);
  callback(new Error("sensitive-token"));
  assert.equal(client.requestFullState().reason, "cooldown");
  assert.ok(logs.every((line) => !line.includes("sensitive-token")));
  monotonic = 5000;
  assert.equal(client.requestFullState().sent, true);
  client.stop();
});

test("wildcards and topic separators are rejected in device IDs", () => {
  for (const deviceId of ["abc/def", "abc+", "abc#", "abc\u0000"]) {
    const { client, created } = makeClient({ deviceId });
    assert.equal(client.start(), false);
    assert.equal(created.length, 0);
  }
});

test("exceptions and incoming payloads never appear in logs or connection status", () => {
  const secret = "sensitive-token";
  const logs = [];
  const { client, created, statuses } = makeClient({ deviceId: "SAFE", logger: {
    info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m),
  } });
  client.onStatus((s) => { statuses.push(s); throw new Error(secret); });
  client.onReport(() => { throw new Error(secret); });
  client.start();
  created[0].emit("connect");
  created[0].emit("message", reportTopic("SAFE"), Buffer.from(JSON.stringify({ print: { task: secret } })));
  created[0].emit("error", { code: 1, message: secret });
  assert.ok(!JSON.stringify({ logs, statuses, status: client.status() }).includes(secret));
  client.stop();
});
