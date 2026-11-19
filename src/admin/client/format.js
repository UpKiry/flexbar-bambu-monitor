/**
 * 浏览器后台的时间与数值格式化。纯函数，不访问 DOM 或状态。
 */

function formatTime(timestamp) {
  if (!Number.isFinite(timestamp)) return "—";
  try {
    return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return "—";
  }
}

function formatDateTime(timestamp) {
  if (!Number.isFinite(timestamp)) return "—";
  try {
    return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return "—";
  }
}

function formatAge(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) return "—";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) return "—";
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
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

module.exports = {
  formatTime,
  formatDateTime,
  formatAge,
  formatDuration,
  formatPercent,
  formatMinutes,
};
