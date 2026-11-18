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
 * - 数组（如 AMS）不深合并，第一版直接不解析。
 */

/** 任务切换时需要清理的字段：这些字段属于上一个任务。 */
const TASK_SCOPED_FIELDS = ["progressPercent", "remainingMinutes", "layerNum", "totalLayerNum", "errorCode"];

function cloneState(state) {
  return {
    ...state,
    nozzle: { ...state.nozzle },
    bed: { ...state.bed },
    hms: state.hms ? state.hms.map((item) => ({ ...item })) : state.hms,
  };
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
function reduceReport(state, raw, { receivedAt = Date.now() } = {}) {
  const base = state ? cloneState(state) : emptyPrinterState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { state: base, reason: "invalid-report", taskSwitched: false };
  }

  let reason = null;
  let taskSwitched = false;

  if (isTaskSwitch(base, raw)) {
    clearTaskFields(base);
    taskSwitched = true;
    reason = "task-switched";
  } else if (isFullSnapshot(raw) && base.lastReportAt !== null) {
    // 完整快照以报文为准：先清掉会因旧任务残留的字段，再合并。
    reason = "full-snapshot";
  }

  const patch = mapReport(raw);
  const next = { ...base };

  if (Object.hasOwn(patch, "activity")) {
    next.activity = patch.activity;
    next.rawActivity = patch.rawActivity;
  }
  if (Object.hasOwn(patch, "progressPercent")) next.progressPercent = patch.progressPercent;
  if (Object.hasOwn(patch, "remainingMinutes")) next.remainingMinutes = patch.remainingMinutes;
  if (Object.hasOwn(patch, "taskName")) next.taskName = patch.taskName;
  if (Object.hasOwn(patch, "errorCode")) next.errorCode = patch.errorCode;
  if (Object.hasOwn(patch, "hms")) next.hms = patch.hms;

  if (Object.hasOwn(patch, "nozzleCurrent")) next.nozzle = { ...next.nozzle, current: patch.nozzleCurrent };
  if (Object.hasOwn(patch, "nozzleTarget")) next.nozzle = { ...next.nozzle, target: patch.nozzleTarget };
  if (Object.hasOwn(patch, "bedCurrent")) next.bed = { ...next.bed, current: patch.bedCurrent };
  if (Object.hasOwn(patch, "bedTarget")) next.bed = { ...next.bed, target: patch.bedTarget };

  if (Object.hasOwn(patch, "layerNum")) next.layerNum = patch.layerNum;
  if (Object.hasOwn(patch, "totalLayerNum")) next.totalLayerNum = patch.totalLayerNum;

  next.lastReportAt = receivedAt;
  return { state: next, reason, taskSwitched };
}

/**
 * 连接状态变化。连接断开不清空已收到的数据，只标记"不再实时"。
 */
function reduceConnection(state, connection) {
  const next = state ? cloneState(state) : emptyPrinterState();
  next.connection = connection;
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
