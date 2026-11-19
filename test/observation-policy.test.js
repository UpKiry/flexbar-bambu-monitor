const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TELEMETRY_TIMEOUT_MS,
  FIELD_STALE_MS,
  presenceIsActive,
  effectivePresenceState,
  markIsFresh,
  fieldIsFresh,
  amsAbsenceIsFresh,
} = require("../src/printer/observation-policy");

const NOW = 600_000;

test("遥测活跃窗口边界为 120 秒，沉默与未来时间都不算活跃", () => {
  assert.equal(TELEMETRY_TIMEOUT_MS, 120_000);
  assert.equal(presenceIsActive({ state: "online", lastTelemetryAt: NOW - 119_999 }, NOW), true);
  assert.equal(presenceIsActive({ state: "online", lastTelemetryAt: NOW - 120_000 }, NOW), false);
  assert.equal(presenceIsActive({ state: "online", lastTelemetryAt: NOW + 1 }, NOW), false);
  assert.equal(presenceIsActive({ state: "online", lastTelemetryAt: null }, NOW), false);
  assert.equal(presenceIsActive({ state: "syncing", lastTelemetryAt: NOW }, NOW), false);
  assert.equal(presenceIsActive(null, NOW), false);
});

test("展示状态区分无效时间与沉默超时", () => {
  assert.equal(effectivePresenceState({ state: "online", lastTelemetryAt: null }, NOW), "unknown");
  assert.equal(effectivePresenceState({ state: "online", lastTelemetryAt: -1 }, NOW), "unknown");
  assert.equal(effectivePresenceState({ state: "online", lastTelemetryAt: Number.NaN }, NOW), "unknown");
  assert.equal(effectivePresenceState({ state: "online", lastTelemetryAt: NOW + 1 }, NOW), "unknown");
  assert.equal(effectivePresenceState({ state: "online", lastTelemetryAt: NOW - 120_000 }, NOW), "unresponsive");
  assert.equal(effectivePresenceState({ state: "online", lastTelemetryAt: NOW - 1 }, NOW), "online");
  assert.equal(effectivePresenceState({ state: "offline" }, NOW), "offline");
  assert.equal(effectivePresenceState(null, NOW), "unknown");
});

test("带 presence 时只认标记与活跃遥测，两者缺一不可", () => {
  const presence = { state: "online", lastTelemetryAt: NOW };
  assert.equal(markIsFresh({ at: NOW - 10, stale: false }, presence, NOW), true);
  assert.equal(markIsFresh({ at: NOW - 10, stale: true }, presence, NOW), false);
  assert.equal(markIsFresh({ at: NOW + 1, stale: false }, presence, NOW), false);
  assert.equal(markIsFresh({ at: -1, stale: false }, presence, NOW), false);
  assert.equal(markIsFresh(undefined, presence, NOW), false);
  assert.equal(markIsFresh({ at: NOW - 10, stale: false }, { state: "online", lastTelemetryAt: NOW - 120_000 }, NOW), false);
});

test("无 presence 的兼容路径使用五分钟年龄判断", () => {
  assert.equal(FIELD_STALE_MS, 300_000);
  assert.equal(markIsFresh({ at: NOW - 299_999, stale: false }, null, NOW), true);
  assert.equal(markIsFresh({ at: NOW - 300_000, stale: false }, null, NOW), false);
});

test("fields 缺失时：带 presence 不借用其他时间，无 presence 才回退", () => {
  const state = { lastReportAt: NOW - 1_000, reportStale: false };
  assert.equal(fieldIsFresh(state, "activity", NOW, { state: "online", lastTelemetryAt: NOW }), false);
  assert.equal(fieldIsFresh(state, "activity", NOW, null), true);
  assert.equal(fieldIsFresh({ ...state, reportStale: true }, "activity", NOW, null), false);
  assert.equal(fieldIsFresh({ lastReportAt: NOW - 300_000 }, "activity", NOW, null), false);
});

test("字段标记按字段独立判断，不能用其他字段补足", () => {
  const state = {
    lastReportAt: NOW,
    freshness: { fields: { activity: { at: NOW - 10, stale: false }, progressPercent: { at: NOW - 10, stale: true } } },
  };
  const presence = { state: "online", lastTelemetryAt: NOW };
  assert.equal(fieldIsFresh(state, "activity", NOW, presence), true);
  assert.equal(fieldIsFresh(state, "progressPercent", NOW, presence), false);
  assert.equal(fieldIsFresh(state, "taskName", NOW, presence), false, "未上报字段没有标记");
});

test("字段时效只看观测证据，不推断连接状态", () => {
  const state = { freshness: { fields: { activity: { at: NOW - 10, stale: false } } } };
  const presence = { state: "online", lastTelemetryAt: NOW };
  assert.equal(fieldIsFresh(state, "activity", NOW, presence), true, "连接状态由调用方判断，本函数不越权");
});

test("AMS 空槽保护期与展示兼容回退是两条独立规则", () => {
  assert.equal(amsAbsenceIsFresh({ at: NOW - 299_999, stale: false }, NOW), true);
  assert.equal(amsAbsenceIsFresh({ at: NOW - 300_000, stale: false }, NOW), false);
  assert.equal(amsAbsenceIsFresh({ at: NOW + 1, stale: false }, NOW), false);
  assert.equal(amsAbsenceIsFresh({ at: NOW, stale: true }, NOW), false);
  assert.equal(amsAbsenceIsFresh(undefined, NOW), false);
});
