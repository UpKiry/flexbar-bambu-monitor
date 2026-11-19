const {
  TELEMETRY_TIMEOUT_MS,
  FIELD_STALE_MS,
  validTelemetryTime,
  presenceIsActive,
} = require("../../printer/observation-policy");
const { formatDateTime } = require("./format");

/**
 * 浏览器展示模型：把状态快照翻译成文案与可见性。
 *
 * 与 Flexbar 展示共用 observation-policy 的时效规则，但这里不生成 Canvas 数据。
 * 快照在两次轮询之间会变旧，因此所有时效判断都以调用时的 now 为准，
 * 不能把"本机服务可用"当作"打印机刚上报"。
 */

function telemetryActive(presence, now = Date.now()) {
  return presenceIsActive(presence, now);
}

/** 观测上下文：presence 与连接状态共同决定"读数是否还能当当前值显示"。 */
function createObservationContext(data) {
  const presence = data?.printer?.presence || data?.printer?.state?.presence || null;
  if (!presence) return null;
  return { presence, link: data.printer.link?.state || "idle" };
}

function withFreshness(value, freshness, context, now = Date.now()) {
  if (!freshness || !Number.isFinite(freshness.at) || freshness.at > now) return `${value}（更新时间未知）`;
  const active = context ? context.link === "connected" && telemetryActive(context.presence, now) : null;
  if (freshness.stale === true || (context ? !active : now - freshness.at > FIELD_STALE_MS)) return `${value}（旧数据）`;
  if (freshness.stale !== false) return `${value}（更新时间未知）`;
  return String(value);
}

function formatTemperature(sensor, currentFreshness, targetFreshness, context, now) {
  const current = typeof sensor?.current === "number" && Number.isFinite(sensor.current) ? `${Math.round(sensor.current)}℃` : "—";
  const formatted = withFreshness(current, currentFreshness, context, now);
  if (typeof sensor?.target !== "number" || !Number.isFinite(sensor.target)) return formatted;
  return `${formatted} → ${withFreshness(`${Math.round(sensor.target)}℃`, targetFreshness, context, now)}`;
}

function labelForPresence(presence, linkState, now = Date.now()) {
  if (linkState !== "connected") return "云端连接中断，打印机状态未知";
  if (presence?.state === "offline") return "打印机离线";
  if (presence?.state === "unresponsive") return "设备无响应";
  if (presence?.state === "syncing") return "等待设备同步";
  if (presence?.state === "online") {
    if (!validTelemetryTime(presence.lastTelemetryAt, now)) return "打印机状态未知";
    return now - presence.lastTelemetryAt < TELEMETRY_TIMEOUT_MS ? "打印机在线" : "设备无响应";
  }
  return "等待设备上报";
}

function labelForActivity(activity, rawActivity) {
  const labels = {
    idle: "空闲",
    preparing: "准备中",
    printing: "打印中",
    paused: "已暂停",
    finished: "打印完成",
    failed: "打印异常",
    unknown: "未知",
  };
  if (activity && activity !== "unknown" && Object.hasOwn(labels, activity)) return labels[activity];
  return rawActivity ? `未知（原始值 ${rawActivity}）` : activity && activity !== "unknown" ? `未知（原始值 ${activity}）` : "未知";
}

function labelForLink(linkState, link) {
  if (linkState === "connected") return "云端连接正常";
  if (linkState === "connecting") return "正在连接云端";
  if (linkState === "reconnecting") return `连接中断，正在重连${link?.attempt ? `（第 ${link.attempt} 次）` : ""}`;
  if (linkState === "failed") return link?.lastError?.message || "云端连接失败";
  return "未连接";
}

function labelForRegion(regionId, regions) {
  if (!Array.isArray(regions)) return regionId === "china" ? "中国大陆" : "全球";
  return regions.find((item) => item.id === regionId)?.label || regions[0]?.label || "全球";
}

function accountKindError(account, region) {
  const hasEmail = typeof account === "string" && account.includes("@");
  if (region === "china" && hasEmail) return "中国大陆账号只能使用手机号登录";
  if (region !== "china" && !hasEmail) return "全球账号请使用邮箱登录";
  return "";
}

function formatErrorChannel(value, freshness, context, now) {
  const text = value === null || value === undefined ? "未知"
    : value === 0 ? "已清除（0）" : `原始码 ${value}`;
  return withFreshness(text, freshness, context, now);
}

function formatLayers(current, total) {
  const valid = (value) => Number.isFinite(value) && value >= 0;
  if (!valid(current) && !valid(total)) return "—";
  return `${valid(current) ? current : "未知"} / ${valid(total) ? total : "未知"}`;
}

/** 设备列表摘要使用的在线状态后缀；未知不等于离线。 */
function deviceSuffix(online) {
  return online === true ? "（在线）" : online === false ? "（离线）" : "（在线状态未知）";
}

module.exports = {
  telemetryActive,
  createObservationContext,
  withFreshness,
  formatTemperature,
  labelForPresence,
  labelForActivity,
  labelForLink,
  labelForRegion,
  accountKindError,
  formatErrorChannel,
  formatLayers,
  deviceSuffix,
  formatDateTime,
};
