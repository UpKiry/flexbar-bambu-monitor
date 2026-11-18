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
  const document = { getElementById: node, createElement: () => ({ value: "", textContent: "", dataset: {}, children: [], appendChild(child) { this.children.push(child); } }), addEventListener() {}, hidden: false };
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

test("完整状态请求区分提交、冷却和断连", () => {
  const ui = page(async () => ok({}));
  ui.handleActionResult("requestFullState", { sent: true });
  assert.match(ui.node("message").textContent, /已提交/);
  ui.handleActionResult("requestFullState", { sent: false, reason: "cooldown", retryInMs: 1500 });
  assert.match(ui.node("message").textContent, /2 秒后重试/);
  ui.handleActionResult("requestFullState", { sent: false, reason: "not-connected" });
  assert.match(ui.node("message").textContent, /未连接云端/);
});
