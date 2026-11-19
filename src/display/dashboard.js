const { FONT_FAMILY } = require("./fonts");

// 与 presenter 使用相同的上报过期阈值。
const REPORT_STALE_MS = 5 * 60_000;

const WIDTH = 2170;
const HEIGHT = 60;
const ACTIVITY = {
  idle: "空闲", preparing: "准备中", printing: "打印中", paused: "已暂停",
  finished: "已完成", failed: "打印异常",
};
const CONNECTION = {
  connected: "云端已连接", connecting: "云端连接中", reconnecting: "云端重连中",
  failed: "云端已断开", idle: "云端未连接",
};

function validTime(time, now) {
  return Number.isFinite(time) && Number.isFinite(now) && time <= now && now - time < REPORT_STALE_MS;
}

function isFresh(state, field, link, now) {
  if (link?.state !== "connected" || state?.reportStale === true) return false;
  const fields = state?.freshness?.fields;
  if (fields) {
    const mark = fields[field];
    return mark?.stale === false && validTime(mark.at, now);
  }
  return validTime(state?.lastReportAt, now);
}

function valueText(value, valid, format, state, field, link, now) {
  if (!valid(value)) return "—";
  return `${format(value)}${isFresh(state, field, link, now) ? "" : "（旧）"}`;
}

const number = (value) => typeof value === "number" && Number.isFinite(value);
const nonnegative = (value) => number(value) && value >= 0;
const text = (value) => typeof value === "string" && value.trim().length > 0;

function markIsFresh(mark, state, link, now) {
  return link?.state === "connected" && state?.reportStale !== true &&
    mark?.stale === false && validTime(mark.at, now);
}

function amsSummary(state, link, now) {
  const units = state?.ams?.units;
  if (!Array.isArray(units)) return "—";
  const slots = units.flatMap((unit) => Array.isArray(unit?.slots)
    ? unit.slots.filter((slot) => slot && typeof slot === "object").map((slot) => ({ unit, slot })) : []);
  if (!slots.length) return "无槽位数据";
  const summaries = slots.slice(0, 4).map(({ unit, slot }) => {
    const status = slot.exists === true ? "有" : slot.exists === false ? "空" : "未知";
    const mark = state?.freshness?.ams?.units?.[unit.id]?.slots?.[slot.id]?.exists;
    const suffix = slot.exists == null || markIsFresh(mark, state, link, now) ? "" : "(旧)";
    return `${unit.id ?? "?"}:${slot.id ?? "?"} ${status}${suffix}`;
  });
  if (slots.length > 4) summaries.push(`+${slots.length - 4}槽`);
  return summaries.join(" ");
}

function faultSummary(state, shown) {
  const code = (value, key, label) => {
    if (!(number(value) || text(value))) return null;
    return `${label}${shown(value, key, (v) => number(v) || text(v), String)}`;
  };
  const parts = [code(state?.printError, "printError", "错误 "), code(state?.printErrorCode, "printErrorCode", "代码 ")].filter(Boolean);
  if (Array.isArray(state?.hms)) {
    const entries = state.hms.map((entry) => [entry?.code, entry?.attr, entry?.module]
      .filter((value) => text(value) || number(value)).join("/"));
    const value = entries.length ? entries.map((item) => item || "详情未知").join(",") : "无";
    parts.push(`HMS ${shown(value, "hms", text, (v) => v)}`);
  }
  return parts.length ? parts.join(" · ") : "—";
}

/** 构造可独立测试的展示数据；更新时间使用宿主本地时区。 */
function buildDashboardModel({ state, link, signedIn = true, authExpired = false, hasPrinter = true, printerName, now = Date.now() } = {}) {
  let connection = CONNECTION[link?.state] || "云端状态未知";
  if (!signedIn) connection = authExpired ? "登录已失效" : "请登录";
  else if (!hasPrinter) connection = "请选择打印机";
  const effectiveLink = signedIn && hasPrinter ? link : null;
  const shown = (value, key, valid, format) => valueText(value, valid, format, state, key, effectiveLink, now);
  const activity = state?.activity;
  const activityLabel = ACTIVITY[activity] || (text(state?.rawActivity) ? `未知状态 ${state.rawActivity}` : "—");
  const activityKey = ACTIVITY[activity] ? "activity" : "rawActivity";
  const component = (sensor, part) => shown(state?.[sensor]?.[part], `${sensor}.${part}`, number, (v) => `${Math.round(v)}℃`);
  const updated = Number.isFinite(state?.lastReportAt) && Math.abs(state.lastReportAt) <= 8640000000000000
    ? new Date(state.lastReportAt).toLocaleString("zh-CN", { hour12: false }) : "—";
  return {
    printerName: text(printerName) ? printerName.trim() : "打印机",
    connection,
    activity: activityLabel === "—" ? "—" : shown(activityLabel, activityKey, text, (v) => v),
    progress: shown(state?.progressPercent, "progressPercent", (v) => number(v) && v >= 0 && v <= 100, (v) => `${Math.round(v)}%`),
    remaining: shown(state?.remainingMinutes, "remainingMinutes", nonnegative, (v) => {
      const minutes = Math.round(v);
      return minutes >= 60 ? `${Math.floor(minutes / 60)}小时${minutes % 60}分` : `${minutes}分钟`;
    }),
    nozzle: `${component("nozzle", "current")} / ${component("nozzle", "target")}`,
    bed: `${component("bed", "current")} / ${component("bed", "target")}`,
    task: shown(state?.taskName, "taskName", text, (v) => v.trim()),
    layers: `${shown(state?.layerNum, "layerNum", nonnegative, (v) => String(v))} / ${shown(state?.totalLayerNum, "totalLayerNum", nonnegative, (v) => String(v))}`,
    faults: faultSummary(state, shown),
    ams: amsSummary(state, effectiveLink, now),
    updated,
  };
}

/** 使用标准 Canvas 2D 接口绘制；画布为调用方提供。 */
function renderDashboard(canvas, model, { width = WIDTH } = {}) {
  if (!Number.isFinite(width) || width <= 0) throw new TypeError("width 必须为正数");
  const ctx = canvas?.getContext?.("2d");
  if (!ctx) throw new TypeError("需要 Canvas 2D context");
  ctx.save();
  try {
    ctx.scale(width / WIDTH, 1);
    ctx.fillStyle = "#101820";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.textBaseline = "middle";
    const cell = (x, title, value, maxWidth) => {
      ctx.font = `16px "${FONT_FAMILY}", sans-serif`;
      ctx.fillStyle = "#a9b7c5";
      ctx.fillText(title, x, 15, maxWidth);
      ctx.font = `22px "${FONT_FAMILY}", sans-serif`;
      ctx.fillStyle = "#f0f5f7";
      ctx.fillText(String(value), x, 42, maxWidth);
    };
    cell(14, model.printerName, model.connection, 190);
    cell(214, "打印状态", model.activity, 160);
    cell(384, "进度", model.progress, 105);
    cell(499, "剩余时间", model.remaining, 150);
    cell(659, "喷嘴 当前 / 目标", model.nozzle, 190);
    cell(859, "热床 当前 / 目标", model.bed, 190);
    cell(1059, "任务", model.task, 180);
    cell(1249, "层数", model.layers, 120);
    cell(1379, "故障原始码 / HMS", model.faults, 245);
    cell(1634, "AMS 槽位", model.ams, 245);
    cell(1889, "最近设备上报", model.updated, 267);
  } finally {
    ctx.restore();
  }
}

/** createCanvas(width, 60) 必须提供 2D context 和 PNG data URL 编码。 */
async function drawDashboard({ plugin, serialNumber, key, createCanvas, width = WIDTH, ...input } = {}) {
  if (typeof plugin?.directDraw !== "function") throw new TypeError("需要 plugin.directDraw");
  if (typeof createCanvas !== "function") throw new TypeError("需要注入 createCanvas");
  if (!Number.isInteger(width) || width <= 0) throw new TypeError("width 必须为正整数");
  const canvas = createCanvas(width, HEIGHT);
  renderDashboard(canvas, buildDashboardModel(input), { width });
  if (typeof canvas?.toDataURL !== "function") throw new TypeError("画布需要支持 toDataURL");
  const image = canvas.toDataURL("image/png");
  if (typeof image !== "string" || !image.startsWith("data:image/png;base64,")) throw new TypeError("画布未返回 PNG data URL");
  return plugin.directDraw(serialNumber, key, image, false, 0);
}

module.exports = { WIDTH, HEIGHT, buildDashboardModel, renderDashboard, drawDashboard };
