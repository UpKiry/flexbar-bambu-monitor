const FONT_FAMILY = "BambuCJK";

/** 在 Canvas 中显式注册系统中文字体；找不到时保留宿主默认字体。 */
function registerDashboardFont(globalFonts, { platform = process.platform, env = process.env } = {}) {
  if (typeof globalFonts?.registerFromPath !== "function") return false;
  const windows = env.WINDIR || "C:\\Windows";
  const candidates = platform === "darwin"
    ? ["/System/Library/Fonts/STHeiti Medium.ttc", "/System/Library/Fonts/Hiragino Sans GB.ttc", "/Library/Fonts/Arial Unicode.ttf"]
    : platform === "win32"
      ? [`${windows}\\Fonts\\msyh.ttc`, `${windows}\\Fonts\\simhei.ttf`, `${windows}\\Fonts\\simsun.ttc`]
      : [];
  for (const file of candidates) {
    try {
      if (globalFonts.registerFromPath(file, FONT_FAMILY)) return true;
    } catch {
      // 可选系统字体在不同系统版本中可能缺失。
    }
  }
  return false;
}

module.exports = { FONT_FAMILY, registerDashboardFont };
