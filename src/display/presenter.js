/**
 * 状态 → 展示模型（见 docs/云端监控设计方案.md §3.2）。
 *
 * 这里只负责"把状态翻译成一句话 + 一种语气"，不接触任何 FlexDesigner API，
 * 因此可以脱离宿主做单元测试。绘制的节流也在这里：绘制频率限制属于展示逻辑。
 */

const VIEWS = ["progress", "temperature", "task"];
// 连接仍存在时也可能很久没有设备报告；阈值只表示数据旧，不表示设备离线。
const REPORT_STALE_MS = 5 * 60_000;

const TONES = {
  muted: "muted",
  normal: "normal",
  positive: "positive",
  warning: "warning",
  critical: "critical",
};

function fieldIsFresh(state, field, now) {
  // 兼容未带字段级信息的旧状态；新模型缺少标记表示未报告。
  if (!state?.freshness?.fields) return state?.reportStale !== true && Number.isFinite(state?.lastReportAt) && now - state.lastReportAt < REPORT_STALE_MS;
  const mark = state.freshness.fields[field];
  return Boolean(mark && mark.stale === false && Number.isFinite(mark.at) && now >= mark.at && now - mark.at < REPORT_STALE_MS);
}

/**
 * 按设计文档的表格生成展示文案。
 *
 * @param {object} input
 * @param {boolean} input.signedIn
 * @param {boolean} input.authExpired
 * @param {boolean} input.hasPrinter
 * @param {string} [input.printerName]
 * @param {object} [input.state] PrinterState
 * @param {object} [input.link] { state: 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'idle', lastError }
 * @param {number} [input.now]
 * @returns {{ tone: string, title: string, subtitle: string, icon: string, stale: boolean }}
 */
function buildDisplay({ signedIn, authExpired, hasPrinter, state, link, now = Date.now() }) {
  if (!signedIn) {
    return {
      tone: TONES.muted,
      title: authExpired ? "登录已失效" : "请登录",
      subtitle: authExpired ? "请重新登录 Bambu 账号" : "在插件设置中登录 Bambu 账号",
      icon: "account",
      stale: true,
    };
  }
  if (!hasPrinter) {
    return {
      tone: TONES.muted,
      title: "请选择打印机",
      subtitle: "在插件设置中选择要显示的设备",
      icon: "printer",
      stale: true,
    };
  }

  const linkState = link?.state || "idle";
  if (linkState === "connecting") {
    return { tone: TONES.muted, title: "正在连接云端", subtitle: "", icon: "cloud", stale: true };
  }
  if (linkState === "failed") {
    return {
      tone: TONES.critical,
      title: "云端断开",
      subtitle: link?.lastError?.message || "云连接已断开",
      icon: "cloud-off",
      stale: true,
    };
  }

  if (!state || state.lastReportAt === null) {
    return { tone: TONES.muted, title: "等待打印机状态", subtitle: "", icon: "clock", stale: true };
  }

  const activity = state.activity || "unknown";
  const hasFieldMarks = Boolean(state.freshness?.fields);
  const freshError = hasFieldMarks
    ? (state.printError && fieldIsFresh(state, "printError", now) ? state.printError
      : state.printErrorCode && fieldIsFresh(state, "printErrorCode", now) ? state.printErrorCode : null)
    : state.errorCode;
  const freshHms = Array.isArray(state.hms) && state.hms.length > 0 && fieldIsFresh(state, "hms", now);
  if (linkState === "connected" && (freshError || freshHms)) {
    return {
      tone: TONES.critical,
      title: activity === "failed" && fieldIsFresh(state, "activity", now) ? "打印异常" : "设备报告故障",
      subtitle: freshError ? `错误码 ${freshError}` : "请在后台查看故障原始信息",
      icon: "alert",
      stale: false,
    };
  }

  const timedOut = Number.isFinite(state.lastReportAt) && now - state.lastReportAt >= REPORT_STALE_MS;
  const relevantFields = ["activity"];
  if (activity === "printing" || activity === "paused") {
    if (state.progressPercent !== null) relevantFields.push("progressPercent");
    if (activity === "printing" && state.remainingMinutes !== null) relevantFields.push("remainingMinutes");
  } else if ((activity === "finished" || activity === "preparing") && state.taskName) relevantFields.push("taskName");
  else if (activity === "idle" && state.nozzle?.current !== null && state.nozzle?.current !== undefined) relevantFields.push("nozzle.current");
  const fieldsStale = hasFieldMarks && relevantFields.some((field) => !fieldIsFresh(state, field, now));
  const stale = linkState !== "connected" || state.reportStale === true || timedOut || fieldsStale;
  if (stale) {
    return {
      tone: TONES.warning,
      title: "数据已过期",
      subtitle: linkState !== "connected" ? "云端连接中断，显示最后已知状态"
        : timedOut ? "长时间未收到设备状态" : fieldsStale ? "部分显示数据较旧" : "等待重新收到设备状态",
      icon: "cloud-off",
      stale: true,
    };
  }

  if (activity === "printing") {
    return {
      tone: TONES.normal,
      title: "打印中",
      subtitle: `进度 ${formatPercent(state.progressPercent)} · 剩余 ${formatMinutes(state.remainingMinutes)}`,
      icon: "printer-3d",
      stale: false,
    };
  }
  if (activity === "paused") {
    return {
      tone: TONES.warning,
      title: "已暂停",
      subtitle: state.progressPercent === null ? "" : `当前进度 ${formatPercent(state.progressPercent)}`,
      icon: "pause",
      stale,
    };
  }
  if (activity === "finished") {
    return { tone: TONES.positive, title: "打印完成", subtitle: state.taskName || "", icon: "check", stale };
  }
  if (activity === "failed") {
    return {
      tone: TONES.critical,
      title: "打印异常",
      subtitle: freshError ? `错误码 ${freshError}` : "设备报告打印失败",
      icon: "alert",
      stale,
    };
  }
  if (activity === "preparing") {
    return { tone: TONES.normal, title: "准备中", subtitle: state.taskName || "", icon: "hourglass", stale };
  }
  if (activity === "idle") {
    return {
      tone: TONES.normal,
      title: "打印机空闲",
      subtitle: state.nozzle?.current === null ? "" : `${Math.round(state.nozzle.current)}℃`,
      icon: "printer-3d",
      stale,
    };
  }

  // 未知状态：保留原始值，不猜测。
  return {
    tone: TONES.muted,
    title: "状态未知",
    subtitle: state.rawActivity ? `原始状态 ${state.rawActivity}` : "",
    icon: "help",
    stale: true,
  };
}

function formatPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}%`;
}

function formatMinutes(minutes) {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) return "—";
  if (minutes < 60) return `${Math.round(minutes)} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

/** 按键视图：进度、温度、任务信息。 */
function buildViewDetails(state, view) {
  if (!state || state.lastReportAt === null) return { title: "无数据", subtitle: "" };
  if (view === "temperature") {
    const nozzle = formatTemperature(state.nozzle);
    const bed = formatTemperature(state.bed);
    return { title: `喷嘴 ${nozzle}`, subtitle: `热床 ${bed}` };
  }
  if (view === "task") {
    const layers = state.totalLayerNum ? `${state.layerNum ?? "—"}/${state.totalLayerNum} 层` : "";
    return { title: state.taskName || "无任务信息", subtitle: layers };
  }
  return {
    title: formatPercent(state.progressPercent),
    subtitle: `剩余 ${formatMinutes(state.remainingMinutes)}`,
  };
}

function formatTemperature(sensor) {
  if (!sensor) return "—";
  const current = typeof sensor.current === "number" ? `${Math.round(sensor.current)}℃` : "—";
  if (typeof sensor.target !== "number") return current;
  return `${current} → ${Math.round(sensor.target)}℃`;
}

function nextView(view) {
  const index = VIEWS.indexOf(view);
  return VIEWS[(index + 1) % VIEWS.length];
}

/**
 * 绘制节流。
 *
 * 设计文档 §6.4：数据到达立即更新内存；常规绘制最多每秒一次，
 * 状态切换、断线和故障可以立即更新。
 */
function createDrawThrottle({ intervalMs = 1_000, now = () => Date.now() } = {}) {
  let lastDrawAt = 0;
  let lastFingerprint = "";
  let hasDrawn = false;
  let pending = null;

  return {
    /**
     * @param {string} fingerprint 展示模型指纹，相同则不重绘
     * @param {boolean} urgent 状态切换 / 断线 / 故障
     * @returns {boolean} 是否应立即绘制
     */
    shouldDraw(fingerprint, { urgent = false } = {}) {
      const stamp = now();
      if (fingerprint === lastFingerprint) return false;
      // 首帧必须立即画出来，否则按键会空白一整个间隔。
      if (urgent || !hasDrawn) {
        lastFingerprint = fingerprint;
        lastDrawAt = stamp;
        hasDrawn = true;
        pending = null;
        return true;
      }
      if (stamp - lastDrawAt < intervalMs) {
        pending = fingerprint;
        return false;
      }
      lastFingerprint = fingerprint;
      lastDrawAt = stamp;
      pending = null;
      return true;
    },
    /** 定时器到点后检查是否有被节流掉的绘制。 */
    takePending() {
      if (!pending) return null;
      const stamp = now();
      if (stamp - lastDrawAt < intervalMs) return null;
      const fingerprint = pending;
      pending = null;
      lastFingerprint = fingerprint;
      lastDrawAt = stamp;
      hasDrawn = true;
      return fingerprint;
    },
    reset() {
      lastDrawAt = 0;
      lastFingerprint = "";
      hasDrawn = false;
      pending = null;
    },
  };
}

function fingerprintDisplay(display, view) {
  return [
    display?.tone,
    display?.title,
    display?.subtitle,
    display?.icon,
    display?.stale ? "s" : "f",
    view,
  ].join("|");
}

/**
 * 完成与故障通知按任务标识和状态转换去重（设计文档 §6.4）。
 * 返回 null 表示这条通知不应重复发送。
 */
function createNotificationDeduper() {
  const lastSent = new Map();
  return {
    shouldNotify(kind, state) {
      const taskKey = state?.taskName || state?.printerId || "unknown";
      const key = `${kind}:${taskKey}`;
      const previous = lastSent.get(key);
      if (previous === true) return false;
      lastSent.set(key, true);
      if (lastSent.size > 100) {
        const firstKey = lastSent.keys().next().value;
        lastSent.delete(firstKey);
      }
      return true;
    },
    resetTask(taskKey) {
      for (const key of [...lastSent.keys()]) {
        if (key.endsWith(`:${taskKey}`)) lastSent.delete(key);
      }
    },
    clear() {
      lastSent.clear();
    },
  };
}

module.exports = {
  VIEWS,
  TONES,
  buildDisplay,
  fieldIsFresh,
  buildViewDetails,
  formatPercent,
  formatMinutes,
  formatTemperature,
  nextView,
  createDrawThrottle,
  fingerprintDisplay,
  createNotificationDeduper,
};
