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
    measureText(value) { return { width: Array.from(String(value)).length * 12 }; },
    beginPath() {}, arc() {}, fill() {},
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

function presenceData() {
  const data = input();
  data.state.presence = { state: "online", source: "telemetry", lastTelemetryAt: now };
  for (const name of Object.keys(data.state.freshness.fields)) data.state.freshness.fields[name] = mark(now - 600_000);
  data.state.ams = { units: [{ id: "0", slots: [{ id: "0", exists: false }] }] };
  data.state.freshness.ams = { units: { 0: { slots: { 0: { exists: mark(now - 600_000) } } } } };
  return data;
}

test("持续遥测时稳定字段及 AMS 不按单字段五分钟标旧", () => {
  const data = presenceData();
  const model = buildDashboardModel(data);
  assert.equal(model.connection, "打印机在线");
  assert.equal(model.activity, "打印中");
  assert.equal(model.progress, "0%");
  assert.equal(model.nozzle, "0℃ / 220℃");
  assert.equal(model.ams, "0:0 空");
});

test("presence 状态与云端断开保留读数并统一标旧，绝不覆盖设备观测", () => {
  for (const [status, label] of [["offline", "打印机离线"], ["unknown", "打印机状态未知"], ["syncing", "等待打印机同步"], ["unresponsive", "设备无响应"]]) {
    const data = presenceData();
    data.state.presence.state = status;
    const before = structuredClone(data);
    let model = buildDashboardModel(data);
    assert.equal(model.connection, label);
    assert.equal(model.activity, "打印中（旧）");
    assert.equal(model.progress, "0%（旧）");
    assert.equal(model.ams, "0:0 空(旧)");
    assert.deepEqual(data, before);
    data.link.state = "failed";
    model = buildDashboardModel(data);
    assert.equal(model.connection, "云端连接中断，打印机状态未知");
  }
});

test("恢复后 stale、缺失和未来字段标记及 AMS 均保持旧读数", () => {
  for (const observation of [{ at: now, stale: true }, undefined, mark(now + 1)]) {
    const data = presenceData();
    data.state.freshness.fields.progressPercent = observation;
    data.state.freshness.ams.units[0].slots[0].exists = observation;
    const model = buildDashboardModel(data);
    assert.equal(model.progress, "0%（旧）");
    assert.equal(model.ams, "0:0 空(旧)");
    assert.equal(model.task, "样件");
  }
  const data = presenceData();
  delete data.state.freshness;
  assert.equal(buildDashboardModel(data).progress, "0%（旧）");
});

test("旧 online getter、未报告遥测及时间回退不会使字段与 AMS 变新", () => {
  for (const [at, label] of [[now - 120_000, "设备无响应"], [now + 1, "打印机状态未知"], [null, "打印机状态未知"], [-1, "打印机状态未知"]]) {
    const data = presenceData();
    data.state.presence.lastTelemetryAt = at;
    const model = buildDashboardModel(data);
    assert.equal(model.connection, label);
    assert.equal(model.progress, "0%（旧）");
    assert.equal(model.ams, "0:0 空(旧)");
  }
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
  assert.ok(texts.includes("样件"), "实际任务必须绘制到画布");
  assert.ok(canvas.calls.some(c => c[0] === "scale" && c[1] === 1));
  assert.deepEqual(canvas.calls.at(-1), ["restore"]);
});

test("宿主 Canvas 字宽限制下进度数字与百分号均显示，包括完成及旧读数", () => {
  for (const percent of [0, 68, 100]) {
    for (const stale of [false, true]) {
      const data = input();
      data.state.progressPercent = percent;
      data.state.freshness.fields.progressPercent.stale = stale;
      const canvas = fakeCanvas();
      const ctx = canvas.getContext('2d');
      // 宿主 @napi-rs/canvas 将 550 字重下的 100 测为约 889px。
      ctx.measureText = value => ({ width: Array.from(String(value)).length *
        (/^550 /.test(ctx.font) ? 296.45 : Number(ctx.font.match(/ (\d+)px/)[1]) * 0.55) });
      renderDashboard(canvas, buildDashboardModel(data));
      const digits = canvas.calls.find(c => c[0] === 'fillText' && c[2] === 512);
      assert.equal(digits?.[1], String(percent));
      assert.ok(canvas.calls.some(c => c[0] === 'fillText' && c[1] === '%'));
      if (stale) assert.ok(canvas.calls.some(c => c[0] === 'fillText' && c[1] === '旧'));
    }
  }
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


test("精炼展示逐字段保留有效零值、旧值与分钟进位", () => {
  const data = input();
  data.state.remainingMinutes = 59.9;
  data.state.freshness.fields['nozzle.target'].stale = true;
  const ui = buildDashboardModel(data).ui;
  assert.deepEqual(ui.progress, { text: '0', stale: false, value: 0 });
  assert.deepEqual(ui.nozzle.current, { text: '0', stale: false });
  assert.deepEqual(ui.nozzle.target, { text: '220', stale: true });
  assert.equal(ui.remaining.text, '1h 0m');
  data.state.progressPercent = null;
  assert.deepEqual(buildDashboardModel(data).ui.progress, { text: '—', stale: false, value: null });
});

test("AMS 多单元保留实际 ID，Lite 隐藏余量且材质颜色独立标旧", () => {
  const data = presenceData();
  data.model = 'A1';
  data.state.ams.units = [
    { id: '3', model: 'AMS lite', slots: [{ id: '8', exists: true, material: 'PLA', color: 'AABBCCFF', remaining: 0 }] },
    { id: '9', model: 'AMS 3H', slots: Array.from({ length: 9 }, (_, n) => ({ id: String(n), exists: true, material: 'PETG', remaining: 0 })) },
  ];
  data.state.freshness.ams = { units: { '3': { slots: { '8': { exists: mark(), material: { at: now, stale: true }, color: mark(), remaining: mark() } } } } };
  const before = structuredClone(data);
  const ui = buildDashboardModel(data).ui;
  assert.equal(ui.slots[0].unitId, '3');
  assert.equal(ui.slots[0].id, '8');
  assert.deepEqual(ui.slots[0].material, { text: 'PLA', stale: true });
  assert.deepEqual(ui.slots[0].color, { text: '#AABBCC', stale: false });
  assert.equal(ui.slots[0].remaining.text, '—');
  assert.equal(ui.slots[1].unitId, '9');
  assert.deepEqual(ui.slots[1].remaining, { text: '0%', stale: true });
  assert.equal(ui.extraSlots, 6);
  assert.deepEqual(data, before);
});

test("风扇按本次机型能力隐藏且接收零读数", () => {
  const data = input();
  data.model = 'A1';
  data.state.fans = { part: 0, heatbreak: 0, auxiliary: 42, chamber: 35 };
  for (const key of Object.keys(data.state.fans)) data.state.freshness.fields[`fans.${key}`] = mark();
  let ui = buildDashboardModel(data).ui;
  assert.deepEqual(ui.fans.map(f => [f.label, f.value.text]), [['部件', '0%'], ['热端', '0%']]);
  data.model = 'X1 Carbon';
  ui = buildDashboardModel(data).ui;
  assert.equal(ui.fans.length, 4);
  delete data.state.fans.heatbreak;
  assert.ok(!buildDashboardModel(data).ui.fans.some(f => f.label === '热端'));
});

test("未知 HMS 提升故障优先级，旧故障不伪装为实时故障", () => {
  const data = presenceData();
  data.state.hms = [{ code: 'NEW_CODE', module: 'M9', attr: 0 }];
  data.state.freshness.fields.hms = mark();
  let ui = buildDashboardModel(data).ui;
  assert.equal(ui.tone, 'critical');
  assert.equal(ui.urgent, true);
  assert.match(ui.fault.text, /NEW_CODE\/0\/M9/);
  data.state.presence.state = 'offline';
  ui = buildDashboardModel(data).ui;
  assert.equal(ui.fault.stale, true);
  assert.notEqual(ui.tone, 'critical');
  assert.equal(ui.progress.value, 0);
  assert.equal(ui.progress.stale, true);
  assert.equal(ui.connection, '设备离线');
});

test("打印失败但无原始码仍显示失败原因，未知故障不标成旧读数", () => {
  const data = input();
  assert.deepEqual(buildDashboardModel(data).ui.fault, { text: '故障信息未知', stale: false });
  data.state.activity = 'failed';
  const model = buildDashboardModel(data);
  assert.equal(model.ui.urgent, true);
  assert.match(model.ui.fault.text, /打印失败/);
  const canvas = fakeCanvas();
  renderDashboard(canvas, model);
  assert.ok(canvas.calls.some(c => c[0] === 'fillText' && c[1].includes('打印失败')));
});

test("刷新反馈与遥测同帧显示，结束后恢复任务名且不改打印读数", () => {
  const data = input();
  const before = structuredClone(data.state);
  data.feedback = { text: '已请求完整状态，等待设备上报', level: 'success' };
  const during = fakeCanvas();
  renderDashboard(during, buildDashboardModel(data));
  const texts = during.calls.filter(c => c[0] === 'fillText').map(c => c[1]);
  assert.ok(texts.some(t => t.startsWith('已请求完整状态')));
  assert.ok(!texts.includes('样件'), '反馈短暂占用任务名一行');
  assert.ok(texts.includes('打印中'), '打印活动仍正常显示');
  delete data.feedback;
  const after = fakeCanvas();
  renderDashboard(after, buildDashboardModel(data));
  assert.ok(after.calls.some(c => c[0] === 'fillText' && c[1] === '样件'));
  assert.deepEqual(data.state, before);
});

test("登录前置状态不强调历史打印进度", () => {
  const data = input();
  data.signedIn = false;
  data.authExpired = true;
  const ui = buildDashboardModel(data).ui;
  assert.equal(ui.precondition, true);
  assert.equal(ui.title, '登录已失效');
  const canvas = fakeCanvas();
  renderDashboard(canvas, buildDashboardModel(data));
  const texts = canvas.calls.filter(c => c[0] === 'fillText').map(c => c[1]);
  assert.ok(texts.includes('登录已失效'));
  assert.ok(!texts.includes('样件'));
});
