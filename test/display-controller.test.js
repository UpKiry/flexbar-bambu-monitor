const test = require("node:test");
const assert = require("node:assert/strict");
const { createDisplayController } = require("../src/display/display-controller");

const KEY_CID = "com.upkiry.bambumonitor.monitor";

function makeKey(overrides = {}) {
  return { cid: KEY_CID, uid: 1, width: 240, style: {}, data: { view: "progress" }, title: "", ...overrides };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeController({
  now = () => 1000,
  drawKeyFn = async () => {},
  drawDashboardFn = async () => {},
  createCanvas = () => ({}),
  printers = { D1: { name: "一号", model: "X1 Carbon", blocked: "" } },
  requestFullState = () => ({ sent: true }),
  displayFor = (view) => ({ tone: "normal", title: `title-${view}`, subtitle: "", icon: "printer-3d", stale: false }),
} = {}) {
  const keyDraws = [];
  const dashboardDraws = [];
  const logs = { errors: [], warns: [], infos: [] };
  const changes = [];
  const feedbackCalls = [];
  const controller = createDisplayController({
    plugin: {},
    now,
    createCanvas,
    drawKeyFn: async (plugin, serialNumber, key, display, options) => {
      keyDraws.push({ serialNumber, uid: key.uid, display, options });
      return drawKeyFn(plugin, serialNumber, key, display, options);
    },
    drawDashboardFn: async (input) => {
      dashboardDraws.push(input);
      return drawDashboardFn(input);
    },
    resolvePrinterId: (key) => key?.data?.printerId || "D1",
    buildKeyDisplay: (view) => displayFor(view),
    buildDashboardInput: (printerId) => ({
      state: printers[printerId] || null,
      link: { state: "connected" },
      signedIn: true,
      authExpired: false,
      printerName: printers[printerId]?.name || "",
      model: printers[printerId]?.model || null,
    }),
    inspectPrinter: (printerId) => ({ blocked: printers[printerId]?.blocked || "" }),
    requestFullState: (printerId) => {
      feedbackCalls.push(printerId);
      return requestFullState(printerId);
    },
    onKeyDevicesChanged: () => changes.push(true),
    logError: (message) => logs.errors.push(String(message)),
    logWarn: (message) => logs.warns.push(String(message)),
    logInfo: (message) => logs.infos.push(String(message)),
  });
  return { controller, keyDraws, dashboardDraws, logs, changes, feedbackCalls };
}

test("普通按键与 Direct Draw 互不覆盖", async () => {
  const { controller, keyDraws, dashboardDraws } = makeController();
  controller.handleAlive({ serialNumber: "SN", keys: [makeKey()] });
  await flush();
  assert.equal(keyDraws.length, 1);
  assert.equal(dashboardDraws.length, 0);

  controller.handleAlive({ serialNumber: "SN", keys: [makeKey({ cfg: { keyType: "directDraw" } })] });
  await flush();
  assert.equal(dashboardDraws.length, 1, "Direct Draw 会话被激活后应绘制详情页");
  const keyDrawsBefore = keyDraws.length;
  await controller.renderAll({ urgent: true });
  assert.equal(keyDraws.length, keyDrawsBefore, "同一屏幕上已有 Direct Draw 时普通绘制必须让位");
});

test("相同 uid 在不同 Flexbar 上是独立按键，视图轮换互不影响", async () => {
  const { controller } = makeController();
  controller.handleAlive({ serialNumber: "SN1", keys: [makeKey({ uid: 7 })] });
  controller.handleAlive({ serialNumber: "SN2", keys: [makeKey({ uid: 7 })] });
  controller.handleData({ serialNumber: "SN1", data: { key: makeKey({ uid: 7 }) } });
  assert.deepEqual(controller.listViews(), [
    { uid: 7, view: "temperature", serialNumber: "SN1" },
    { uid: 7, view: "progress", serialNumber: "SN2" },
  ]);
});

test("按键配置里的视图优先于内存状态", () => {
  const { controller } = makeController();
  controller.handleAlive({ serialNumber: "SN", keys: [makeKey({ data: { view: "task" } })] });
  assert.deepEqual(controller.listViews(), [{ uid: 1, view: "task", serialNumber: "SN" }]);
  controller.handleAlive({ serialNumber: "SN", keys: [makeKey({ data: { view: "unknown" } })] });
  assert.deepEqual(controller.listViews(), [{ uid: 1, view: "task", serialNumber: "SN" }], "未知视图不覆盖已保存视图");
});

test("绘制异常被归类为固定上下文，不泄漏宿主回显文本", async () => {
  const { controller, logs } = makeController();
  controller.handleAlive({ serialNumber: "SN", keys: [makeKey({ cfg: { keyType: "directDraw" } })] });
  controller.handleTouch({ serialNumber: "SN", state: "down" });
  await flush();
  const failing = makeController({
    drawDashboardFn: async () => { throw new Error("Request failed: device secret-token, Command: directDraw"); },
  });
  failing.controller.handleAlive({ serialNumber: "SN", keys: [makeKey({ cfg: { keyType: "directDraw" } })] });
  await flush();
  assert.ok(failing.logs.errors.some((message) => message.startsWith("绘制详情页失败：宿主拒绝请求")));
  assert.ok(failing.logs.errors.every((message) => !message.includes("secret-token")));
});

test("触摸反馈窗口内合并重复事件，到期后恢复操作", async () => {
  let time = 5000;
  const requests = [];
  const { controller, dashboardDraws } = makeController({
    now: () => time,
    requestFullState: () => { requests.push(time); return { sent: true }; },
  });
  controller.handleAlive({ serialNumber: "SN", keys: [makeKey({ cfg: { keyType: "directDraw" } })] });
  await flush();

  controller.handleTouch({ serialNumber: "SN", state: "down" });
  assert.equal(requests.length, 1);
  controller.handleTouch({ serialNumber: "SN", state: "down" });
  assert.equal(requests.length, 1, "窗口内重复触摸不重复请求");
  await flush();
  assert.equal(dashboardDraws.at(-1).feedback.text, "已请求完整状态，等待设备上报");

  time += 1799;
  controller.handleTouch({ serialNumber: "SN", state: "down" });
  assert.equal(requests.length, 1, "窗口边界内仍合并");

  time += 1;
  await controller.renderAll({ urgent: true });
  assert.equal(dashboardDraws.at(-1).feedback, null, "窗口到期后反馈消失");

  controller.handleTouch({ serialNumber: "SN", state: "down" });
  assert.equal(requests.length, 2, "窗口结束后允许再次请求");
});

test("窗口跨绘制会话替换仍生效，页面退出与设备断开清理反馈", async () => {
  const requests = [];
  const { controller, dashboardDraws } = makeController({
    requestFullState: () => { requests.push(1); return { sent: true }; },
  });
  const directKey = makeKey({ cfg: { keyType: "directDraw" } });
  controller.handleAlive({ serialNumber: "SN", keys: [directKey] });
  await flush();
  controller.handleTouch({ serialNumber: "SN", state: "down" });
  assert.equal(requests.length, 1);

  controller.handleData({ serialNumber: "SN", data: { key: { ...directKey } } });
  controller.handleTouch({ serialNumber: "SN", state: "down" });
  assert.equal(requests.length, 1, "会话被替换后窗口仍应合并重复触摸");

  controller.handleDead({ serialNumber: "SN", keys: [directKey] });
  controller.handleAlive({ serialNumber: "SN", keys: [directKey] });
  await flush();
  assert.equal(dashboardDraws.at(-1).feedback, null, "退出重进应清理反馈");
  controller.handleTouch({ serialNumber: "SN", state: "down" });
  assert.equal(requests.length, 2);

  controller.handleDeviceStatus([{ serialNumber: "SN", status: "disconnected" }]);
  controller.handleAlive({ serialNumber: "SN", keys: [directKey] });
  await flush();
  assert.equal(dashboardDraws.at(-1).feedback, null, "设备断开后重连应清理反馈");
});

test("前置状态阻塞时不请求完整状态，也不显示反馈", async () => {
  const printers = { D1: { blocked: "所选设备不在当前账号的设备列表中" } };
  const { controller, feedbackCalls, logs } = makeController({ printers });
  controller.handleAlive({ serialNumber: "SN", keys: [makeKey({ cfg: { keyType: "directDraw" } })] });
  await flush();
  controller.handleTouch({ serialNumber: "SN", state: "down" });
  assert.equal(feedbackCalls.length, 0);
  assert.ok(logs.warns.some((message) => message.includes("触摸屏幕未请求完整状态")));
});

test("冷却与断连给出可操作反馈，提交失败也算一次尝试", async () => {
  let result = { sent: false, reason: "cooldown", retryInMs: 3200 };
  const { controller, dashboardDraws } = makeController({ requestFullState: () => result });
  controller.handleAlive({ serialNumber: "SN", keys: [makeKey({ cfg: { keyType: "directDraw" } })] });
  await flush();
  controller.handleTouch({ serialNumber: "SN", state: "down" });
  await flush();
  assert.equal(dashboardDraws.at(-1).feedback.text, "请稍候 4 秒再请求");
  assert.equal(dashboardDraws.at(-1).feedback.level, "warning");

  result = { sent: false, reason: "not-connected" };
  controller.handleData({ serialNumber: "SN", data: { key: makeKey({ cfg: { keyType: "directDraw" }, uid: 2 }) } });
  controller.handleTouch({ serialNumber: "SN", state: "down" });
  await flush();
  assert.equal(dashboardDraws.at(-1).feedback.text, "云端未连接，无法请求状态");
});

test("dispose 后进行中的绘制不得再写回会话，也不发起新帧", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let sessions = 0;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const controller = createDisplayController({
    plugin: {},
    now: () => 1000,
    createCanvas: () => ({}),
    drawKeyFn: async () => {},
    drawDashboardFn: async () => { sessions += 1; began(); await pending; },
    resolvePrinterId: () => "D1",
    buildKeyDisplay: () => ({}),
    buildDashboardInput: () => ({ state: null, link: { state: "connected" }, signedIn: true }),
    inspectPrinter: () => ({}),
    requestFullState: () => ({ sent: true }),
  });
  controller.handleAlive({ serialNumber: "SN", keys: [makeKey({ cfg: { keyType: "directDraw" } })] });
  await started;
  assert.equal(sessions, 1, "首帧已开始绘制");
  controller.dispose();
  release();
  await flush();
  assert.equal(sessions, 1, "销毁后不得再发起绘制");
  controller.handleTouch({ serialNumber: "SN", state: "down" });
  await flush();
  assert.equal(sessions, 1, "销毁后触摸不产生新帧");
});

test("按键引用的设备集合变化会通知连接编排", () => {
  const { controller, changes } = makeController();
  controller.handleAlive({ serialNumber: "SN", keys: [makeKey()] });
  controller.handleData({ serialNumber: "SN", data: { key: makeKey() } });
  controller.handleDeviceStatus([]);
  assert.equal(changes.length >= 3, true);
  assert.deepEqual([...controller.selectedPrinterIds()], [], "断开后不再引用设备");
});
