const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/admin/client/main");
const { getPrinterCapabilities } = require("../src/printer/capabilities");

function makeDom() {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: "", textContent: "", hidden: id === "service-warning", disabled: false, readOnly: false,
      dataset: {}, children: [], style: {},
      appendChild(child) { this.children.push(child); },
      removeChild() { this.children.shift(); },
      get firstChild() { return this.children[0]; },
      focus() {}, addEventListener() {}, setAttribute(key, value) { this[key] = value; },
    });
    return nodes.get(id);
  }
  const document = {
    getElementById: node,
    createElement: (tag) => ({
      tag, value: "", textContent: "", dataset: {}, style: {}, children: [], open: false,
      setAttribute(key, value) { this[key] = value; },
      appendChild(child) { this.children.push(child); },
    }),
    addEventListener() {},
    hidden: false,
  };
  return { document, node };
}

/** 用模块接口构造后台应用，替代过去对打包产物的源码替换。 */
function page(fetchFn, { hash = "", stored = "" } = {}) {
  const { document, node } = makeDom();
  const storage = {
    value: stored,
    getItem() { return this.value; },
    setItem(_key, value) { this.value = value; },
    removeItem() { this.value = ""; },
  };
  const app = createApp({
    document,
    location: { hash, pathname: "/", search: "" },
    history: { replaceState() {} },
    storage,
    fetchFn,
  });
  app.state.token = app.state.token || "token";
  return {
    ...app,
    node,
    renderStatus(data) {
      // 模拟 runtime 每次状态响应都会按当前机型和状态重算能力。
      if (data.printer) {
        data.printer.capabilities = getPrinterCapabilities(
          data.devices?.find((device) => device.id === data.config?.printerId)?.model,
          data.printer.state,
        );
      }
      app.renderStatus(data);
    },
  };
}
const ok = (data) => ({ status: 200, ok: true, json: async () => data });
const status = (overrides = {}) => ({ auth: { state: "signed-out" }, config: { region: "china" }, devices: [], ...overrides });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("验证码流程锁定区域账号，取消失败保持锁定，成功后解除", async () => {
  let cancelStatus = "error";
  const calls = [];
  const ui = page(async (url, opts) => {
    if (url === "/api/action") {
      calls.push(JSON.parse(opts.body));
      return ok({ result: { status: cancelStatus } });
    }
    return ok(url === "/api/status" ? status() : {});
  });
  ui.state.status = status();
  ui.renderStatus(ui.state.status);
  ui.handleActionResult("requestCode", { status: "code-sent", message: "邮箱" });
  assert.equal(ui.node("code-label").textContent, "短信验证码");
  assert.match(ui.node("message").textContent, /短信/);
  assert.equal(ui.node("account-input").readOnly, true);
  assert.equal(ui.node("region-select").disabled, true);
  await ui.runAction("cancelCode");
  assert.equal(ui.state.awaitingCode, true);
  cancelStatus = "success";
  ui.node("code-input").value = "123456";
  await ui.runAction("cancelCode");
  assert.equal(ui.node("account-input").readOnly, false);
  assert.equal(ui.node("region-select").disabled, false);
  assert.equal(ui.node("code-input").value, "");
  assert.deepEqual(calls.map((x) => x.action), ["cancelCode", "cancelCode"]);
  ui.state.status = status({ config: { region: "global" } });
  ui.renderStatus(ui.state.status);
  ui.handleActionResult("login", { status: "code-required" });
  assert.equal(ui.node("code-label").textContent, "邮箱验证码");
});

test("设备验证受阻时显示具体原因", () => {
  const ui = page(async () => ok({}));
  const data = status({ auth: { state: "signed-in" }, config: { printerId: "x" }, devices: [{ id: "y" }], monitorBlockMessage: "所选设备不在当前账号的设备列表中" });
  ui.renderStatus(data);
  assert.equal(ui.node("device-hint").textContent, data.monitorBlockMessage);
});

test("设备列表同 ID 的名称、机型、在线状态变化会刷新", () => {
  const ui = page(async () => ok({}));
  const data = status({ auth: { state: "signed-in" }, devices: [{ id: "x", name: "旧名称", model: "A", online: true }] });
  ui.renderStatus(data);
  data.devices = [{ id: "x", name: "新名称", model: "B", online: false }];
  ui.renderStatus(data);
  assert.match(ui.node("printer-select").children[1].textContent, /新名称 · B（离线）/);
});

test("轮询同类请求不并发，两次失败提示并在成功后恢复", async () => {
  let rejectRequest;
  let calls = 0;
  let next = () => new Promise((resolve, reject) => { rejectRequest = reject; });
  const ui = page(() => { calls += 1; return next(); });
  const first = ui.loadStatus({ silent: true });
  const duplicate = ui.loadStatus({ silent: true });
  assert.equal(calls, 1);
  rejectRequest(new Error("offline"));
  await Promise.all([first, duplicate]);
  assert.equal(ui.node("service-warning").hidden, true);
  next = async () => { throw new Error("offline"); };
  await ui.loadStatus({ silent: true });
  assert.match(ui.node("service-warning").textContent, /无法连接本地服务/);
  assert.match(ui.node("service-warning").textContent, /尚未成功读取状态/);
  next = async () => ok(status());
  await ui.loadStatus({ silent: true });
  assert.equal(ui.node("service-warning").hidden, true);
  assert.match(ui.node("message").textContent, /已恢复/);
  next = async () => { throw new Error("offline"); };
  await ui.loadStatus({ silent: true });
  await ui.loadStatus({ silent: true });
  assert.match(ui.node("service-warning").textContent, /最后成功更新/);
});

test("操作后的状态刷新等待旧轮询并忽略其结果", async () => {
  let resolveOld;
  let statusCalls = 0;
  const ui = page((url) => {
    if (url === "/api/action") return Promise.resolve(ok({ result: { status: "success" } }));
    if (url === "/api/diagnostics") return Promise.resolve(ok({}));
    statusCalls += 1;
    if (statusCalls === 1) return new Promise((resolve) => { resolveOld = resolve; });
    return Promise.resolve(ok(status({ config: { region: "global" } })));
  });
  const old = ui.loadStatus({ silent: true });
  const action = ui.runAction("cancelCode");
  await tick();
  assert.equal(statusCalls, 1);
  resolveOld(ok(status()));
  await Promise.all([old, action]);
  assert.equal(statusCalls, 2);
  assert.equal(ui.state.status.config.region, "global");
});

test("诊断导出仅包含白名单，排除任意标识和文本", () => {
  const ui = page(async () => ok({}));
  ui.state.status = status({ auth: { state: "signed-in", userId: "private-user" }, devices: [{ id: "private-device" }], config: { region: "china", printerId: "private-device" }, printer: { state: { taskName: "private-task", lastReportAt: 12 }, link: { lastError: { message: "private-error" } } }, display: { title: "private-task" } });
  ui.state.diagnostics = { logs: [{ message: "private-log" }], requests: [{ path: "/private-device", kind: "private-kind", method: "GET", status: 200, durationMs: 42 }, { kind: "network" }] };
  const text = JSON.stringify(ui.diagnosticExport());
  assert.doesNotMatch(text, /private-/);
  assert.match(text, /"durationMs":42/);
  assert.match(text, /"kind":"network"/);
});

test("只读状态展示 AMS、任务层数和原始故障并安全处理未知值", () => {
  const ui = page(async () => ok({}));
  const data = status({ auth: { state: "signed-in" }, config: { printerId: "x" }, devices: [{ id: "x" }], printer: {
    link: { state: "reconnecting" }, state: {
      lastReportAt: Date.now(), activity: "unknown", rawActivity: "NEW_STATE", taskName: "<img>", layerNum: 0, totalLayerNum: 20,
      hms: [{ code: "<script>", attr: "7", module: null }], errorCode: "E123",
      ams: { current: { unitId: "0", slotId: "0" }, rawStatus: 3, units: [{ id: "0", slots: [
        { id: "0", color: "FF0011FF", material: "<PLA>", remaining: 0, rawState: 0 },
        { id: "1", color: "red;display:none", material: null, remaining: -1, rawState: null },
      ] }] },
    },
  } });
  ui.renderStatus(data);
  assert.match(ui.node("activity").textContent, /未知（原始值 NEW_STATE）.*更新时间未知/);
  assert.match(ui.node("task-name").textContent, /<img>.*更新时间未知/);
  assert.match(ui.node("layer-text").textContent, /0（更新时间未知） \/ 20（更新时间未知）/);
  assert.match(ui.node("report-freshness").textContent, /旧数据/);
  assert.match(ui.node("hms-list").children[0].textContent, /<script>/);
  const items = ui.node("ams-list").children;
  assert.match(items[0].textContent, /状态原始值：3/);
  assert.equal(items[1].children[0].style.backgroundColor, "#FF0011FF");
  assert.match(items[1].children[1].textContent, /当前.*<PLA>.*余量：0%.*状态原始值：0/);
  assert.match(items[2].children[0].textContent, /颜色：未知.*余量：未知.*状态原始值：未知/);
  data.printer.link.state = "connected";
  data.printer.state.reportStale = true;
  ui.renderStatus(data);
  assert.match(ui.node("report-freshness").textContent, /旧数据/);
  data.printer.state.reportStale = false;
  ui.renderStatus(data);
  assert.match(ui.node("report-freshness").textContent, /较早的数据/);
  data.printer.state.lastReportAt = Date.now() - 6 * 60 * 1000;
  ui.renderStatus(data);
  assert.match(ui.node("report-freshness").textContent, /超过 5 分钟未收到设备报文.*更早的数据/);
  assert.doesNotMatch(ui.node("report-freshness").textContent, /离线/);
  data.printer.state.ams = null;
  data.printer.state.hms = null;
  data.printer.state.lastReportAt = null;
  ui.renderStatus(data);
  assert.equal(ui.node("ams-list").children.length, 0);
  assert.match(ui.node("ams-empty").textContent, /尚无/);
  assert.match(ui.node("hms-empty").textContent, /未知/);
  assert.match(ui.node("report-freshness").textContent, /尚未收到/);
});

test("AMS 显式未知列表和空列表分开显示，其他状态保留", () => {
  const ui = page(async () => ok({}));
  const data = status({ auth: { state: "signed-in" }, config: { printerId: "x" }, printer: {
    link: { state: "connected" }, state: { ams: { units: null, rawStatus: 7, rawTrayNow: "0", current: { unitId: "0", slotId: "0" } } },
  } });
  ui.renderStatus(data);
  assert.equal(ui.node("ams-empty").textContent, "AMS 列表未知");
  assert.match(ui.node("ams-list").children[0].textContent, /状态原始值：7/);
  assert.match(ui.node("ams-list").children[1].textContent, /当前耗材原始值：0/);
  assert.doesNotMatch(ui.node("ams-list").children.map((item) => item.textContent).join(" "), /空槽/);
  data.printer.state.ams.units = [{ id: "0", slots: null }, { id: "1", slots: [] }];
  ui.renderStatus(data);
  const items = ui.node("ams-list").children;
  assert.match(items[1].textContent, /AMS 0.*槽位信息未知/);
  assert.match(items[2].textContent, /AMS 1.*已上报空槽位列表/);
  data.printer.state.ams.units[0].slots = [{ id: "0", material: "PLA", remaining: 0 }];
  ui.renderStatus(data);
  assert.match(ui.node("ams-list").children[1].children[0].textContent, /PLA.*余量：0%/);
  data.printer.state.ams.units = [];
  ui.renderStatus(data);
  assert.equal(ui.node("ams-empty").textContent, "已上报空 AMS 列表");
});

test("AMS 耗材存在、空槽及未知分开显示，空槽不暴露旧数据", () => {
  const ui = page(async () => ok({}));
  const data = status({ auth: { state: "signed-in" }, config: { printerId: "x" }, printer: {
    link: { state: "connected" }, state: { ams: { units: [{ id: "<unit>", slots: [
      { id: "0", exists: true, color: "FF0011FF", material: "<PLA>", remaining: 0 },
      { id: "1", exists: false, color: "ABCDEF00", material: "OLD_MATERIAL", remaining: 78, rawState: "OLD_STATE" },
      { id: "2", exists: null, material: "<unknown>" },
      { id: "3" },
    ] }] }, freshness: { ams: { units: { "<unit>": { slots: { "1": { exists: { at: Date.now(), stale: false } } } } } } } },
  } });
  ui.renderStatus(data);
  let items = ui.node("ams-list").children;
  assert.equal(items[0].children[0].style.backgroundColor, "#FF0011FF");
  assert.match(items[0].children[1].textContent, /<unit>.*耗材：存在.*<PLA>/);
  assert.equal(items[1].children.length, 1);
  assert.match(items[1].children[0].textContent, /耗材：空槽/);
  assert.doesNotMatch(items[1].children[0].textContent, /OLD_|ABCDEF|78|材质|颜色|余量/);
  assert.match(items[2].children[0].textContent, /耗材：未知.*<unknown>/);
  assert.match(items[3].children[0].textContent, /耗材：未知/);

  // 掩码信息先到，但没有槽位列表时，不能推断为空槽。
  data.printer.state.ams = { units: [{ id: "0", rawTrayExistBits: "1" }] };
  ui.renderStatus(data);
  items = ui.node("ams-list").children;
  assert.equal(items.length, 1);
  assert.match(items[0].textContent, /暂无槽位数据/);
  assert.doesNotMatch(items[0].textContent, /空槽/);
  data.printer.state.ams = { rawTrayExistBits: "1" };
  ui.renderStatus(data);
  assert.equal(ui.node("ams-list").children.length, 0);
  assert.match(ui.node("ams-empty").textContent, /尚无 AMS 数据/);
});

test("旧或未知空槽观察不会隐藏新上报的耗材字段", () => {
  const ui = page(async () => ok({}));
  const now = Date.now();
  const slot = (id) => ({ id, exists: false, color: "FF0011FF", material: "NEW_PLA", remaining: 0, rawState: 7 });
  const data = status({ auth: { state: "signed-in" }, config: { printerId: "x" }, printer: {
    link: { state: "connected" }, state: {
      ams: { units: [{ id: "0", slots: [slot("0"), slot("1"), slot("2"), slot("3"), slot("4"), slot("5"), slot("6")] }] },
      freshness: { ams: { units: { "0": { slots: {
        "0": { exists: { at: now, stale: false } },
        "1": { exists: { at: now, stale: true }, material: { at: now, stale: false } },
        "2": { exists: { at: now - 301000, stale: false }, material: { at: now, stale: false } },
        "3": { exists: { at: now + 60000, stale: false }, material: { at: now, stale: false } },
        "4": { material: { at: now, stale: false } },
        "5": { exists: { at: now }, material: { at: now, stale: false } },
        "6": { exists: { at: String(now), stale: false }, material: { at: now, stale: false } },
      } } } } },
    },
  } });
  ui.renderStatus(data);
  const items = ui.node("ams-list").children;
  assert.equal(items[0].children.length, 1);
  assert.match(items[0].children[0].textContent, /耗材：空槽/);
  assert.doesNotMatch(items[0].children[0].textContent, /NEW_PLA|FF0011FF/);
  for (const item of items.slice(1)) {
    assert.equal(item.children[0].style.backgroundColor, "#FF0011FF");
    assert.match(item.children[1].textContent, /耗材：空槽（(?:旧数据|更新时间未知)）.*材质：NEW_PLA.*余量：0%.*状态原始值：7/);
  }
});

test("按字段及 AMS 槽位时间独立标记旧数据与未知时间", () => {
  const ui = page(async () => ok({}));
  const now = Date.now();
  const fresh = { at: now - 1000, stale: false };
  const old = { at: now - 301000, stale: false };
  const stale = { at: now - 1000, stale: true };
  const data = status({ auth: { state: "signed-in" }, config: { printerId: "x" }, printer: {
    link: { state: "connected" }, state: {
      lastReportAt: now, activity: "printing", progressPercent: 12, remainingMinutes: 7,
      nozzle: { current: 200, target: 210 }, hms: [{ code: "E1" }],
      ams: { units: [{ id: "0", slots: [{ id: "1", exists: true, color: "FF0011FF", material: "PLA", remaining: 0 }] }] },
      freshness: { fields: { activity: fresh, progressPercent: old, remainingMinutes: stale, "nozzle.current": fresh, "nozzle.target": old, hms: stale },
        ams: { units: { "0": { slots: { "1": { exists: fresh, color: old, material: stale } } } } } },
    },
  } });
  ui.renderStatus(data);
  assert.equal(ui.node("activity").textContent, "打印中");
  assert.equal(ui.node("progress-text").textContent, "12%（旧数据）");
  assert.equal(ui.node("remaining-text").textContent, "7 分钟（旧数据）");
  assert.equal(ui.node("nozzle-text").textContent, "200℃ → 210℃（旧数据）");
  assert.match(ui.node("hms-list").children[0].textContent, /E1.*旧数据/);
  const slot = ui.node("ams-list").children[0].children[1].textContent;
  assert.match(slot, /耗材：存在 · 材质：PLA（旧数据） · 颜色：#FF0011FF（旧数据） · 余量：0%（更新时间未知）/);
  data.printer.state.freshness.fields.progressPercent = fresh;
  ui.renderStatus(data);
  assert.equal(ui.node("progress-text").textContent, "12%");
  assert.equal(ui.node("remaining-text").textContent, "7 分钟（旧数据）");
});

test("故障通道分别显示未知、清除、原始值和时效", () => {
  const ui = page(async () => ok({}));
  const now = Date.now();
  const state = { printError: "<old>", printErrorCode: "42", freshness: { fields: {
    printError: { at: now - 1000, stale: true }, printErrorCode: { at: now - 1000, stale: false },
  } } };
  const data = status({ auth: { state: "signed-in" }, config: { region: "china", printerId: "x" }, printer: { link: { state: "connected" }, state } });
  ui.renderStatus(data);
  assert.equal(ui.node("error-code").textContent, "print_error：原始码 <old>（旧数据） · mc_print_error_code：原始码 42");
  state.printError = 0;
  state.printErrorCode = null;
  ui.renderStatus(data);
  assert.equal(ui.node("error-code").textContent, "print_error：已清除（0）（旧数据） · mc_print_error_code：未知");
  delete state.freshness.fields.printError;
  ui.renderStatus(data);
  assert.match(ui.node("error-code").textContent, /已清除（0）（更新时间未知）/);
});

test("完整状态请求区分提交、冷却和断连", () => {
  const ui = page(async () => ok({}));
  ui.handleActionResult("requestFullState", { sent: true });
  assert.match(ui.node("message").textContent, /已提交/);
  ui.handleActionResult("requestFullState", { sent: false, reason: "cooldown", retryInMs: 4200 });
  assert.match(ui.node("message").textContent, /5 秒后重试/);
  ui.handleActionResult("requestFullState", { sent: false, reason: "not-connected" });
  assert.match(ui.node("message").textContent, /未连接云端/);
});

test("风扇卡片保留零值、独立旧数据和未知读数", () => {
  const ui = page(async () => ok({}));
  const at = Date.now();
  ui.renderStatus(status({auth: {state: "signed-in"}, config: {printerId: "x"}, printer: {state: {
    fans: {part: 0, auxiliary: 80, chamber: null, heatbreak: null},
    freshness: {fields: {"fans.part": {at, stale: false}, "fans.auxiliary": {at, stale: true}}},
  }}}));
  assert.equal(ui.node("fan-part").textContent, "0%");
  assert.equal(ui.node("fan-auxiliary").textContent, "80%（旧数据）");
  assert.equal(ui.node("fan-chamber").textContent, "未知");
  assert.equal(ui.node("fan-heatbreak").textContent, "未知");
  ui.renderStatus(status());
  assert.equal(ui.node("fan-part").textContent, "未知");
});

test("A1 热端风扇从有效上报显示百分比，缺失和非法值不刷新，null 或换机后隐藏", () => {
  const { reduceReport, resetForPrinter } = require("../src/printer/state-reducer");
  const ui = page(async () => ok({}));
  const at = Date.now();
  const data = status({auth: {state: "signed-in"}, config: {printerId: "x"},
    devices: [{id: "x", model: "A1"}], printer: {state: resetForPrinter("x")}});
  const report = (raw, receivedAt = at) => {
    data.printer.state = reduceReport(data.printer.state, raw, {receivedAt}).state;
    ui.renderStatus(data);
  };
  ui.renderStatus(data);
  assert.equal(ui.node("sensor-fan-heatbreak").hidden, true);
  report({heatbreak_fan_speed: "8"}, at - 301000);
  assert.equal(ui.node("sensor-fan-heatbreak").hidden, false);
  assert.equal(ui.node("fan-heatbreak").textContent, "53%（旧数据）");
  report({nozzle_temper: 200});
  report({heatbreak_fan_speed: "255"});
  assert.equal(ui.node("fan-heatbreak").textContent, "53%（旧数据）");
  report({heatbreak_fan_speed: "0"});
  assert.equal(ui.node("fan-heatbreak").textContent, "0%");
  report({heatbreak_fan_speed: null});
  assert.equal(ui.node("sensor-fan-heatbreak").hidden, true);
  report({heatbreak_fan_speed: "15"});
  assert.equal(ui.node("fan-heatbreak").textContent, "100%");
  data.config.printerId = "next";
  data.devices = [{id: "next", model: "A1"}];
  data.printer.state = resetForPrinter("next");
  ui.renderStatus(data);
  assert.equal(ui.node("sensor-fan-heatbreak").hidden, true);
});

test("打印机离线与云端断开独立显示，活跃增量保留稳定字段和观测时间", () => {
  const ui = page(async () => ok({}));
  const at = Date.now();
  const data = status({auth: {state: "signed-in"}, config: {printerId: "x"},
    devices: [{id: "x", model: "A1", online: null}], printer: {
      link: {state: "connected"},
      presence: {state: "online", lastMessageAt: at, lastTelemetryAt: at},
      state: {activity: "printing", lastReportAt: at, fans: {heatbreak: 0},
        freshness: {fields: {activity: {at: at - 600000, stale: false}, "fans.heatbreak": {at: at - 600000, stale: false}}}},
    }});
  ui.renderStatus(data);
  assert.equal(ui.node("printer-presence").textContent, "打印机在线");
  assert.equal(ui.node("fan-heatbreak").textContent, "0%");
  assert.equal(ui.node("hero-state").textContent, "打印中");
  assert.equal(data.printer.state.freshness.fields["fans.heatbreak"].at, at - 600000);
  data.printer.presence.state = "offline";
  ui.renderStatus(data);
  assert.equal(ui.node("hero-state").textContent, "打印机离线");
  assert.equal(ui.node("fan-heatbreak").textContent, "0%（旧数据）");
  data.printer.link.state = "reconnecting";
  ui.renderStatus(data);
  assert.match(ui.node("printer-presence").textContent, /云端连接中断.*未知/);
  data.printer.link.state = "connected";
  data.printer.presence.state = "syncing";
  ui.renderStatus(data);
  assert.equal(ui.node("hero-state").textContent, "等待设备同步");
  data.printer.presence.state = "unresponsive";
  ui.renderStatus(data);
  assert.equal(ui.node("hero-state").textContent, "设备无响应");
  data.printer.presence.state = "online";
  data.printer.state.freshness.fields["fans.heatbreak"].stale = true;
  ui.renderStatus(data);
  assert.equal(ui.node("fan-heatbreak").textContent, "0%（旧数据）");
});

test("调试Tab按协议与文本过滤，安全显示报文并保留展开状态", () => {
  const ui = page(async () => ok({}));
  ui.selectTab("debug");
  assert.equal(ui.node("panel-debug").hidden, false);
  assert.equal(ui.node("panel-overview").hidden, true);
  assert.equal(ui.node("tab-debug")["aria-selected"], "true");
  const frames = [
    {id: 2, at: Date.now(), protocol: "mqtt", source: "report", payload: {print: {nozzle_temper: 220, text: "<script>"}}},
    {id: 1, at: Date.now(), protocol: "http", source: "/bind", payload: {devices: []}},
  ];
  ui.renderDiagnostics({frames});
  const list = ui.node("debug-frames");
  assert.equal(list.children.length, 2);
  assert.match(list.children[0].children[1].textContent, /<script>/);
  list.children[0].open = true;
  ui.renderDiagnostics({frames: [{id: 3, protocol: "mqtt"}, ...frames]});
  assert.equal(list.children[1].open, true);
  ui.node("debug-protocol").value = "http";
  ui.renderDebugFrames();
  assert.equal(list.children.length, 1);
  ui.node("debug-search").value = "nozzle_temper";
  ui.renderDebugFrames();
  assert.equal(list.children.length, 0);
  assert.match(ui.node("debug-empty").textContent, /没有匹配/);
  ui.state.debugPaused = true;
  ui.renderDiagnostics({frames: []});
  assert.equal(ui.state.debugFrames.length, 3);
});

test("腔温区分有效读数、零值、旧数据和未知，不借用 AMS 温度", () => {
  const ui = page(async () => ok({}));
  const at = Date.now();
  const data = status({auth: {state: "signed-in"}, config: {printerId: "x"}, printer: {state: {
    chamber: {current: 0}, freshness: {fields: {"chamber.current": {at, stale: false}}},
  }}});
  ui.renderStatus(data);
  assert.equal(ui.node("chamber-text").textContent, "0℃");
  data.printer.state.chamber.current = 35.6;
  data.printer.state.freshness.fields["chamber.current"].stale = true;
  ui.renderStatus(data);
  assert.equal(ui.node("chamber-text").textContent, "36℃（旧数据）");
  data.printer.state.freshness.fields["chamber.current"] = {at: at - 301000, stale: false};
  ui.renderStatus(data);
  assert.match(ui.node("chamber-text").textContent, /旧数据/);
  data.printer.state.chamber.current = null;
  ui.renderStatus(data);
  assert.equal(ui.node("chamber-text").textContent, "未知");
  delete data.printer.state.chamber;
  data.printer.state.ams = {units: [{id: "0", temp: 40}]};
  ui.renderStatus(data);
  assert.equal(ui.node("chamber-text").textContent, "未知");
  ui.state.status = data;
  assert.equal(ui.diagnosticExport().status.printerState.chamber.current, null);
});

test("后台按当前机型隐藏不存在的传感器，切换机型恢复对应行", () => {
  const ui = page(async () => ok({}));
  const data = status({auth: {state: "signed-in"}, config: {printerId: "x"},
    devices: [{id: "x", model: "A1"}], printer: {state: {
      nozzle: {current: 0}, bed: {current: 0}, chamber: {current: 0},
      fans: {part: 0, auxiliary: 0, chamber: 0, heatbreak: 0},
      ams: {units: [{id: "0", slots: [{id: "0", remaining: 50, material: "PLA"}]}]},
    }}});
  ui.renderStatus(data);
  assert.equal(ui.node("sensor-nozzle").hidden, false);
  assert.equal(ui.node("sensor-bed").hidden, false);
  assert.equal(ui.node("sensor-fan-part").hidden, false);
  assert.equal(ui.node("sensor-fan-heatbreak").hidden, false);
  for (const key of ["chamber", "fan-auxiliary", "fan-chamber"])
    assert.equal(ui.node(`sensor-${key}`).hidden, true);
  assert.match(ui.node("ams-list").children[0].children[0].textContent, /AMS lite/);
  assert.doesNotMatch(ui.node("ams-list").children[0].children[0].textContent, /余量/);
  data.devices[0].model = "X1 Carbon";
  ui.renderStatus(data);
  assert.equal(ui.node("sensor-chamber").hidden, false);
  assert.equal(ui.node("sensor-fan-auxiliary").hidden, false);
  assert.match(ui.node("ams-list").children[0].children[0].textContent, /余量：50%/);
  data.printer.state = {};
  data.devices[0].model = "未知新机型";
  ui.renderStatus(data);
  assert.equal(ui.node("temperature-card").hidden, true);
  assert.equal(ui.node("fan-card").hidden, true);
  assert.equal(ui.node("ams-section").hidden, true);
});

test("AMS 按各单元型号独立展示，未知类型不套用已知名称", () => {
  const ui = page(async () => ok({}));
  const data = status({auth: {state: "signed-in"}, config: {printerId: "x"},
    devices: [{id: "x", model: "X1 Carbon"}], printer: {state: {ams: {units:
      ["1", "2", "3", "4", "f"].map((rawInfo, id) => ({id: String(id), rawInfo,
        slots: [{id: "0", material: "PLA", remaining: 0}]}))
    }}}});
  ui.renderStatus(data);
  const texts = ui.node("ams-list").children.map(item => item.children[0].textContent);
  assert.match(texts[0], /AMS 0.*余量：0%/);
  assert.match(texts[1], /AMS lite 1/);
  assert.doesNotMatch(texts[1], /余量/);
  assert.match(texts[2], /AMS 2 Pro 2/);
  assert.match(texts[3], /AMS HT 3/);
  assert.match(texts[4], /AMS 4（类型未知）/);
});

test("AMS 3H shows nine reported slots and separate zone sensors without cabinet readings", () => {
  const ui = page(async () => ok({}));
  const at = Date.now();
  const data = status({auth: {state: "signed-in"}, config: {printerId: "x"},
    devices: [{id: "x", model: "H3C"}], printer: {state: {ams: {units: [{id: "0", model: "AMS 3H", rawInfo: "7",
      temperature: 99, humidity: 99,
      zones: [{id: "0", temperature: 0, humidity: 0, dryingMinutes: 0}, {id: "1", temperature: 45.5, humidity: null}],
      slots: Array.from({length: 9}, (_, id) => ({id: String(id), material: "PLA", remaining: id})),
    }]}, freshness: {ams: {units: {0: {zones: {0: {temperature: {at, stale: false}, humidity: {at, stale: true}, dryingMinutes: {at, stale: false}}}}}}}}}});
  ui.renderStatus(data);
  const items = ui.node("ams-list").children;
  assert.equal(items.length, 11);
  assert.match(items[0].textContent, /AMS 3H 0.*分区 1.*温度：0℃.*湿度：0%（旧数据）/);
  assert.match(items[1].textContent, /分区 2.*温度：46℃/);
  assert.doesNotMatch(items[1].textContent, /湿度/);
  assert.match(items[10].children[0].textContent, /AMS 3H 0.*槽位 8/);
  assert.ok(!items.some(item => item.textContent.includes("99℃")));
  data.printer.state.ams.units[0].zones = null;
  data.printer.state.ams.units[0].slots = [{id: "8", material: "PLA"}];
  ui.renderStatus(data);
  assert.equal(ui.node("ams-list").children.length, 1);
});
