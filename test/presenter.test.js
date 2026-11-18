const test = require("node:test");
const assert = require("node:assert/strict");
const { toKeyTitle } = require("../src/display/key-renderer");
const {
  buildDisplay,
  buildViewDetails,
  createDrawThrottle,
  createNotificationDeduper,
  fingerprintDisplay,
  formatMinutes,
  formatPercent,
  formatTemperature,
  nextView,
  VIEWS,
} = require("../src/display/presenter");

const idleState = {
  printerId: "D1",
  connection: "connected",
  activity: "idle",
  rawActivity: "IDLE",
  progressPercent: 0,
  remainingMinutes: 0,
  taskName: null,
  nozzle: { current: 25.4, target: 25 },
  bed: { current: 24.6, target: 25 },
  errorCode: null,
  hms: [],
  lastReportAt: 1_000,
};

function displayFor(state, extra = {}) {
  return buildDisplay({
    signedIn: true,
    authExpired: false,
    hasPrinter: true,
    state,
    link: { state: "connected" },
    now: 2_000,
    ...extra,
  });
}

test("signed-out and expired sessions show actionable text", () => {
  const signedOut = buildDisplay({ signedIn: false, authExpired: false, hasPrinter: false, state: null, link: null });
  assert.equal(signedOut.title, "请登录");

  const expired = buildDisplay({ signedIn: false, authExpired: true, hasPrinter: true, state: null, link: null });
  assert.equal(expired.title, "登录已失效");
  assert.equal(expired.tone, "muted");
});

test("no printer selected asks the user to choose one", () => {
  const display = buildDisplay({ signedIn: true, authExpired: false, hasPrinter: false, state: null, link: null });
  assert.equal(display.title, "请选择打印机");
});

test("connecting and disconnected links are distinguishable", () => {
  const connecting = buildDisplay({
    signedIn: true, authExpired: false, hasPrinter: true, state: idleState, link: { state: "connecting" },
  });
  assert.equal(connecting.title, "正在连接云端");

  const failed = buildDisplay({
    signedIn: true,
    authExpired: false,
    hasPrinter: true,
    state: idleState,
    link: { state: "failed", lastError: { message: "云端拒绝了凭据" } },
  });
  assert.equal(failed.title, "云端断开");
  assert.equal(failed.subtitle, "云端拒绝了凭据");
  assert.equal(failed.tone, "critical");
});

test("waiting for the first report is not reported as idle", () => {
  const display = displayFor({ ...idleState, lastReportAt: null });
  assert.equal(display.title, "等待打印机状态");
});

test("printing shows progress and remaining time", () => {
  const display = displayFor({
    ...idleState,
    activity: "printing",
    progressPercent: 42.4,
    remainingMinutes: 125,
  });
  assert.equal(display.title, "打印中");
  assert.match(display.subtitle, /42%/);
  assert.match(display.subtitle, /2 小时 5 分/);
  assert.equal(display.tone, "normal");
});

test("stale data is marked instead of pretending to be live", () => {
  const display = displayFor({ ...idleState, activity: "printing", progressPercent: 42 }, {
    link: { state: "reconnecting" },
  });
  assert.equal(display.title, "数据已过期");
  assert.equal(display.stale, true);
  assert.equal(display.tone, "warning");
  const reconnected = displayFor({ ...idleState, reportStale: true });
  assert.equal(reconnected.title, "数据已过期");
  assert.equal(reconnected.subtitle, "等待重新收到设备状态");
  for (const activity of ["idle", "paused", "finished", "failed"]) {
    assert.equal(displayFor({ ...idleState, activity }, { link: { state: "reconnecting" } }).title, "数据已过期");
  }
});

test("long silence marks data stale even while subscribed", () => {
  const display = displayFor(idleState, { now: idleState.lastReportAt + 300_000 });
  assert.equal(display.title, "数据已过期");
  assert.equal(display.subtitle, "长时间未收到设备状态");
});

test("reported errors and HMS are visible regardless of activity", () => {
  for (const activity of ["idle", "printing", "paused"]) {
    assert.equal(displayFor({ ...idleState, activity, errorCode: "42" }).title, "设备报告故障");
    assert.equal(displayFor({ ...idleState, activity, hms: [{ code: "1" }] }).tone, "critical");
  }
});

test("AMS updates cannot make old task progress appear fresh", () => {
  const state = {
    ...idleState, activity: "printing", progressPercent: 12, remainingMinutes: null,
    lastReportAt: 400_000, freshness: { fields: {
      activity: { at: 1_000, stale: false }, progressPercent: { at: 1_000, stale: false },
    } },
  };
  const display = displayFor(state, { now: 400_000 });
  assert.equal(display.title, "数据已过期");
});

test("a new fault is visible even when other data are stale", () => {
  const state = {
    ...idleState, reportStale: true, printError: "123", errorCode: "123",
    freshness: { fields: { printError: { at: 1_900, stale: false }, activity: { at: 1_000, stale: true } } },
  };
  const display = displayFor(state);
  assert.equal(display.title, "设备报告故障");
  assert.match(display.subtitle, /123/);
  state.freshness.fields.printError.stale = true;
  assert.equal(displayFor(state).title, "数据已过期");
});

test("paused, finished and failed states have distinct tones", () => {
  assert.equal(displayFor({ ...idleState, activity: "paused", progressPercent: 10 }).tone, "warning");
  assert.equal(displayFor({ ...idleState, activity: "finished" }).tone, "positive");
  const failed = displayFor({ ...idleState, activity: "failed", errorCode: "50348044" });
  assert.equal(failed.title, "打印异常");
  assert.match(failed.subtitle, /50348044/);
});

test("failed without a code still reports the failure", () => {
  const failed = displayFor({ ...idleState, activity: "failed", errorCode: null });
  assert.equal(failed.subtitle, "设备报告打印失败");
});

test("unknown activity keeps the raw value visible", () => {
  const display = displayFor({ ...idleState, activity: "unknown", rawActivity: "WEIRD_STATE" });
  assert.equal(display.title, "状态未知");
  assert.match(display.subtitle, /WEIRD_STATE/);
});

test("formatters never print NaN", () => {
  assert.equal(formatPercent(null), "—");
  assert.equal(formatPercent(Number.NaN), "—");
  assert.equal(formatMinutes(null), "—");
  assert.equal(formatMinutes(-1), "—");
  assert.equal(formatMinutes(0), "0 分钟");
  assert.equal(formatMinutes(60), "1 小时");
  assert.equal(formatTemperature(null), "—");
  assert.equal(formatTemperature({ current: 210.2, target: null }), "210℃");
  assert.equal(formatTemperature({ current: 210.2, target: 220 }), "210℃ → 220℃");
});

test("view details rotate between progress, temperature and task", () => {
  assert.equal(nextView("progress"), "temperature");
  assert.equal(nextView("temperature"), "task");
  assert.equal(nextView("task"), "progress");
  assert.equal(nextView("bogus"), "progress");
  assert.deepEqual(VIEWS, ["progress", "temperature", "task"]);

  const state = { ...idleState, progressPercent: 30, remainingMinutes: 10, taskName: "benchy", layerNum: 4, totalLayerNum: 12 };
  assert.equal(buildViewDetails(state, "progress").title, "30%");
  assert.match(buildViewDetails(state, "temperature").title, /喷嘴/);
  assert.equal(buildViewDetails(state, "task").title, "benchy");
  assert.equal(buildViewDetails(null, "task").title, "无数据");
});

test("draw throttle collapses frequent updates to once per interval", () => {
  let clock = 0;
  const throttle = createDrawThrottle({ intervalMs: 1000, now: () => clock });

  assert.equal(throttle.shouldDraw("a"), true);
  clock = 100;
  assert.equal(throttle.shouldDraw("b"), false);
  clock = 500;
  assert.equal(throttle.shouldDraw("c"), false);
  clock = 1000;
  assert.equal(throttle.shouldDraw("c"), true);
  // 相同指纹不重绘
  clock = 2000;
  assert.equal(throttle.shouldDraw("c"), false);
});

test("urgent draw ignores the interval but not deduplication", () => {
  let clock = 0;
  const throttle = createDrawThrottle({ intervalMs: 1000, now: () => clock });
  assert.equal(throttle.shouldDraw("a"), true);
  clock = 10;
  assert.equal(throttle.shouldDraw("b", { urgent: true }), true);
  assert.equal(throttle.shouldDraw("b", { urgent: true }), false);
});

test("throttled draw resumes on the next tick", () => {
  let clock = 0;
  const throttle = createDrawThrottle({ intervalMs: 1000, now: () => clock });
  throttle.shouldDraw("a");
  clock = 200;
  throttle.shouldDraw("b");
  assert.equal(throttle.takePending(), null);
  clock = 1200;
  assert.equal(throttle.takePending(), "b");
});

test("fingerprint changes when the display changes", () => {
  const a = fingerprintDisplay(displayFor(idleState), "progress");
  const b = fingerprintDisplay(displayFor({ ...idleState, activity: "printing" }), "progress");
  assert.notEqual(a, b);
});

test("notifications are deduplicated per task and kind", () => {
  const deduper = createNotificationDeduper();
  const state = { taskName: "benchy" };
  assert.equal(deduper.shouldNotify("finished", state), true);
  assert.equal(deduper.shouldNotify("finished", state), false);
  assert.equal(deduper.shouldNotify("failed", state), true);
  deduper.resetTask("benchy");
  assert.equal(deduper.shouldNotify("finished", state), true);
  deduper.clear();
  assert.equal(deduper.shouldNotify("finished", state), true);
});

test("key titles combine title and subtitle within the host limit", () => {
  assert.equal(toKeyTitle({ title: "打印中", subtitle: "进度 42% · 剩余 2 小时" }), "打印中 · 进度 42% · 剩余 2 小时");
  assert.equal(toKeyTitle({ title: "打印机空闲", subtitle: "" }), "打印机空闲");
  assert.equal(toKeyTitle(null), "");
  const long = toKeyTitle({ title: "x".repeat(20), subtitle: "y".repeat(40) });
  assert.equal(long.length, 32);
  assert.ok(long.endsWith("…"));
});
