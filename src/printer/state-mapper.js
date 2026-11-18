/**
 * 原始设备状态 → 统一领域模型（见 docs/云端监控设计方案.md §6.3）。
 *
 * 约定：
 * - `null` 表示未知或不可用，不转换成 0；
 * - 无法识别的状态映射为 `unknown`，原始值保留在 `rawActivity`；
 * - 错误码只在含义可确认时解释，否则显示原始错误码；
 * - 这里只做"单字段解释"，增量合并由 state-reducer 负责。
 */

const ACTIVITY_BY_GCODE_STATE = {
  IDLE: "idle",
  PREPARE: "preparing",
  SLICING: "preparing",
  INIT: "preparing",
  RUNNING: "printing",
  PAUSE: "paused",
  FINISH: "finished",
  FAILED: "failed",
};

const RAW_FIELDS = {
  activity: "gcode_state",
  progressPercent: "mc_percent",
  remainingMinutes: "mc_remaining_time",
  taskName: "subtask_name",
  nozzleCurrent: "nozzle_temper",
  nozzleTarget: "nozzle_target_temper",
  bedCurrent: "bed_temper",
  bedTarget: "bed_target_temper",
  printError: "print_error",
  printErrorCode: "mc_print_error_code",
  hms: "hms",
  layerNum: "layer_num",
  totalLayerNum: "total_layer_num",
};

/** 打印核心字段：同时出现时认为是一条完整快照，而不是增量。 */
const FULL_SNAPSHOT_FIELDS = ["gcode_state", "mc_percent", "nozzle_temper", "bed_temper"];

const MAX_TASK_NAME = 60;

function finiteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function mapActivity(rawState) {
  if (typeof rawState !== "string" || !rawState) return { activity: "unknown", rawActivity: null };
  const normalized = rawState.trim().toUpperCase();
  const activity = ACTIVITY_BY_GCODE_STATE[normalized] || "unknown";
  return { activity, rawActivity: rawState };
}

function mapProgress(value) {
  const percent = finiteNumber(value);
  // 设计文档要求检查 0–100；越界视为不可用，而不是裁剪成看似正常的数字。
  if (percent === null || percent < 0 || percent > 100) return null;
  return percent;
}

function mapRemainingMinutes(value) {
  const minutes = finiteNumber(value);
  if (minutes === null || minutes < 0) return null;
  return minutes;
}

function mapTemperature(value) {
  // 不做范围裁剪：0℃ 在冷启动或关机状态下是真实读数，负温度也可能是环境温度。
  return finiteNumber(value);
}

function mapTaskName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TASK_NAME ? `${trimmed.slice(0, MAX_TASK_NAME - 1)}…` : trimmed;
}

/**
 * 错误码。`print_error` 为 0 表示无错误；非 0 时原样展示数字，
 * 不擅自翻译成人话——含义需要按机型与固件验证。
 */
function mapErrorCode(raw) {
  const printError = finiteNumber(raw?.print_error);
  if (printError !== null && printError !== 0) return String(printError);
  const printErrorCode = raw?.mc_print_error_code;
  if (typeof printErrorCode === "string" && printErrorCode && printErrorCode !== "0") return printErrorCode;
  if (finiteNumber(printErrorCode) > 0) return String(printErrorCode);
  return null;
}

/** HMS 只保留可诊断的原始字段，不做错误码解释。 */
function mapHms(hms) {
  if (!Array.isArray(hms)) return null;
  if (hms.length === 0) return [];
  return hms
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      code: item.code == null ? null : String(item.code),
      attr: item.attr == null ? null : String(item.attr),
      module: item.module == null ? null : String(item.module),
    }));
}

/**
 * 把一条原始报文映射成部分领域字段。
 * 只返回"报文中确实出现"的字段，缺失字段由 reducer 保留旧值。
 *
 * @param {object} raw 设备上报对象（已从 `{ print: ... }` 中取出）
 * @returns {{ activity?: string, rawActivity?: string|null, ... }}
 */
function mapReport(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const patch = {};

  if (Object.hasOwn(raw, RAW_FIELDS.activity)) {
    const mapped = mapActivity(raw.gcode_state);
    patch.activity = mapped.activity;
    patch.rawActivity = mapped.rawActivity;
  }
  if (Object.hasOwn(raw, RAW_FIELDS.progressPercent)) patch.progressPercent = mapProgress(raw.mc_percent);
  if (Object.hasOwn(raw, RAW_FIELDS.remainingMinutes)) {
    patch.remainingMinutes = mapRemainingMinutes(raw.mc_remaining_time);
  }
  if (Object.hasOwn(raw, RAW_FIELDS.taskName)) patch.taskName = mapTaskName(raw.subtask_name);
  if (Object.hasOwn(raw, RAW_FIELDS.nozzleCurrent)) patch.nozzleCurrent = mapTemperature(raw.nozzle_temper);
  if (Object.hasOwn(raw, RAW_FIELDS.nozzleTarget)) patch.nozzleTarget = mapTemperature(raw.nozzle_target_temper);
  if (Object.hasOwn(raw, RAW_FIELDS.bedCurrent)) patch.bedCurrent = mapTemperature(raw.bed_temper);
  if (Object.hasOwn(raw, RAW_FIELDS.bedTarget)) patch.bedTarget = mapTemperature(raw.bed_target_temper);
  if (Object.hasOwn(raw, RAW_FIELDS.layerNum)) patch.layerNum = finiteNumber(raw.layer_num);
  if (Object.hasOwn(raw, RAW_FIELDS.totalLayerNum)) patch.totalLayerNum = finiteNumber(raw.total_layer_num);
  if (Object.hasOwn(raw, RAW_FIELDS.hms)) patch.hms = mapHms(raw.hms);

  if (Object.hasOwn(raw, RAW_FIELDS.printError) || Object.hasOwn(raw, RAW_FIELDS.printErrorCode)) {
    patch.errorCode = mapErrorCode(raw);
  }
  return patch;
}

/** 是否为完整快照（而不是增量）。属于待实机验证的启发式规则。 */
function isFullSnapshot(raw) {
  if (!raw || typeof raw !== "object") return false;
  const present = FULL_SNAPSHOT_FIELDS.filter((field) => Object.hasOwn(raw, field));
  return present.length === FULL_SNAPSHOT_FIELDS.length;
}

/** 任务切换：任务名或任务标识变化时清掉上一个任务的数据。 */
function isTaskSwitch(previous, raw) {
  if (!raw || typeof raw !== "object") return false;
  if (!previous) return false;
  const nextName = mapTaskName(raw.subtask_name);
  if (nextName === null) return false;
  return nextName !== previous.taskName;
}

function emptyPrinterState(printerId) {
  return {
    printerId: printerId || "",
    connection: "disconnected",
    activity: "unknown",
    rawActivity: null,
    progressPercent: null,
    remainingMinutes: null,
    taskName: null,
    nozzle: { current: null, target: null },
    bed: { current: null, target: null },
    layerNum: null,
    totalLayerNum: null,
    errorCode: null,
    hms: null,
    lastReportAt: null,
  };
}

module.exports = {
  ACTIVITY_BY_GCODE_STATE,
  RAW_FIELDS,
  FULL_SNAPSHOT_FIELDS,
  MAX_TASK_NAME,
  finiteNumber,
  mapActivity,
  mapProgress,
  mapRemainingMinutes,
  mapTaskName,
  mapErrorCode,
  mapHms,
  mapReport,
  isFullSnapshot,
  isTaskSwitch,
  emptyPrinterState,
};
