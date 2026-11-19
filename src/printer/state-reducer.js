const {
  emptyPrinterState,
  isFullSnapshot,
  isTaskSwitch,
  mapReport,
} = require("./state-mapper");

/**
 * 快照与增量合并（见 docs/云端监控设计方案.md §6.4）。
 *
 * 规则：
 * - 增量报文缺失的字段保留旧值；
 * - 报文里显式出现的字段按已验证的字段语义处理（温度、进度等用 null 表示不可用）；
 * - 收到完整快照、设备切换或任务切换时，按明确规则清理旧字段；
 * - AMS 按设备及槽位 ID 合并增量，显式空数组清空该层。
 */

/** 任务切换时需要清理的字段：这些字段属于上一个任务。 */
const TASK_SCOPED_FIELDS = ["progressPercent", "remainingMinutes", "layerNum", "totalLayerNum"];
const FRESH_FIELDS = {
  activity: "activity", rawActivity: "rawActivity", progressPercent: "progressPercent",
  remainingMinutes: "remainingMinutes", taskName: "taskName", rawTaskName: "rawTaskName",
  taskId: "taskId", nozzleCurrent: "nozzle.current", nozzleTarget: "nozzle.target",
  bedCurrent: "bed.current", bedTarget: "bed.target", chamberCurrent: "chamber.current", layerNum: "layerNum",
  totalLayerNum: "totalLayerNum", printError: "printError", printErrorCode: "printErrorCode", hms: "hms",
};
const MAX_FRESHNESS_UNITS = 64;
const MAX_FRESHNESS_SLOTS = 16;
// 与展示层使用相同的五分钟上报有效期。
const AMS_PRESENCE_MAX_AGE_MS = 5 * 60_000;

function presenceIsFresh(mark, at) {
  return mark?.stale === false && Number.isFinite(mark.at) && Number.isFinite(at) &&
    at >= mark.at && at - mark.at < AMS_PRESENCE_MAX_AGE_MS;
}

function stamp(at) {
  return { at, stale: false };
}

function markStale(node) {
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      if (Object.hasOwn(value, "at") && Object.hasOwn(value, "stale")) value.stale = true;
      else markStale(value);
    }
  }
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

function recordAmsFreshness(freshness, oldAms, ams, patch, at, presenceFresh) {
  if (patch === null) {
    freshness.ams = { fields: { value: stamp(at) }, units: {} };
    return;
  }
  const meta = freshness.ams;
  if (Object.hasOwn(patch, "current")) meta.fields.current = stamp(at);
  if (Object.hasOwn(patch, "rawTrayNow")) meta.fields.rawTrayNow = stamp(at);
  if (Object.hasOwn(patch, "existBits")) meta.fields.existBits = stamp(at);
  if (Object.hasOwn(patch, "units") && (!patch.units || patch.units.length === 0)) meta.units = {};
  for (const unit of ams.units || []) {
    const oldUnit = oldAms?.units?.find((item) => item.id === unit.id);
    const update = patch.units?.find((item) => item.id === unit.id);
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

function cloneState(state) {
  return {
    ...state,
    freshness: structuredClone(state.freshness || { fields: {}, ams: { fields: {}, units: {} } }),
    nozzle: { ...state.nozzle },
    bed: { ...state.bed },
    chamber: { current: null, ...state.chamber },
    fans: { part: null, auxiliary: null, chamber: null, heatbreak: null, ...state.fans },
    rawFans: { part: null, auxiliary: null, chamber: null, heatbreak: null, ...state.rawFans },
    hms: state.hms ? state.hms.map((item) => ({ ...item })) : state.hms,
    ams: state.ams ? {
      ...state.ams,
      current: state.ams.current ? { ...state.ams.current } : null,
      units: structuredClone(state.ams.units) ?? null,
    } : null,
  };
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

function clearTaskFields(state) {
  for (const field of TASK_SCOPED_FIELDS) state[field] = null;
}

/**
 * 把一条原始报文合并进已有状态。
 *
 * @param {object} state 已有状态（不会被修改）
 * @param {object} raw 设备上报的 `print` 对象
 * @param {{ receivedAt?: number, previousTaskName?: string|null }} [options]
 * @returns {{ state: object, reason: string|null, taskSwitched: boolean }}
 */
function reduceReport(state, raw, { receivedAt = Date.now(), amsIdentities = [] } = {}) {
  const base = state ? cloneState(state) : emptyPrinterState();
  const identities = Array.isArray(amsIdentities) ? amsIdentities.filter(item => item &&
    typeof item.id === "string" && /^\d+$/.test(item.id) && Number.isSafeInteger(Number(item.id)) &&
    ["AMS", "AMS Lite", "AMS 2 Pro", "AMS HT", "AMS 3H"].includes(item.model)) : [];
  if ((!raw || typeof raw !== "object" || Array.isArray(raw)) && !identities.length) {
    return { state: base, reason: "invalid-report", taskSwitched: false };
  }

  const patch = mapReport(raw);
  const hasPrintUpdate = Object.keys(patch).length > 0;
  if (identities.length) {
    patch.ams ||= {};
    patch.ams.units ||= [];
    for (const identity of identities) {
      const unit = patch.ams.units.find(item => item.id === identity.id);
      if (unit) unit.model = identity.model;
      else patch.ams.units.push({ id: identity.id, model: identity.model });
    }
  }
  if (Object.keys(patch).length === 0) {
    return { state: base, reason: "empty-report", taskSwitched: false };
  }

  let reason = null;
  let taskSwitched = false;

  if (isTaskSwitch(base, raw)) {
    clearTaskFields(base);
    for (const key of [...TASK_SCOPED_FIELDS, "taskName", "rawTaskName", "taskId"]) delete base.freshness.fields[key];
    // 切换后不能把旧任务的名称或标识留给后续增量。
    base.taskName = null;
    base.rawTaskName = null;
    base.taskId = null;
    taskSwitched = true;
    reason = "task-switched";
  } else if (isFullSnapshot(raw) && base.lastReportAt !== null) {
    // 完整快照以报文为准：先清掉会因旧任务残留的字段，再合并。
    reason = "full-snapshot";
  }

  const next = { ...base };

  if (Object.hasOwn(patch, "activity")) {
    next.activity = patch.activity;
    next.rawActivity = patch.rawActivity;
  }
  if (Object.hasOwn(patch, "progressPercent")) next.progressPercent = patch.progressPercent;
  if (Object.hasOwn(patch, "remainingMinutes")) next.remainingMinutes = patch.remainingMinutes;
  if (Object.hasOwn(patch, "taskName")) {
    next.taskName = patch.taskName;
    next.rawTaskName = patch.rawTaskName;
  }
  if (Object.hasOwn(patch, "taskId")) next.taskId = patch.taskId;
  if (Object.hasOwn(patch, "printError")) next.printError = patch.printError;
  if (Object.hasOwn(patch, "printErrorCode")) next.printErrorCode = patch.printErrorCode;
  next.errorCode = (next.printError !== 0 ? next.printError : null) ?? (next.printErrorCode !== 0 ? next.printErrorCode : null) ?? null;
  if (Object.hasOwn(patch, "hms")) next.hms = patch.hms;
  if (Object.hasOwn(patch, "ams")) {
    const oldAms = next.ams ? structuredClone(next.ams) : null;
    const hasNewBits = Object.hasOwn(patch.ams || {}, "existBits");
    const presenceMeta = next.freshness.ams;
    const modelChanged = patch.ams?.units?.some(update => {
      const old = oldAms?.units?.find(unit => unit.id === update.id);
      return update.model && old?.model && old.model !== update.model;
    });
    const presenceFresh = hasNewBits || (!modelChanged && presenceIsFresh(presenceMeta.fields.existBits, receivedAt));
    if (!presenceFresh) {
      // 长时间未更新、断线或时钟回退后，旧空槽只是旧观测，不能阻挡新数据。
      if (presenceMeta.fields.existBits) presenceMeta.fields.existBits.stale = true;
      for (const unit of Object.values(presenceMeta.units)) {
        for (const slot of Object.values(unit.slots)) {
          if (slot.exists) slot.exists.stale = true;
        }
      }
    }
    next.ams = mergeAms(next.ams, patch.ams, presenceFresh);
    recordAmsFreshness(next.freshness, oldAms, next.ams, patch.ams, receivedAt, presenceFresh);
    // 列表显式未知后，先前存在掩码不能约束重新出现的槽位；同报文的新掩码仍有效。
    const resetList = patch.ams && (patch.ams.units === null || patch.ams.units?.some((unit) => unit.slots === null));
    if (resetList && !hasNewBits && presenceMeta.fields.existBits) presenceMeta.fields.existBits.stale = true;
  }
  if (Object.hasOwn(patch, "amsStatus")) {
    if (!next.ams) next.ams = emptyAms();
    next.ams.rawStatus = patch.amsStatus;
    next.freshness.ams.fields.rawStatus = stamp(receivedAt);
  }

  if (Object.hasOwn(patch, "nozzleCurrent")) next.nozzle = { ...next.nozzle, current: patch.nozzleCurrent };
  if (Object.hasOwn(patch, "nozzleTarget")) next.nozzle = { ...next.nozzle, target: patch.nozzleTarget };
  if (Object.hasOwn(patch, "bedCurrent")) next.bed = { ...next.bed, current: patch.bedCurrent };
  if (Object.hasOwn(patch, "bedTarget")) next.bed = { ...next.bed, target: patch.bedTarget };
  if (Object.hasOwn(patch, "chamberCurrent")) next.chamber = { ...next.chamber, current: patch.chamberCurrent };

  for (const group of ["fans", "rawFans"]) {
    if (!patch[group]) continue;
    Object.assign(next[group], patch[group]);
    for (const fan of Object.keys(patch[group])) next.freshness.fields[`${group}.${fan}`] = stamp(receivedAt);
  }

  if (Object.hasOwn(patch, "layerNum")) next.layerNum = patch.layerNum;
  if (Object.hasOwn(patch, "totalLayerNum")) next.totalLayerNum = patch.totalLayerNum;

  for (const [source, field] of Object.entries(FRESH_FIELDS)) {
    if (Object.hasOwn(patch, source)) next.freshness.fields[field] = stamp(receivedAt);
  }
  if (hasPrintUpdate) {
    next.lastReportAt = receivedAt;
    // 身份元数据不能把打印遥测标为实时。
    next.reportStale = false;
  }
  return { state: next, reason, taskSwitched };
}

/**
 * 连接状态变化。连接断开不清空已收到的数据，只标记"不再实时"。
 */
function reduceConnection(state, connection) {
  const next = state ? cloneState(state) : emptyPrinterState();
  next.connection = connection;
  if (connection !== "connected") {
    next.reportStale = true;
    markStale(next.freshness);
  }
  return next;
}

/** 设备切换：整体重置，避免把旧设备的状态带到新设备。 */
function resetForPrinter(printerId) {
  return emptyPrinterState(printerId);
}

module.exports = {
  TASK_SCOPED_FIELDS,
  cloneState,
  clearTaskFields,
  reduceReport,
  reduceConnection,
  resetForPrinter,
};
