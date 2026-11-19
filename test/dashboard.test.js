const test = require("node:test");
const assert = require("node:assert/strict");
const { WIDTH, HEIGHT, buildDashboardModel, renderDashboard, drawDashboard } = require("../src/display/dashboard");

const now = Date.UTC(2026, 0, 1, 12);
const mark = (at = now) => ({ at, stale: false });
function input() {
  return {
    now, link: { state: "connected" }, printerName: "测试设备",
    state: {
      lastReportAt: now, activity: "printing", progressPercent: 0, remainingMinutes: 61,
      nozzle: { current: 0, target: 220 }, bed: { current: 50, target: 60 },
      taskName: "样件", layerNum: 0, totalLayerNum: 100,
      freshness: { fields: Object.fromEntries(["activity", "progressPercent", "remainingMinutes", "nozzle.current", "nozzle.target", "bed.current", "bed.target", "taskName", "layerNum", "totalLayerNum"].map((name) => [name, mark()])) },
    },
  };
}
function fakeCanvas() {
  const calls = [];
  const ctx = {
    save() { calls.push(["save"]); }, restore() { calls.push(["restore"]); },
    scale(...args) { calls.push(["scale", ...args]); }, fillRect(...args) { calls.push(["fillRect", ...args]); },
    fillText(...args) { calls.push(["fillText", ...args]); },
  };
  return { calls, getContext: (kind) => kind === "2d" ? ctx : null, toDataURL: (kind) => kind === "image/png" ? "data:image/png;base64,dGVzdA==" : "" };
}

test("展示所有字段，零值不视为缺失", () => {
  const model = buildDashboardModel(input());
  assert.equal(model.connection, "云端已连接");
  assert.equal(model.activity, "打印中");
  assert.equal(model.progress, "0%");
  assert.equal(model.remaining, "1小时1分");
  assert.equal(model.nozzle, "0℃ / 220℃");
  assert.equal(model.bed, "50℃ / 60℃");
  assert.equal(model.task, "样件");
  assert.equal(model.layers, "0 / 100");
  assert.equal(model.updated, new Date(now).toLocaleString("zh-CN", { hour12: false }));
});

test("字段分别标记旧数据、缺失、未来时间和断线", () => {
  const data = input();
  data.state.freshness.fields.progressPercent = mark(now - 300000);
  data.state.freshness.fields["nozzle.target"] = mark(now + 1);
  delete data.state.freshness.fields.layerNum;
  data.state.bed.target = null;
  let model = buildDashboardModel(data);
  assert.equal(model.progress, "0%（旧）");
  assert.equal(model.nozzle, "0℃ / 220℃（旧）");
  assert.equal(model.bed, "50℃ / —");
  assert.equal(model.layers, "0（旧） / 100");
  data.link.state = "reconnecting";
  model = buildDashboardModel(data);
  assert.equal(model.connection, "云端重连中");
  assert.equal(model.activity, "打印中（旧）");
  assert.equal(model.task, "样件（旧）");
});

test("无数据、登录状态及未知设备状态清晰显示", () => {
  assert.equal(buildDashboardModel({}).progress, "—");
  assert.equal(buildDashboardModel({ signedIn: false, authExpired: true }).connection, "登录已失效");
  assert.equal(buildDashboardModel({ hasPrinter: false }).connection, "请选择打印机");
  const data = input();
  data.state.activity = "unknown";
  data.state.rawActivity = "SOMETHING_NEW";
  data.state.freshness.fields.rawActivity = mark();
  assert.equal(buildDashboardModel(data).activity, "未知状态 SOMETHING_NEW");
});

test("故障通道和 HMS 保留原始字段并各自标注旧数据", () => {
  const data = input();
  Object.assign(data.state, { printError: "0x12", printErrorCode: "ABCD", hms: [{ code: "H001", attr: "A2", module: "M3" }] });
  Object.assign(data.state.freshness.fields, { printError: mark(), printErrorCode: mark(now - 300000), hms: { at: now, stale: true } });
  assert.equal(buildDashboardModel(data).faults, "错误 0x12 · 代码 ABCD（旧） · HMS H001/A2/M3（旧）");
  data.state.printError = 0;
  data.state.printErrorCode = null;
  data.state.hms = [];
  data.state.freshness.fields.hms = mark();
  assert.equal(buildDashboardModel(data).faults, "错误 0 · HMS 无");
  data.link.state = "failed";
  assert.equal(buildDashboardModel(data).faults, "错误 0（旧） · HMS 无（旧）");
  delete data.state.hms;
  delete data.state.printError;
  assert.equal(buildDashboardModel(data).faults, "—");
});

test("AMS 槽位摘要区分存在、空、未知及旧数据并限制数量", () => {
  const data = input();
  data.state.ams = { units: [{ id: "0", slots: [
    { id: "0", exists: true }, { id: "1", exists: false }, { id: "2", exists: null },
    { id: "3", exists: true }, { id: "4", exists: false },
  ] }] };
  data.state.freshness.ams = { units: { 0: { slots: {
    0: { exists: mark() }, 1: { exists: mark(now - 300000) }, 3: { exists: mark(now + 1) },
  } } } };
  assert.equal(buildDashboardModel(data).ams, "0:0 有 0:1 空(旧) 0:2 未知 0:3 有(旧) +1槽");
  data.link.state = "reconnecting";
  assert.match(buildDashboardModel(data).ams, /^0:0 有\(旧\)/);
  data.state.ams = { units: [] };
  assert.equal(buildDashboardModel(data).ams, "无槽位数据");
  data.state.ams = null;
  assert.equal(buildDashboardModel(data).ams, "—");
});

test("Canvas 渲染全部栏目，调用 SDK 并透传结果", async () => {
  const canvas = fakeCanvas();
  let call;
  const key = {};
  const result = await drawDashboard({ ...input(), key, serialNumber: "serial", createCanvas(w, h) {
    assert.deepEqual([w, h], [WIDTH, HEIGHT]);
    return canvas;
  }, plugin: { directDraw(...args) { call = args; return Promise.resolve("ok"); } } });
  assert.equal(result, "ok");
  assert.deepEqual(call, ["serial", key, "data:image/png;base64,dGVzdA==", false, 0]);
  const texts = canvas.calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  for (const expected of ["打印状态", "进度", "剩余时间", "喷嘴 当前 / 目标", "热床 当前 / 目标", "任务", "层数", "故障原始码 / HMS", "AMS 槽位", "最近设备上报", "样件"]) assert.ok(texts.includes(expected));
  assert.deepEqual(canvas.calls.at(-1), ["restore"]);
});

test("缺少画布能力或错误图像时拒绝绘制", async () => {
  const plugin = { directDraw() { assert.fail("不应调用宿主"); } };
  await assert.rejects(drawDashboard({ plugin }), /createCanvas/);
  await assert.rejects(drawDashboard({ plugin, createCanvas: () => ({ getContext: () => null }) }), /Canvas 2D/);
  const canvas = fakeCanvas();
  canvas.toDataURL = () => "invalid";
  await assert.rejects(drawDashboard({ plugin, createCanvas: () => canvas }), /PNG/);
  assert.throws(() => renderDashboard(canvas, {}, { width: 0 }), /width/);
});
