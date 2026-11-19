const { TONES } = require("./presenter");

/**
 * 把展示模型画到 Flexbar 按键上（见 docs/架构设计.md「展示与绘制」）。
 *
 * 关键取舍：
 * - 只用宿主原生标题/图标布局，不自绘 PNG，避免引入 canvas 原生依赖；
 * - 中文不在原生标签里出现乱码的前提是宿主字体，实测后再决定是否自绘；
 * - 颜色按语气映射，状态可一眼分辨。
 */

const BACKGROUNDS = {
  muted: "#14181d",
  normal: "#101a17",
  positive: "#0f1d16",
  warning: "#1e1710",
  critical: "#1e1115",
};

const FOREGROUNDS = {
  muted: "#8c9aad",
  normal: "#54d6a6",
  positive: "#54d6a6",
  warning: "#f2b866",
  critical: "#ff6b7a",
};

/** mdi 图标名在 manifest 里用 "mdi mdi-xxx" 前缀，这里补上。 */
function iconName(icon) {
  return icon ? `mdi mdi-${icon}` : "mdi mdi-printer-3d";
}

/**
 * 修改 key 的展示属性并调用宿主绘制。
 *
 * @param {object} plugin SDK 的 plugin 实例
 * @param {string} serialNumber
 * @param {object} key 原始 key 对象（来自 plugin.alive / plugin.data）
 * @param {{tone: string, title: string, subtitle: string, icon: string}} display
 * @param {{titleText?: string, stale?: boolean}} [options]
 */
async function drawKey(plugin, serialNumber, key, display, { titleText } = {}) {
  if (!plugin || !key) return;
  const tone = Object.hasOwn(BACKGROUNDS, display?.tone) ? display.tone : TONES.muted;
  key.style = key.style || {};
  key.style.showIcon = true;
  key.style.showTitle = true;
  key.style.showEmoji = false;
  key.style.showImage = false;
  key.style.icon = iconName(display?.icon);
  key.style.iconSize = key.style.iconSize || 40;
  key.style.fontSize = key.style.fontSize || 26;
  key.style.font = key.style.font || "";
  key.style.bgColor = BACKGROUNDS[tone];
  key.style.fgColor = FOREGROUNDS[tone];
  key.style.borderStyle = display?.stale ? "dotted" : "solid";
  key.style.borderWidth = display?.stale ? 2 : 0;
  key.style.borderColor = FOREGROUNDS[tone];
  key.title = String(titleText ?? display?.title ?? "").slice(0, 32);
  await plugin.draw(serialNumber, key, "draw");
}

/**
 * 原生布局只有标题，没有副标题，因此把最重要的两项合成一行。
 *
 * 超过宿主标题上限的文本会被截断成 "…"，遵循 docs/架构设计.md
 * 「展示与绘制」中显示时截断过长内容的约定。
 */
function toKeyTitle(display, { maxLength = 32 } = {}) {
  if (!display) return "";
  const parts = [display.title, display.subtitle].filter((part) => typeof part === "string" && part);
  const text = parts.join(" · ");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

module.exports = { BACKGROUNDS, FOREGROUNDS, iconName, drawKey, toKeyTitle };
