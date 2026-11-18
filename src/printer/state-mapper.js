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

function rawTaskName(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mapTaskName(value) {
  const trimmed = rawTaskName(value);
  if (trimmed === null) return null;
  return trimmed.length > MAX_TASK_NAME ? `${trimmed.slice(0, MAX_TASK_NAME - 1)}…` : trimmed;
}

// 上游 task_id 为字符串；"0" 也用于默认占位，不能据此断言任务身份。
function mapTaskId(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    return String(value);
  }
  if (typeof value !== "string") return null;
  const id = value.trim();
  return !id || /^0+$/.test(id) ? null : id;
}

/** null 表示未知；数值 0 表示设备报告无错；非零值保留原始码。 */
function mapErrorValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? (value === 0 ? 0 : String(value)) : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const code = value.trim();
  return finiteNumber(code) === 0 ? 0 : code;
}

/** 兼容旧聚合字段：仅输出非零错误码。 */
function mapErrorCode(raw) {
  return mapErrorValue(raw?.print_error) || mapErrorValue(raw?.mc_print_error_code) || null;
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

function amsId(value) {
  const number = finiteNumber(value);
  return number !== null && Number.isSafeInteger(number) && number >= 0 ? String(number) : null;
}

function amsRawValue(value) {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : null;
}

/** 仅映射实际出现的 AMS 字段，缺失字段留给 reducer 合并。 */
function mapAms(raw) {
  if (raw === null) return null;
  const patch = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (Object.hasOwn(raw, "tray_exist_bits")) {
      const value = raw.tray_exist_bits;
      const text = typeof value === "string" ? value.trim() :
        Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
      // Upstream parses the textual value as hexadecimal, including numeric input.
      if (/^(?:0x)?[0-9a-f]{1,128}$/i.test(text)) patch.existBits = text.replace(/^0x/i, "").toLowerCase();
    }
    if (Object.hasOwn(raw, "tray_now") && (raw.tray_now === null || amsRawValue(raw.tray_now) !== null)) {
      patch.rawTrayNow = amsRawValue(raw.tray_now);
      const index = finiteNumber(raw.tray_now);
      patch.current = Number.isSafeInteger(index) && index >= 0 && index < 254
        ? { unitId: String(index >= 80 ? index : Math.floor(index / 4)), slotId: String(index >= 80 ? 0 : index % 4) }
        : null;
    }
    if (raw.ams === null) {
      patch.units = null;
    } else if (Array.isArray(raw.ams)) {
      patch.units = raw.ams.flatMap((unit) => {
        if (!unit || typeof unit !== "object" || Array.isArray(unit)) return [];
        const id = amsId(unit.id);
        if (id === null) return [];
        const mapped = { id };
        if (unit.tray === null) {
          mapped.slots = null;
        } else if (Array.isArray(unit.tray)) {
          mapped.slots = unit.tray.flatMap((slot) => {
            if (!slot || typeof slot !== "object" || Array.isArray(slot)) return [];
            const slotId = amsId(slot.id);
            if (slotId === null) return [];
            const result = { id: slotId };
            if (Object.hasOwn(slot, "tray_color") && (slot.tray_color === null ||
                (typeof slot.tray_color === "string" && /^[0-9a-f]{8}$/i.test(slot.tray_color)))) {
              result.color = slot.tray_color;
            }
            if (Object.hasOwn(slot, "tray_type") && (slot.tray_type === null || typeof slot.tray_type === "string")) {
              result.material = typeof slot.tray_type === "string" && slot.tray_type.trim()
                ? slot.tray_type.trim() : null;
            }
            if (Object.hasOwn(slot, "remain")) {
              const remaining = mapProgress(slot.remain);
              if (slot.remain === null || finiteNumber(slot.remain) === -1 || remaining !== null) result.remaining = remaining;
            }
            if (Object.hasOwn(slot, "state") && (slot.state === null || amsRawValue(slot.state) !== null)) {
              result.rawState = amsRawValue(slot.state);
            }
            return [result];
          });
          if (unit.tray.length && !mapped.slots.length) delete mapped.slots;
        }
        return [mapped];
      });
      // 无效条目不能被误当作明确的空列表。
      if (raw.ams.length && !patch.units.length) delete patch.units;
    }
  }
  return patch;
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
  if (Object.hasOwn(raw, RAW_FIELDS.taskName)) {
    patch.taskName = mapTaskName(raw.subtask_name);
    patch.rawTaskName = rawTaskName(raw.subtask_name);
  }
  if (Object.hasOwn(raw, "task_id")) patch.taskId = mapTaskId(raw.task_id);
  if (Object.hasOwn(raw, RAW_FIELDS.nozzleCurrent)) patch.nozzleCurrent = mapTemperature(raw.nozzle_temper);
  if (Object.hasOwn(raw, RAW_FIELDS.nozzleTarget)) patch.nozzleTarget = mapTemperature(raw.nozzle_target_temper);
  if (Object.hasOwn(raw, RAW_FIELDS.bedCurrent)) patch.bedCurrent = mapTemperature(raw.bed_temper);
  if (Object.hasOwn(raw, RAW_FIELDS.bedTarget)) patch.bedTarget = mapTemperature(raw.bed_target_temper);
  if (Object.hasOwn(raw, RAW_FIELDS.layerNum)) patch.layerNum = finiteNumber(raw.layer_num);
  if (Object.hasOwn(raw, RAW_FIELDS.totalLayerNum)) patch.totalLayerNum = finiteNumber(raw.total_layer_num);
  if (Object.hasOwn(raw, RAW_FIELDS.hms)) patch.hms = mapHms(raw.hms);
  if (Object.hasOwn(raw, "ams") && (raw.ams === null || (typeof raw.ams === "object" && !Array.isArray(raw.ams)))) {
    const ams = mapAms(raw.ams);
    if (ams === null || Object.keys(ams).length > 0) patch.ams = ams;
  }
  if (Object.hasOwn(raw, "ams_status")) patch.amsStatus = amsRawValue(raw.ams_status);

  if (Object.hasOwn(raw, RAW_FIELDS.printError)) patch.printError = mapErrorValue(raw.print_error);
  if (Object.hasOwn(raw, RAW_FIELDS.printErrorCode)) patch.printErrorCode = mapErrorValue(raw.mc_print_error_code);

  // 显式 null 可以表达未知；格式错误或越界的值不构成有效状态更新。
  for (const [field, source] of Object.entries({
    progressPercent: "mc_percent", remainingMinutes: "mc_remaining_time",
    nozzleCurrent: "nozzle_temper", nozzleTarget: "nozzle_target_temper",
    bedCurrent: "bed_temper", bedTarget: "bed_target_temper",
    layerNum: "layer_num", totalLayerNum: "total_layer_num",
  })) {
    if (Object.hasOwn(patch, field) && raw[source] !== null && patch[field] === null) delete patch[field];
  }
  if (Object.hasOwn(patch, "activity") && raw.gcode_state !== null &&
      (typeof raw.gcode_state !== "string" || !raw.gcode_state.trim())) {
    delete patch.activity;
    delete patch.rawActivity;
  }
  if (Object.hasOwn(patch, "hms") && raw.hms !== null && !Array.isArray(raw.hms)) delete patch.hms;
  if (Object.hasOwn(patch, "taskName") && raw.subtask_name !== null && typeof raw.subtask_name !== "string") {
    delete patch.taskName;
    delete patch.rawTaskName;
  }
  if (Object.hasOwn(patch, "taskId") && raw.task_id !== null &&
      typeof raw.task_id !== "string" && typeof raw.task_id !== "number") delete patch.taskId;
  if (Object.hasOwn(patch, "amsStatus") && raw.ams_status !== null && patch.amsStatus === null) delete patch.amsStatus;
  for (const [field, source] of [["printError", "print_error"], ["printErrorCode", "mc_print_error_code"]]) {
    const value = raw[source];
    if (Object.hasOwn(patch, field) && value !== null &&
        !((typeof value === "string" && value.trim()) || (typeof value === "number" && Number.isFinite(value)))) delete patch[field];
  }
  return patch;
}

/** 是否为完整快照（而不是增量）。属于待实机验证的启发式规则。 */
function isFullSnapshot(raw) {
  if (!raw || typeof raw !== "object") return false;
  const present = FULL_SNAPSHOT_FIELDS.every((field) => Object.hasOwn(raw, field));
  return present && typeof raw.gcode_state === "string" && raw.gcode_state.trim() !== "" &&
    mapProgress(raw.mc_percent) !== null && finiteNumber(raw.nozzle_temper) !== null &&
    finiteNumber(raw.bed_temper) !== null;
}

/** 先比较可用 task_id，再以未截断的名称作为回退。 */
function isTaskSwitch(previous, raw) {
  if (!raw || typeof raw !== "object" || !previous) return false;
  const nextId = mapTaskId(raw.task_id);
  const previousId = mapTaskId(previous.taskId);
  if (nextId !== null && previousId !== null) return nextId !== previousId;
  const nextName = rawTaskName(raw.subtask_name);
  const previousName = previous.rawTaskName ?? previous.taskName;
  return nextName !== null && previousName != null && nextName !== previousName;
}

function emptyPrinterState(printerId) {
  return {
    printerId: printerId || "",
    connection: "disconnected",
    reportStale: true,
    // 缺少键表示该字段从未收到有效报告；新旧只描述连接代次，不表示值的有效性。
    freshness: { fields: {}, ams: { fields: {}, units: {} } },
    activity: "unknown",
    rawActivity: null,
    progressPercent: null,
    remainingMinutes: null,
    taskName: null,
    rawTaskName: null,
    taskId: null,
    nozzle: { current: null, target: null },
    bed: { current: null, target: null },
    layerNum: null,
    totalLayerNum: null,
    printError: null,
    printErrorCode: null,
    errorCode: null,
    hms: null,
    ams: null,
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
