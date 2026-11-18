const test = require("node:test");
const assert = require("node:assert/strict");
const { createPluginRuntime, normalizeConfig, KEY_CID } = require("../src/runtime");
const { createCredentialStore, createMemoryBackend } = require("../src/auth/credential-store");
const { CONNECTION_STATES } = require("../src/cloud/cloud-mqtt");

const CID = KEY_CID;

function makeStore() {
  const backend = createMemoryBackend();
  backend.probe = async () => ({ available: true, reason: "" });
  return createCredentialStore({ backend });
}

function makeApi(overrides = {}) {
  return {
    regionId: "global",
    regionLabel: "全球",
    login: overrides.login || (async () => ({ accessToken: "tok", refreshToken: "", expiresInSeconds: 3600, loginType: "" })),
    requestEmailCode: overrides.requestEmailCode || (async () => ({ codeSent: true, login: null })),
    fetchUserId: overrides.fetchUserId || (async () => "42"),
    fetchDevices: overrides.fetchDevices || (async () => [
      { id: "DEV1", name: "X1-01", model: "X1 Carbon", online: true, printStatus: "SUCCESS", nozzleDiameter: "0.4" },
    ]),
    logout: overrides.logout || (async () => true),
  };
}

function makeFakeMqtt() {
  const created = [];
  const factory = (options) => {
    const handlers = {};
    const instance = {
      options,
      started: false,
      stopped: false,
      onStatus(fn) { handlers.status = fn; },
      onReport(fn) { handlers.report = fn; },
      start() { instance.started = true; },
      stop() { instance.stopped = true; },
      requestFullState: () => ({ sent: true }),
      pushStatus(status) { handlers.status?.(status); },
      pushReport(report) { handlers.report?.(report); },
    };
    created.push(instance);
    return instance;
  };
  return { factory, created };
}

function makePlugin({ config = { region: "global", printerId: "", printerName: "" } } = {}) {
  const handlers = new Map();
  const draws = [];
  const savedConfigs = [];
  let current = { ...config };
  return {
    handlers,
    draws,
    savedConfigs,
    on: (type, handler) => handlers.set(type, handler),
    getConfig: async () => current,
    setConfig: async (next) => {
      current = { ...next };
      savedConfigs.push({ ...next });
      return { status: "success" };
    },
    draw: async (serial, key, format) => {
      draws.push({ serial, uid: key.uid, title: key.title, format, style: { ...key.style } });
    },
  };
}

function makeRuntime({ config, apiOverrides, plugin, credentialStore = makeStore() } = {}) {
  const host = plugin || makePlugin({ config });
  const { factory, created } = makeFakeMqtt();
  const logs = { errors: [], warns: [], infos: [] };
  const runtime = createPluginRuntime({
    plugin: host,
    logger: {
      info: (m) => logs.infos.push(m),
      warn: (m) => logs.warns.push(m),
      error: (m) => logs.errors.push(m),
      debug: () => {},
    },
    createApi: () => makeApi(apiOverrides),
    credentialStore,
    configRetryDelayMs: 1,
    createMqttManager: (options) => {
      const { createPrinterManager } = require("../src/printer/printer-manager");
      return createPrinterManager({ ...options, createMqttClient: factory, now: () => 9000 });
    },
    now: () => 9000,
  });
  return { runtime, host, mqtt: created, logs };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function keys() {
  return [{ cid: CID, uid: 1, width: 240, style: {}, data: { view: "progress" }, title: "" }];
}

test("normalizeConfig keeps only non-sensitive fields", () => {
  assert.deepEqual(normalizeConfig({ region: "china", printerId: "D1", printerName: "X1", password: "x" }), {
    region: "china",
    printerId: "D1",
    printerName: "X1",
  });
  assert.deepEqual(normalizeConfig(null), { region: "global", printerId: "", printerName: "" });
  assert.equal(normalizeConfig({ region: "mars" }).region, "global");
});

test("startup with no session draws the signed-out prompt", async () => {
  const { runtime, host } = makeRuntime();
  await runtime.start();
  host.handlers.get("plugin.alive")({ serialNumber: "SN", keys: keys() });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(host.draws.length >= 1);
  assert.match(host.draws.at(-1).title, /^请登录/);
  assert.equal(host.draws.at(-1).serial, "SN");
  assert.equal(host.draws.at(-1).format, "draw");
});

test("shutdown during config loading prevents later hydration and connection", async () => {
  const config = deferred();
  const entered = deferred();
  const host = makePlugin();
  host.getConfig = () => { entered.resolve(); return config.promise; };
  let reads = 0;
  const credentialStore = makeStore();
  credentialStore.load = async () => { reads += 1; return JSON.stringify({ accessToken: "tok", userId: "42", region: "global" }); };
  const { runtime, mqtt } = makeRuntime({ plugin: host, credentialStore });
  const starting = runtime.start();
  await entered.promise;
  await runtime.shutdown();
  config.resolve({ region: "global", printerId: "DEV1" });
  await starting;
  assert.equal(reads, 0);
  assert.equal(mqtt.length, 0);
  assert.equal(runtime.config.printerId, "");
});

test("login flow refreshes devices, connects and draws the selected printer", async () => {
  const { runtime, host, mqtt } = makeRuntime();
  await runtime.start();
  host.handlers.get("plugin.alive")({ serialNumber: "SN", keys: keys() });

  const login = await host.handlers.get("ui.message")({ action: "login", account: "a@b.c", password: "pw" });
  assert.equal(login.status, "success");
  assert.equal(login.devices.length, 1);

  // 只有一台设备时自动选中，并启动监控
  assert.equal(runtime.config.printerId, "DEV1");
  assert.equal(mqtt.length, 1);
  assert.equal(mqtt[0].options.deviceId, "DEV1");
  assert.equal(mqtt[0].options.password, "tok");

  mqtt[0].pushStatus({ state: CONNECTION_STATES.connected, attempt: 0, lastError: null, subscribed: true });
  mqtt[0].pushReport({ raw: { gcode_state: "RUNNING", mc_percent: 41, mc_remaining_time: 30 }, receivedAt: 9000 });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const titles = host.draws.map((draw) => draw.title);
  assert.ok(titles.some((title) => title.startsWith("打印中")), `expected 打印中, got ${titles.join(",")}`);
  assert.ok(titles.some((title) => /41%/.test(title)), `expected progress in title, got ${titles.join(",")}`);
});

for (const firstAction of ["login", "requestCode"]) {
  for (const secondAction of ["login", "requestCode"]) {
    test(`${firstAction} 收到并发 ${secondAction} busy 时仍完成首次登录收尾`, async () => {
      const pending = deferred();
      const login = { accessToken: "tok", expiresInSeconds: 3600 };
      let fetchCount = 0;
      const { runtime, mqtt } = makeRuntime({ apiOverrides: {
        login: () => pending.promise,
        requestEmailCode: () => pending.promise,
        fetchDevices: async () => { fetchCount += 1; return [{ id: "DEV1", name: "设备" }]; },
      } });
      await runtime.start();
      const first = runtime.actions[firstAction]({ account: "a@b.c", password: "pw" });
      const second = await runtime.actions[secondAction]({ account: "a@b.c", password: "pw" });
      assert.equal(second.status, "busy");
      pending.resolve(firstAction === "login" ? login : { codeSent: false, login });
      assert.equal((await first).status, "success");
      assert.equal(fetchCount, 1);
      assert.equal(runtime.config.printerId, "DEV1");
      assert.equal(mqtt.length, 1);
      await runtime.shutdown();
    });
  }
}

test("验证码提交遇到并发 busy 仍完成登录收尾", async () => {
  const pending = deferred();
  const { runtime, mqtt } = makeRuntime({ apiOverrides: {
    requestEmailCode: async () => ({ codeSent: true }),
    login: () => pending.promise,
  } });
  await runtime.start();
  assert.equal((await runtime.actions.requestCode({ account: "a@b.c" })).status, "code-sent");
  const first = runtime.actions.login({ code: "123456" });
  assert.equal((await runtime.actions.login({ code: "123456" })).status, "busy");
  pending.resolve({ accessToken: "tok", expiresInSeconds: 3600 });
  assert.equal((await first).status, "success");
  assert.equal(runtime.devices[0].id, "DEV1");
  assert.equal(mqtt.length, 1);
  await runtime.shutdown();
});

test("取消认证后迟到响应不会启动监控", async () => {
  const pending = deferred();
  const { runtime, mqtt } = makeRuntime({ apiOverrides: { login: () => pending.promise } });
  await runtime.start();
  const first = runtime.actions.login({ account: "a@b.c", password: "pw" });
  await runtime.actions.cancelCode();
  assert.equal((await runtime.actions.login({ account: "a@b.c", password: "pw" })).status, "busy");
  pending.resolve({ accessToken: "tok", expiresInSeconds: 3600 });
  assert.equal((await first).status, "cancelled");
  assert.equal(mqtt.length, 0);
  assert.deepEqual(runtime.devices, []);
  await runtime.shutdown();
});

test("unknown UI actions are rejected without throwing", async () => {
  const { runtime, host } = makeRuntime();
  await runtime.start();
  const result = await host.handlers.get("ui.message")({ action: "dropTables" });
  assert.equal(result.status, "error");
  assert.equal(result.message, "未知的操作");
});

test("status action reports auth, config, devices and link", async () => {
  const { runtime, host } = makeRuntime();
  await runtime.start();
  host.handlers.get("plugin.alive")({ serialNumber: "SN", keys: keys() });
  const status = await host.handlers.get("ui.message")({ action: "status" });
  assert.equal(status.status, "success");
  assert.equal(status.auth.state, "signed-out");
  assert.equal(status.config.region, "global");
  assert.equal(status.credentialStore.available, true);
  assert.equal(status.printer.link.state, "idle");
});

test("setRegion persists to host config and invalidates a signed-in session", async () => {
  const { runtime, host, mqtt } = makeRuntime();
  await runtime.start();
  await host.handlers.get("ui.message")({ action: "login", account: "a@b.c", password: "pw" });

  const result = await host.handlers.get("ui.message")({ action: "setRegion", region: "china" });
  assert.equal(result.status, "success");
  assert.equal(runtime.config.region, "china");
  assert.deepEqual(host.savedConfigs.at(-1), { region: "china", printerId: "DEV1", printerName: "X1-01" });
  assert.equal(result.auth.state, "expired");
  // 换区域必须先停掉旧连接，否则会继续用旧令牌订阅另一区域的设备。
  assert.equal(mqtt[0].stopped, true);
});

test("setPrinter persists selection and restarts monitoring", async () => {
  const { runtime, host, mqtt } = makeRuntime();
  await runtime.start();
  await host.handlers.get("ui.message")({ action: "login", account: "a@b.c", password: "pw" });
  const before = mqtt.length;

  const result = await host.handlers.get("ui.message")({ action: "setPrinter", printerId: "DEV1" });
  assert.equal(result.status, "success");
  assert.equal(runtime.config.printerId, "DEV1");
  assert.ok(host.savedConfigs.length >= 1);
  // 已选中的设备不会重复建立连接
  assert.equal(mqtt.length, before);
});

test("旧会话设备选择写入迟到时不连接新会话", async () => {
  const host = makePlugin({ config: { region: "global", printerId: "", printerName: "" } });
  const entered = deferred();
  const unblock = deferred();
  const writes = [];
  host.setConfig = async (next) => {
    writes.push({ ...next });
    if (next.printerId === "OLD") { entered.resolve(); await unblock.promise; }
  };
  let loginCount = 0;
  const { runtime, mqtt } = makeRuntime({ plugin: host, apiOverrides: {
    login: async () => ({ accessToken: `token-${++loginCount}`, expiresInSeconds: 3600 }),
    fetchDevices: async (token) => token === "token-1"
      ? [{ id: "OLD", name: "旧设备" }, { id: "OTHER", name: "其他" }]
      : [{ id: "NEW", name: "新设备" }],
  } });
  await runtime.start();
  await runtime.actions.login({ account: "a@b.c", password: "pw" });
  const selecting = runtime.actions.setPrinter({ printerId: "OLD" });
  await entered.promise;
  await runtime.actions.logout();
  const newLogin = runtime.actions.login({ account: "a@b.c", password: "pw" });
  unblock.resolve();
  assert.equal((await selecting).status, "cancelled");
  assert.equal((await newLogin).status, "success");
  assert.equal(runtime.config.printerId, "NEW");
  assert.ok(writes.some((entry) => entry.printerId === ""));
  assert.ok(!mqtt.some((entry) => entry.options.deviceId === "OLD" && entry.options.password === "token-2"));
  await runtime.shutdown();
});

test("logout disconnects, clears credentials and prompts login again", async () => {
  const { runtime, host, mqtt } = makeRuntime();
  await runtime.start();
  host.handlers.get("plugin.alive")({ serialNumber: "SN", keys: keys() });
  await host.handlers.get("ui.message")({ action: "login", account: "a@b.c", password: "pw" });

  const result = await host.handlers.get("ui.message")({ action: "logout" });
  assert.equal(result.status, "success");
  assert.equal(result.auth.state, "signed-out");
  assert.equal(mqtt[0].stopped, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(host.draws.at(-1).title, /^请登录/);
});

test("logout clears the displayed session even when credential deletion fails", async () => {
  const credentialStore = makeStore();
  credentialStore.clear = async () => { throw new Error("synthetic failure"); };
  const { runtime, host, mqtt } = makeRuntime({ credentialStore });
  await runtime.start();
  host.handlers.get("plugin.alive")({ serialNumber: "SN", keys: keys() });
  await runtime.actions.login({ account: "a@b.c", password: "pw" });
  const result = await runtime.actions.logout();
  assert.equal(result.status, "error");
  assert.match(result.message, /钥匙串/);
  assert.equal(mqtt[0].stopped, true);
  const status = await runtime.actions.status();
  assert.equal(status.auth.state, "signed-out");
  assert.deepEqual(status.devices, []);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(host.draws.at(-1).title, /^请登录/);
});

test("切换账号后仅连接当前列表中存在的设备，保留旧配置", async () => {
  let account = 0;
  const { runtime, mqtt, host } = makeRuntime({ apiOverrides: {
    login: async () => ({ accessToken: `token-${++account}`, expiresInSeconds: 3600 }),
    fetchDevices: async (token) => [{ id: token === "token-1" ? "OLD" : "NEW", name: "设备" }],
  } });
  await runtime.start();
  await runtime.actions.login({ account: "a@b.c", password: "pw" });
  assert.equal(runtime.config.printerId, "OLD");
  await runtime.actions.login({ account: "b@b.c", password: "pw" });
  assert.equal(mqtt.length, 1);
  assert.equal(mqtt[0].stopped, true);
  assert.equal(runtime.config.printerId, "OLD");
  assert.match((await runtime.actions.status()).display.subtitle, /不在当前账号/);
  assert.equal(host.savedConfigs.length, 1);
  await runtime.actions.setPrinter({ printerId: "NEW" });
  assert.equal(mqtt[1].options.deviceId, "NEW");
  assert.equal(mqtt[1].options.password, "token-2");
});

test("恢复会话先验证设备列表，失败保留配置并提示", async () => {
  const pending = deferred();
  const credentialStore = makeStore();
  credentialStore.load = async () => JSON.stringify({ accessToken: "tok", userId: "42", region: "global" });
  const { runtime, mqtt } = makeRuntime({ config: { region: "global", printerId: "DEV1", printerName: "打印机" }, credentialStore,
    apiOverrides: { fetchDevices: () => pending.promise } });
  await runtime.start();
  assert.equal(mqtt.length, 0);
  assert.match((await runtime.actions.status()).display.subtitle, /等待验证/);
  pending.reject(new Error("network"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mqtt.length, 0);
  assert.equal(runtime.config.printerId, "DEV1");
  assert.match((await runtime.actions.status()).display.subtitle, /读取失败/);
});

test("恢复会话设备验证通过后才连接", async () => {
  const pending = deferred();
  const credentialStore = makeStore();
  credentialStore.load = async () => JSON.stringify({ accessToken: "tok", userId: "42", region: "global" });
  const { runtime, mqtt } = makeRuntime({ config: { region: "global", printerId: "DEV1" }, credentialStore,
    apiOverrides: { fetchDevices: () => pending.promise } });
  await runtime.start();
  assert.equal(mqtt.length, 0);
  pending.resolve([{ id: "DEV1", name: "设备" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mqtt.length, 1);
  assert.equal(mqtt[0].options.deviceId, "DEV1");
});

test("刷新发现解绑或失败时断开连接并保留配置", async () => {
  let count = 0;
  const { runtime, mqtt } = makeRuntime({ apiOverrides: { fetchDevices: async () => {
    count += 1;
    if (count === 1) return [{ id: "DEV1", name: "设备" }];
    if (count === 2) return [];
    throw new Error("network");
  } } });
  await runtime.start();
  await runtime.actions.login({ account: "a@b.c", password: "pw" });
  await runtime.actions.refreshDevices();
  assert.equal(mqtt[0].stopped, true);
  assert.equal(runtime.config.printerId, "DEV1");
  assert.match((await runtime.actions.status()).display.subtitle, /不在当前账号/);
  await runtime.actions.refreshDevices();
  assert.equal(mqtt.length, 1);
  assert.match((await runtime.actions.status()).display.subtitle, /读取失败/);
});

test("连接测试迟到结果不返回旧账号设备", async () => {
  const pending = deferred();
  let count = 0;
  const { runtime } = makeRuntime({ apiOverrides: { fetchDevices: () => ++count === 1 ? Promise.resolve([]) : pending.promise } });
  await runtime.start();
  await runtime.actions.login({ account: "a@b.c", password: "pw" });
  const request = runtime.actions.testConnection();
  await runtime.actions.logout();
  pending.resolve([{ id: "OLD", name: "旧设备" }]);
  assert.deepEqual(await request, { status: "cancelled" });
});

test("late device response after logout cannot select or reconnect", async () => {
  let resolveDevices;
  const { runtime, host, mqtt } = makeRuntime({ apiOverrides: { fetchDevices: () => new Promise((resolve) => { resolveDevices = resolve; }) } });
  await runtime.start();
  const login = runtime.actions.login({ account: "a@b.c", password: "pw" });
  while (!resolveDevices) await new Promise((resolve) => setImmediate(resolve));
  await runtime.actions.logout();
  resolveDevices([{ id: "STALE", name: "Old" }]);
  await login;
  assert.deepEqual(runtime.devices, []);
  assert.equal(runtime.config.printerId, "");
  assert.equal(host.savedConfigs.length, 0);
  assert.equal(mqtt.length, 0);
});

test("late unauthorized response cannot invalidate a newer session", async () => {
  let rejectOld;
  let count = 0;
  const { runtime } = makeRuntime({ apiOverrides: { fetchDevices: () => {
    count += 1;
    return count === 1 ? new Promise((_resolve, reject) => { rejectOld = reject; }) : Promise.resolve([]);
  } } });
  await runtime.start();
  const first = runtime.actions.login({ account: "a@b.c", password: "pw" });
  while (!rejectOld) await new Promise((resolve) => setImmediate(resolve));
  await runtime.actions.logout();
  await runtime.actions.login({ account: "a@b.c", password: "pw" });
  rejectOld(Object.assign(new Error("old"), { kind: "unauthorized" }));
  await first;
  assert.equal(runtime.auth.state, "signed-in");
});

test("concurrent device refresh discards older results and errors", async () => {
  const old = deferred();
  let count = 0;
  const { runtime } = makeRuntime({ apiOverrides: { fetchDevices: async () => {
    count += 1;
    if (count === 1) return [];
    if (count === 2) return old.promise;
    return [{ id: "NEW", name: "New" }];
  } } });
  await runtime.start();
  await runtime.actions.login({ account: "a@b.c", password: "pw" });
  const previous = runtime.actions.refreshDevices();
  await runtime.actions.refreshDevices();
  old.reject(Object.assign(new Error("old"), { kind: "unauthorized" }));
  assert.equal((await previous).status, "cancelled");
  assert.equal(runtime.auth.state, "signed-in");
  assert.equal(runtime.devices[0].id, "NEW");
});

test("MQTT authorization failure expires the current session", async () => {
  const { runtime, mqtt } = makeRuntime();
  await runtime.start();
  await runtime.actions.login({ account: "a@b.c", password: "pw" });
  mqtt[0].pushStatus({ state: CONNECTION_STATES.failed, lastError: { kind: "unauthorized" }, subscribed: false });
  assert.equal(runtime.auth.state, "expired");
  assert.deepEqual(runtime.devices, []);
  assert.equal(mqtt[0].stopped, true);
});

test("logout reports connection close failure and still clears credentials", async () => {
  const credentialStore = makeStore();
  let cleared = false;
  const clear = credentialStore.clear;
  credentialStore.clear = async () => { cleared = true; await clear(); };
  const { runtime } = makeRuntime({ credentialStore });
  await runtime.start();
  await runtime.actions.login({ account: "a@b.c", password: "pw" });
  runtime.printer.disconnect = () => Promise.reject(new Error("fake-secret"));
  const result = await runtime.actions.logout();
  assert.equal(result.status, "error");
  assert.match(result.message, /无法确认云端连接已关闭/);
  assert.equal(cleared, true);
  assert.equal(runtime.auth.state, "signed-out");
});

test("旧退出等待远端撤销时新会话设备不被清除", async () => {
  const revoke = deferred();
  const started = deferred();
  let loginCount = 0;
  const { runtime, mqtt } = makeRuntime({ apiOverrides: {
    login: async () => ({ accessToken: `token-${++loginCount}`, expiresInSeconds: 3600 }),
    fetchDevices: async (token) => [{ id: token === "token-1" ? "DEV1" : "DEV2", name: "设备" }],
    logout: async () => { started.resolve(); await revoke.promise; },
  } });
  await runtime.start();
  await runtime.actions.login({ account: "a@b.c", password: "pw" });
  const oldLogout = runtime.actions.logout();
  await started.promise;
  assert.deepEqual(runtime.devices, []);
  await runtime.actions.login({ account: "a@b.c", password: "pw" });
  revoke.resolve();
  assert.equal((await oldLogout).status, "cancelled");
  assert.equal(runtime.auth.state, "signed-in");
  assert.equal(runtime.devices[0].id, "DEV2");
  assert.ok(mqtt.every((client) => !client.started || client.options.password !== "token-2" || !client.stopped));
  await runtime.shutdown();
});

test("device list failures surface as actionable errors", async () => {
  const { runtime, host } = makeRuntime({
    apiOverrides: {
      fetchDevices: async () => {
        throw new Error("设备列表响应格式异常");
      },
    },
  });
  await runtime.start();
  const login = await host.handlers.get("ui.message")({ action: "login", account: "a@b.c", password: "pw" });
  assert.equal(login.status, "success");
  assert.equal(login.devices.length, 0);
  const status = await host.handlers.get("ui.message")({ action: "status" });
  assert.match(status.devicesError, /设备列表/);
});

test("verification code login goes through requestCode then login", async () => {
  let loginCalls = 0;
  const { runtime, host } = makeRuntime({
    apiOverrides: {
      login: async ({ code }) => {
        loginCalls += 1;
        if (!code) throw Object.assign(new Error("需要验证码"), {});
        return { accessToken: "tok2", refreshToken: "", expiresInSeconds: 60, loginType: "verifyCode" };
      },
      requestEmailCode: async () => ({ codeSent: true, login: null }),
    },
  });
  await runtime.start();
  const sent = await host.handlers.get("ui.message")({ action: "requestCode", account: "a@b.c" });
  assert.equal(sent.status, "code-sent");

  const done = await host.handlers.get("ui.message")({ action: "login", account: "a@b.c", code: "123456" });
  assert.equal(done.status, "success");
  assert.equal(loginCalls, 1);
});

test("cancelling a verification flow prevents later code submission", async () => {
  const { runtime } = makeRuntime();
  await runtime.start();
  assert.equal((await runtime.actions.requestCode({ account: "a@b.c" })).status, "code-sent");
  assert.equal((await runtime.actions.cancelCode()).status, "success");
  const result = await runtime.actions.login({ code: "123456" });
  assert.equal(result.status, "failed");
  assert.match(result.message, /验证码流程已失效/);
});

test("clicking a monitor key cycles its view", async () => {
  const { runtime, host } = makeRuntime();
  await runtime.start();
  host.handlers.get("plugin.alive")({ serialNumber: "SN", keys: keys() });

  await host.handlers.get("plugin.data")({ serialNumber: "SN", data: { evt: "click", key: { ...keys()[0] } } });
  const status = await host.handlers.get("ui.message")({ action: "status" });
  assert.deepEqual(status.views, [{ uid: 1, view: "temperature" }]);

  await host.handlers.get("plugin.data")({ serialNumber: "SN", data: { evt: "click", key: { ...keys()[0] } } });
  const status2 = await host.handlers.get("ui.message")({ action: "status" });
  assert.deepEqual(status2.views, [{ uid: 1, view: "task" }]);
});

test("keys on disconnected devices are forgotten", async () => {
  const { runtime, host } = makeRuntime();
  await runtime.start();
  host.handlers.get("plugin.alive")({ serialNumber: "SN", keys: keys() });
  host.handlers.get("device.status")([{ serialNumber: "OTHER", status: "connected" }]);
  const status = await host.handlers.get("ui.message")({ action: "status" });
  assert.deepEqual(status.views, []);
});

test("config updates from the host are re-read without crashing", async () => {
  const host = makePlugin({ config: { region: "global", printerId: "", printerName: "" } });
  const { runtime } = makeRuntime({ plugin: host });
  await runtime.start();

  // 宿主在配置页保存后写入新配置，再发 config.updated 事件。
  await host.setConfig({ region: "china", printerId: "D9", printerName: "A1" });
  host.handlers.get("plugin.config.updated")({});
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(runtime.config.region, "china");
  assert.equal(runtime.config.printerId, "D9");
});

test("region fallback is applied but not silently treated as a valid choice", async () => {
  const { runtime } = makeRuntime({ config: { region: "eu", printerId: "", printerName: "" } });
  await runtime.start();
  assert.equal(runtime.config.region, "global");
});

test("config reads retry while the host websocket is still connecting", async () => {
  const host = makePlugin({ config: { region: "china", printerId: "D7", printerName: "A1 mini" } });
  let calls = 0;
  const original = host.getConfig.bind(host);
  host.getConfig = async () => {
    calls += 1;
    if (calls < 3) throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
    return original();
  };

  const { runtime } = makeRuntime({ plugin: host });
  await runtime.start();

  assert.equal(calls, 3);
  assert.equal(runtime.config.region, "china");
  assert.equal(runtime.config.printerId, "D7");
});

test("a permanently broken config read logs once and keeps defaults", async () => {
  const host = makePlugin();
  host.getConfig = async () => {
    throw new Error("host gone");
  };
  const { runtime, logs } = makeRuntime({ plugin: host });
  await runtime.start();
  assert.equal(runtime.config.region, "global");
  assert.ok(logs.errors.some((line) => line.includes("读取插件配置失败")));
});

test("temperature and task views work while idle, not just while printing", async () => {
  const { runtime, host, mqtt } = makeRuntime();
  await runtime.start();
  host.handlers.get("plugin.alive")({ serialNumber: "SN", keys: keys() });
  await host.handlers.get("ui.message")({ action: "login", account: "a@b.c", password: "pw" });

  mqtt[0].pushStatus({ state: CONNECTION_STATES.connected, attempt: 0, lastError: null, subscribed: true });
  mqtt[0].pushReport({
    raw: {
      gcode_state: "IDLE",
      nozzle_temper: 210.6,
      nozzle_target_temper: 220,
      bed_temper: 60.2,
      bed_target_temper: 60,
      subtask_name: "benchy",
      layer_num: 3,
      total_layer_num: 12,
    },
    receivedAt: 9000,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  // 切到温度视图（第二次点击）
  await host.handlers.get("plugin.data")({ serialNumber: "SN", data: { evt: "click", key: { ...keys()[0] } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const temp = host.draws.at(-1).title;
  assert.match(temp, /喷嘴 211℃/);
  assert.match(temp, /热床 60℃/);

  // 切到任务视图（第三次点击）
  await host.handlers.get("plugin.data")({ serialNumber: "SN", data: { evt: "click", key: { ...keys()[0] } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const task = host.draws.at(-1).title;
  assert.match(task, /benchy/);
  assert.match(task, /3\/12 层/);
});

test("temperature and task views do not display stale fields as live", async () => {
  const { runtime, host, mqtt } = makeRuntime();
  await runtime.start();
  host.handlers.get("plugin.alive")({ serialNumber: "SN", keys: keys() });
  await runtime.actions.login({ account: "a@b.c", password: "pw" });
  mqtt[0].pushStatus({ state: CONNECTION_STATES.connected, subscribed: true });
  mqtt[0].pushReport({ raw: { gcode_state: "IDLE", nozzle_temper: 210, subtask_name: "old" }, receivedAt: -400000 });
  mqtt[0].pushReport({ raw: { gcode_state: "IDLE" }, receivedAt: 9000 });
  await host.handlers.get("plugin.data")({ serialNumber: "SN", data: { evt: "click", key: { ...keys()[0] } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(host.draws.at(-1).title, /数据已过期/);
  await host.handlers.get("plugin.data")({ serialNumber: "SN", data: { evt: "click", key: { ...keys()[0] } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(host.draws.at(-1).title, /数据已过期/);
});

test("before the first report the key shows the waiting prompt in every view", async () => {
  const { runtime, host, mqtt } = makeRuntime();
  await runtime.start();
  host.handlers.get("plugin.alive")({ serialNumber: "SN", keys: keys() });
  await host.handlers.get("ui.message")({ action: "login", account: "a@b.c", password: "pw" });
  mqtt[0].pushStatus({ state: CONNECTION_STATES.connected, attempt: 0, lastError: null, subscribed: true });
  await new Promise((resolve) => setTimeout(resolve, 10));

  for (let i = 0; i < 3; i += 1) {
    await host.handlers.get("plugin.data")({ serialNumber: "SN", data: { evt: "click", key: { ...keys()[0] } } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(host.draws.at(-1).title, /等待打印机状态/);
  }
});

test("a 401 while listing devices moves the session to expired", async () => {
  const { runtime, host, mqtt } = makeRuntime({
    apiOverrides: {
      fetchDevices: async () => {
        throw Object.assign(new Error("登录已失效，请重新登录"), { kind: "unauthorized" });
      },
    },
  });
  await runtime.start();
  host.handlers.get("plugin.alive")({ serialNumber: "SN", keys: keys() });

  const login = await host.handlers.get("ui.message")({ action: "login", account: "a@b.c", password: "pw" });
  assert.equal(login.status, "success");
  // 设备列表失败且是 401：要求重新登录，不能继续用旧令牌
  assert.equal(runtime.auth.state, "expired");
  assert.equal(runtime.auth.getAccessToken(), null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(host.draws.at(-1).title, /登录已失效/);
  assert.equal(mqtt.length, 0);
});

test("admin controller is attached for status and openAdmin", async () => {
  const { runtime } = makeRuntime();
  let openCalls = 0;
  let stopCalls = 0;
  const admin = {
    info: () => ({ available: true, running: true, port: 4321, startedAt: 1, backend: "local-http" }),
    open: async () => {
      openCalls += 1;
      return { status: "success", opened: true, url: "http://127.0.0.1:4321/#token=x" };
    },
    stop: async () => {
      stopCalls += 1;
    },
  };

  runtime.attachAdmin(admin);
  const status = await runtime.actions.status();
  assert.equal(status.admin.port, 4321);
  assert.equal(status.display.tone, "muted");
  assert.match(status.display.title, /请登录/);
  assert.ok(!JSON.stringify(status).includes("token"));

  const opened = await runtime.actions.openAdmin();
  assert.equal(opened.opened, true);
  assert.equal(openCalls, 1);

  await runtime.shutdown();
  assert.equal(stopCalls, 1);
});

test("openAdmin reports a missing controller instead of throwing", async () => {
  const { runtime } = makeRuntime();
  const result = await runtime.actions.openAdmin();
  assert.equal(result.status, "error");
  assert.match(result.message, /未初始化/);
});

test("requestCode that logs in directly also refreshes devices and starts monitoring", async () => {
  const { runtime, mqtt } = makeRuntime({
    apiOverrides: {
      requestEmailCode: async () => ({
        codeSent: false,
        login: { accessToken: "tok", refreshToken: "", expiresInSeconds: 3600, loginType: "" },
      }),
    },
  });
  await runtime.start();

  const result = await runtime.actions.requestCode({ account: "a@b.c" });
  assert.equal(result.status, "success");
  assert.equal(runtime.devices.length, 1);
  assert.equal(runtime.config.printerId, "DEV1");
  assert.equal(mqtt.length, 1);
  assert.equal(mqtt[0].options.deviceId, "DEV1");
});

test("failed configuration writes do not change runtime or active monitor", async () => {
  const host = makePlugin();
  const { runtime, mqtt } = makeRuntime({ plugin: host });
  await runtime.start();
  await runtime.actions.login({ account: "a@b.c", password: "pw" });
  host.setConfig = async () => { throw new Error("write failed"); };
  assert.equal((await runtime.actions.setPrinter({ printerId: "OTHER" })).status, "error");
  assert.equal((await runtime.actions.setRegion({ region: "china" })).status, "error");
  assert.equal(runtime.config.printerId, "DEV1");
  assert.equal(runtime.config.region, "global");
  assert.equal(runtime.auth.state, "signed-in");
  assert.equal(mqtt[0].stopped, false);
});

test("configuration changes are saved and applied in request order", async () => {
  const host = makePlugin();
  const originalSet = host.setConfig;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  host.setConfig = async (next) => {
    writes += 1;
    if (writes === 1) await blocked;
    return originalSet(next);
  };
  const { runtime } = makeRuntime({ plugin: host });
  await runtime.start();
  const first = runtime.actions.setPrinter({ printerId: "A" });
  const second = runtime.actions.setRegion({ region: "china" });
  await Promise.resolve();
  assert.equal(writes, 1);
  release();
  assert.equal((await first).status, "success");
  assert.equal((await second).status, "success");
  assert.equal(runtime.config.printerId, "A");
  assert.equal(runtime.config.region, "china");
  assert.deepEqual(host.savedConfigs.at(-1), runtime.config);
});
