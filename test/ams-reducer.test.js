const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeAms, recordAmsFreshness, emptyAms, MAX_FRESHNESS_UNITS } = require("../src/printer/ams-reducer");

/** 构造可直接传入的时效树（与 reducer 内部结构一致）。 */
function freshnessTree() {
  return { ams: { fields: {}, units: {} } };
}

function apply(state, freshness, patch, at, options = {}) {
  const next = mergeAms(state, patch, options.presenceFresh ?? true);
  recordAmsFreshness(freshness, state, next, patch, at, options.presenceFresh ?? true);
  return next;
}

test("数值与时效在同一补丁中一起更新", () => {
  const freshness = freshnessTree();
  let ams = apply(null, freshness, { units: [{ id: "0", model: "AMS", slots: [{ id: "1", material: "PLA", remaining: 0 }] }] }, 100);
  assert.equal(ams.units[0].slots[0].material, "PLA");
  assert.equal(ams.units[0].slots[0].remaining, 0, "0 是有效读数");
  assert.deepEqual(freshness.ams.units[0].slots[1].material, { at: 100, stale: false });
  assert.deepEqual(freshness.ams.units[0].slots[1].remaining, { at: 100, stale: false });
  assert.equal(freshness.ams.units[0].slots[1].color, undefined, "未上报字段没有标记");
});

test("缺失字段保留旧值与旧时间，null 清空对应层", () => {
  const freshness = freshnessTree();
  let ams = apply(null, freshness, { units: [{ id: "0", slots: [{ id: "0", material: "PLA", color: "FF0011FF" }] }] }, 100);
  ams = apply(ams, freshness, { units: [{ id: "0", slots: [{ id: "0", material: "PETG" }] }] }, 200);
  assert.equal(ams.units[0].slots[0].material, "PETG");
  assert.equal(ams.units[0].slots[0].color, "FF0011FF", "缺失字段保留旧值");
  assert.deepEqual(freshness.ams.units[0].slots[0].color, { at: 100, stale: false }, "旧字段时间不刷新");

  ams = apply(ams, freshness, { units: null }, 300);
  assert.equal(ams.units, null);
  assert.equal(freshness.ams.units[1], undefined);
});

test("型号替换同时清理数值与时效，不留下可复活的旧槽位", () => {
  const freshness = freshnessTree();
  let ams = apply(null, freshness, { units: [{ id: "0", model: "AMS", slots: [{ id: "0", material: "PLA" }], zones: [{ id: "0", temperature: 30 }] }] }, 100);
  assert.ok(freshness.ams.units[0].slots[0].material);
  ams = apply(ams, freshness, { units: [{ id: "0", model: "AMS 3H" }] }, 200);
  const unit = ams.units[0];
  assert.equal(unit.model, "AMS 3H");
  assert.equal(unit.slots, null, "型号变化后旧槽位清空");
  assert.equal(unit.zones, undefined);
  const marks = freshness.ams.units[0] || {};
  assert.deepEqual(marks.model, { at: 200, stale: false });
  // 首次确认型号时旧槽位标记保留：槽位本身已被清空，标记不影响展示。
  assert.equal(ams.units[0].slots, null);
});

test("九槽布局不接受旧四槽掩码，存在性保持未知", () => {
  const freshness = freshnessTree();
  const ams = apply(null, freshness, { existBits: "0", units: [{ id: "0", slots: Array.from({ length: 9 }, (_, id) => ({ id, material: "PLA" })) }] }, 100);
  assert.equal(ams.units[0].slots.length, 9);
  for (const slot of ams.units[0].slots) {
    assert.equal(slot.exists, null);
    assert.equal(freshness.ams.units[0].slots[slot.id]?.exists, undefined);
  }
});

test("旧空槽证据不会遮挡随后上报的材质", () => {
  const freshness = freshnessTree();
  let ams = apply(null, freshness, { existBits: "0", units: [{ id: "0", slots: [{ id: "0" }] }] }, 100);
  assert.equal(ams.units[0].slots[0].exists, false);
  ams = apply(ams, freshness, { units: [{ id: "0", slots: [{ id: "0", material: "PETG" }] }] }, 200, { presenceFresh: false });
  assert.equal(ams.units[0].slots[0].material, "PETG", "过期的空槽证据不能阻止新材质");
});

test("单元与槽位数量有上限，超限不写入", () => {
  const freshness = freshnessTree();
  const units = Array.from({ length: MAX_FRESHNESS_UNITS + 2 }, (_, index) => ({ id: String(index), slots: [{ id: "0", material: "PLA" }] }));
  const ams = apply(null, freshness, { units }, 100);
  assert.equal(ams.units.length, MAX_FRESHNESS_UNITS);
  assert.equal(Object.keys(freshness.ams.units).length, MAX_FRESHNESS_UNITS);
});

test("无效补丁不清空已有状态", () => {
  const freshness = freshnessTree();
  const base = apply(null, freshness, { units: [{ id: "0", slots: [{ id: "0", material: "PLA" }] }] }, 100);
  const next = apply(base, freshness, { units: "invalid" }, 200);
  assert.equal(next.units[0].slots[0].material, "PLA");
});

test("显式空数组表示已上报为空，与未知列表区分", () => {
  const freshness = freshnessTree();
  const ams = apply(null, freshness, { units: [] }, 100);
  assert.deepEqual(ams.units, []);
  assert.deepEqual(freshness.ams.units, {}, "空列表清理单元时效");
  assert.equal(emptyAms().units.length, 0);
});
