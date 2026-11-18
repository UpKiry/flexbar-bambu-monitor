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
    client.end = () => {
      client.ended = true;
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
  assert.ok(logs.some((line) => line.includes("handler exploded")));
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

test("pushall requests are rate limited", () => {
  let clock = 0;
  const { client, created } = makeClient({ now: () => clock, pushallCooldownMs: 300_000 });
  client.start();

  assert.deepEqual(client.requestFullState(), { sent: false, reason: "not-connected" });

  const fake = created[0];
  fake.emit("connect");
  const first = client.requestFullState();
  assert.equal(first.sent, true);
  assert.equal(fake.published.length, 1);
  assert.equal(fake.published[0].topic, "device/DEV1/request");
  assert.equal(JSON.parse(fake.published[0].payload).pushing.command, "pushall");

  clock = 1000;
  assert.equal(client.requestFullState().reason, "cooldown");
  assert.equal(fake.published.length, 1);

  clock = 300_000;
  assert.equal(client.requestFullState().sent, true);
  assert.equal(fake.published.length, 2);
});

test("publish failures are reported instead of thrown", () => {
  const { client, created } = makeClient();
  client.start();
  const fake = created[0];
  fake.emit("connect");
  fake.publish = () => {
    throw new Error("publish exploded");
  };
  const result = client.requestFullState();
  assert.equal(result.sent, false);
  assert.match(result.reason, /publish exploded/);
});
