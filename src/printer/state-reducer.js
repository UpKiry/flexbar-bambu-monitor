const {
  emptyPrinterState,
  isFullSnapshot,
  isTaskSwitch,
  mapReport,
} = require("./state-mapper");

/**
 * 快照与增量合并（见 docs/设备协议与状态模型.md「领域值、增量与任务切换」）。
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
const { amsAbsenceIsFresh } = require("./observation-policy");
const { mergeAms, recordAmsFreshness, emptyAms } = require("./ams-reducer");

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

// AMS 旧空槽证据的保护期由共享策略单独定义，不与展示兼容回退混用。
function presenceIsFresh(mark, at) {
  return amsAbsenceIsFresh(mark, at);
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

// AMS 合并与时效维护见 ams-reducer.js。
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
