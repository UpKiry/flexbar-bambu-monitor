const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function page(fetch) {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: "", textContent: "", hidden: id === "service-warning", disabled: false, readOnly: false,
      dataset: {}, children: [], appendChild(child) { this.children.push(child); },
      removeChild() { this.children.shift(); }, get firstChild() { return this.children[0]; },
      focus() {}, addEventListener() {},
    });
    return nodes.get(id);
  }
  const document = { getElementById: node, createElement: () => ({ value: "", textContent: "", dataset: {}, style: {}, children: [], setAttribute() {}, appendChild(child) { this.children.push(child); } }), addEventListener() {}, hidden: false };
  const context = { document, fetch, URL, URLSearchParams, location: { hash: "", pathname: "/", search: "" }, history: {}, sessionStorage: {}, window: {}, navigator: {}, setInterval, clearInterval, setTimeout, Date, console };
  const file = path.join(__dirname, "../com.upkiry.bambumonitor.plugin/resources/admin/app.js");
  const source = fs.readFileSync(file, "utf8").replace("  init();\n})();", "  globalThis.page = { state, loadStatus, loadDiagnostics, handleActionResult, renderStatus, diagnosticExport, runAction };\n})();");
  vm.runInNewContext(source, context);
  context.page.state.token = "token";
  return { ...context.page, node };
}
const ok = (data) => ({ status: 200, ok: true, json: async () => data });
const status = (overrides = {}) => ({ auth: { state: "signed-out" }, config: { region: "china" }, devices: [], ...overrides });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("设备操作按钮清楚区分更新列表与检查连接", () => {
  const html = fs.readFileSync(path.join(__dirname, "../com.upkiry.bambumonitor.plugin/resources/admin/index.html"), "utf8");
  assert.match(html, /id="refresh-devices-btn"[^>]*title="[^"]*重新读取账号绑定的打印机列表[^"]*">更新设备列表/);
  assert.match(html, /id="test-connection-btn"[^>]*title="[^"]*验证当前账号能否读取绑定的打印机列表[^"]*">验证云端访问/);
});

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
  assert.match(items[0].children[1].textContent, /<unit>.*耗材：存在.*<PLA>.*余量：0%/);
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
  ui.handleActionResult("requestFullState", { sent: false, reason: "cooldown", retryInMs: 1500 });
  assert.match(ui.node("message").textContent, /2 秒后重试/);
  ui.handleActionResult("requestFullState", { sent: false, reason: "not-connected" });
  assert.match(ui.node("message").textContent, /未连接云端/);
});
