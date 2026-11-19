/**
 * AMS 增量合并（见 docs/设备协议与状态模型.md「AMS」）。
 *
 * 数值树与时效树住在同一模块，按同一补丁先后更新，调用方不再需要分别维护。
 * 合并与记录保持原有逐条语义：按实际 ID 查找，显式 null 清空对应层，
 * 空数组表示"已上报但为空"，旧四槽掩码只约束已确认的四槽布局，
 * 身份元数据不刷新打印遥测时间。
 */

const { amsAbsenceIsFresh } = require("./observation-policy");

const MAX_FRESHNESS_UNITS = 64;
const MAX_FRESHNESS_SLOTS = 16;

function presenceIsFresh(mark, at) {
  return amsAbsenceIsFresh(mark, at);
}

function stamp(at) {
  return { at, stale: false };
}

function slotFreshness(freshness, unitId, slotId) {
  let unit = freshness.units[unitId];
  if (!unit) {
    if (Object.keys(freshness.units).length >= MAX_FRESHNESS_UNITS) return null;
    unit = freshness.units[unitId] = { slots: {} };
  }
  let slot = unit.slots[slotId];
  if (!slot) {
    if (Object.keys(unit.slots).length >= MAX_FRESHNESS_SLOTS) return null;
    slot = unit.slots[slotId] = {};
  }
  return slot;
}

function emptyAms() {
  return { units: [], current: null, rawTrayNow: null, rawStatus: null, existBits: null };
}

// The legacy global mask only establishes presence for known four-slot layouts.
function usesLegacyPresence(unit) {
  return unit.model !== "AMS 3H" && !Object.hasOwn(unit, "zones") &&
    Number(unit.id) < 4 && !(unit.slots || []).some(slot => Number(slot.id) >= 4);
}

function updatePresence(slot, unitId, bits) {
  const unit = Number(unitId);
  const index = Number(slot.id);
  if (bits == null || !Number.isSafeInteger(unit) || unit < 0 || unit >= 4 ||
      !Number.isSafeInteger(index) || index < 0 || index >= 4) return;
  const exists = ((BigInt(`0x${bits}`) >> BigInt(unit * 4 + index)) & 1n) === 1n;
  if (!exists || slot.exists === false) {
    slot.color = null;
    slot.material = null;
    slot.remaining = null;
    slot.rawState = null;
  }
  slot.exists = exists;
}

function mergeAms(previous, patch, presenceFresh = true) {
  if (patch === null) return null;
  const result = previous || emptyAms();
  if (Object.hasOwn(patch, "current")) result.current = patch.current;
  if (Object.hasOwn(patch, "rawTrayNow")) result.rawTrayNow = patch.rawTrayNow;
  if (Object.hasOwn(patch, "existBits")) {
    result.existBits = patch.existBits;
    for (const unit of result.units || []) {
      const update = patch.units?.find(item => item.id === unit.id);
      const layout = { ...unit, ...update, slots: [...(unit.slots || []), ...(update?.slots || [])] };
      if (usesLegacyPresence(layout)) {
        for (const slot of unit.slots || []) updatePresence(slot, unit.id, result.existBits);
      }
    }
  }
  if (Object.hasOwn(patch, "units")) {
    if (patch.units === null) {
      result.units = null;
      return result;
    }
    if (!patch.units.length || !result.units) result.units = [];
    for (const update of patch.units) {
      let unit = result.units.find((item) => item.id === update.id);
      if (!unit) {
        if (result.units.length >= MAX_FRESHNESS_UNITS) continue;
        unit = { id: update.id, slots: null };
        result.units.push(unit);
      }
      if (Object.hasOwn(update, "model")) {
        if (unit.model && update.model !== unit.model) {
          unit.slots = null;
          delete unit.zones;
          delete unit.rawInfo;
        }
        unit.model = update.model;
      }
      if (Object.hasOwn(update, "rawInfo")) unit.rawInfo = update.rawInfo;
      if (Object.hasOwn(update, "zones")) {
        if (!update.zones?.length) unit.zones = update.zones === null ? null : [];
        else {
          unit.zones ||= [];
          for (const zoneUpdate of update.zones) {
            let zone = unit.zones.find(item => item.id === zoneUpdate.id);
            if (!zone) {
              if (unit.zones.length >= MAX_FRESHNESS_SLOTS) continue;
              zone = { id: zoneUpdate.id, temperature: null, humidity: null, dryingMinutes: null };
              unit.zones.push(zone);
            }
            Object.assign(zone, zoneUpdate);
          }
        }
      }
      const legacyPresence = usesLegacyPresence({ ...unit, slots: [...(unit.slots || []), ...(update.slots || [])] });
      if (!legacyPresence) {
        for (const slot of unit.slots || []) slot.exists = null;
      }
      if (Object.hasOwn(update, "slots")) {
        if (update.slots === null) {
          unit.slots = null;
          continue;
        }
        if (!update.slots.length || !unit.slots) unit.slots = [];
        for (const updateSlot of update.slots) {
          let slot = unit.slots.find((item) => item.id === updateSlot.id);
          if (!slot) {
            if (unit.slots.length >= MAX_FRESHNESS_SLOTS) continue;
            slot = { id: updateSlot.id, color: null, material: null, remaining: null, rawState: null, exists: null };
            if (presenceFresh && legacyPresence) updatePresence(slot, unit.id, result.existBits);
            unit.slots.push(slot);
          }
          if (slot.exists === false && presenceFresh && legacyPresence) {
            // Ignore material metadata for a slot reported absent.
            if (Object.hasOwn(updateSlot, "rawState")) slot.rawState = updateSlot.rawState;
          } else {
            Object.assign(slot, updateSlot);
          }
        }
      }
    }
  }
  return result;
}


function recordAmsFreshness(freshness, oldAms, ams, patch, at, presenceFresh) {
  if (patch === null) {
    freshness.ams = { fields: { value: stamp(at) }, units: {} };
    return;
  }
  const meta = freshness.ams;
  if (Object.hasOwn(patch, "current")) meta.fields.current = stamp(at);
  if (Object.hasOwn(patch, "rawTrayNow")) meta.fields.rawTrayNow = stamp(at);
  if (Object.hasOwn(patch, "existBits")) meta.fields.existBits = stamp(at);
  // 非数组补丁表示无有效内容，不能当作空列表清理。
  if (Object.hasOwn(patch, "units") && (!patch.units || (Array.isArray(patch.units) && patch.units.length === 0))) meta.units = {};
  for (const unit of ams.units || []) {
    const oldUnit = oldAms?.units?.find((item) => item.id === unit.id);
    const update = Array.isArray(patch.units) ? patch.units.find((item) => item.id === unit.id) : undefined;
    if (update?.model && oldUnit?.model && update.model !== oldUnit.model) delete meta.units[unit.id];
    if (update && Object.hasOwn(update, "slots") && (!update.slots || update.slots.length === 0)) {
      if (meta.units[unit.id]) {
        meta.units[unit.id].slots = {};
        if (Object.keys(meta.units[unit.id]).length === 1) delete meta.units[unit.id];
      }
    }
    if (update && Object.hasOwn(update, "rawInfo")) {
      if (meta.units[unit.id] || Object.keys(meta.units).length < MAX_FRESHNESS_UNITS) {
        meta.units[unit.id] ||= { slots: {} };
        meta.units[unit.id].rawInfo = stamp(at);
      }
    }
    if (update && (Object.hasOwn(update, "model") || Object.hasOwn(update, "zones"))) {
      if (meta.units[unit.id] || Object.keys(meta.units).length < MAX_FRESHNESS_UNITS) {
        const unitMeta = meta.units[unit.id] ||= { slots: {} };
        if (Object.hasOwn(update, "model")) {
          unitMeta.model = stamp(at);
          if (oldUnit?.model === "AMS 3H" && unit.model !== "AMS 3H") delete unitMeta.zones;
        }
        if (Object.hasOwn(update, "zones")) {
          if (!update.zones?.length) unitMeta.zones = {};
          for (const zone of unit.zones || []) {
            const change = update.zones?.find(item => item.id === zone.id);
            if (!change) continue;
            const zoneMeta = (unitMeta.zones ||= {})[zone.id] ||= {};
            for (const field of ["temperature", "humidity", "dryingMinutes"]) {
              if (Object.hasOwn(change, field)) zoneMeta[field] = stamp(at);
            }
          }
        }
      }
    }
    for (const slot of unit.slots || []) {
      const oldSlot = oldUnit?.slots?.find((item) => item.id === slot.id);
      const change = update?.slots?.find((item) => item.id === slot.id);
      const presenceChanged = oldSlot && slot.exists !== null && oldSlot.exists !== slot.exists;
      if (!change && !Object.hasOwn(patch, "existBits") && oldSlot?.exists === slot.exists) continue;
      const slotMeta = slotFreshness(meta, unit.id, slot.id);
      if (!slotMeta) continue;
      if (slot.exists === null) delete slotMeta.exists;
      if (Object.hasOwn(patch, "existBits") && slot.exists !== null) slotMeta.exists = stamp(at);
      else if (!oldSlot && slot.exists !== null && meta.fields.existBits) slotMeta.exists = { ...meta.fields.existBits };
      if (presenceChanged || (slot.exists === false && presenceFresh)) {
        delete slotMeta.color;
        delete slotMeta.material;
        delete slotMeta.remaining;
        delete slotMeta.rawState;
      }
      if (change) {
        for (const key of ["color", "material", "remaining", "rawState"]) {
          if (Object.hasOwn(change, key) && (slot.exists !== false || !presenceFresh || key === "rawState")) slotMeta[key] = stamp(at);
        }
      }
    }
  }
}

module.exports = {
  MAX_FRESHNESS_UNITS,
  MAX_FRESHNESS_SLOTS,
  presenceIsFresh,
  slotFreshness,
  emptyAms,
  usesLegacyPresence,
  updatePresence,
  mergeAms,
  recordAmsFreshness,
};
