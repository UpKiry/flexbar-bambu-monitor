const { FONT_FAMILY } = require("./fonts");

const WIDTH = 2170;
const HEIGHT = 60;
const COLORS = {
  background: "#101512", foreground: "#edf2ec", secondary: "#8d9b90",
  divider: "#2b362e", green: "#b4e9c5", amber: "#edc184",
  red: "#f09385", stale: "#a8aba3", alertBackground: "#301b1c",
};

function textOf(value, fallback = "—") {
  const text = value && typeof value === "object" ? value.text : value;
  return typeof text === "string" && text.trim() ? text : fallback;
}

function asReading(value) {
  return { text: textOf(value), stale: value?.stale === true };
}

// 保留旧版字符串模型的可读性；字段时效及百分比数值以新版 ui 为准。
function displayModel(model) {
  if (model?.ui) return model.ui;
  const reading = (text) => {
    const value = textOf(text);
    return { text: value.replace(/（旧）|\(旧\)/g, ""), stale: /（旧）|\(旧\)/.test(value) };
  };
  const temperature = value => {
    const [current, target] = textOf(value).split(/\s*\/\s*/);
    return { current: reading(current), target: reading(target) };
  };
  const [layer, totalLayer] = textOf(model?.layers).split(/\s*\/\s*/);
  const precondition = /登录|选择.*打印机|选择.*设备|未选择|未绑定/.test(textOf(model?.connection, ""));
  return {
    connection: model?.connection, title: precondition ? model?.connection : model?.printerName,
    precondition, tone: "muted",
    activity: reading(model?.activity), task: reading(model?.task),
    progress: { ...reading(model?.progress), value: null }, remaining: reading(model?.remaining),
    layer: reading(layer), totalLayer: reading(totalLayer),
    nozzle: temperature(model?.nozzle), bed: temperature(model?.bed),
    fans: [], slots: [], amsLabel: "AMS", updated: reading(model?.updated),
    fault: reading(model?.faults), urgent: false,
  };
}

/**
 * 纯 Canvas 2D 渲染。ui 内各读数为 { text, stale }，progress 额外提供 value。
 * 不读取协议、不推断缺失值或槽位身份；调用方负责文案、机型能力和时效。
 * 布局以 2170 × 60 为基准，仅通过 scale 适配调用方提供的宽度。
 */
function renderDashboard(canvas, model, { width = WIDTH } = {}) {
  if (!Number.isFinite(width) || width <= 0) throw new TypeError("width 必须为正数");
  const ctx = canvas?.getContext?.("2d");
  if (!ctx) throw new TypeError("需要 Canvas 2D context");
  const ui = displayModel(model);
  const accent = ({
    critical: COLORS.red, warning: COLORS.amber, muted: COLORS.stale,
    normal: COLORS.green, positive: COLORS.green,
  }[ui.tone] || COLORS.green);

  ctx.save();
  try {
    ctx.scale(width / WIDTH, 1);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.globalAlpha = 1;
    const rect = (x, y, w, h, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    };
    // 用实际字宽裁切，fillText 永远不传 maxWidth，避免 Canvas 水平压缩文字。
    function text(value, x, y, size, color, maxWidth, weight = 500) {
      ctx.font = `${weight} ${size}px "${FONT_FAMILY}", sans-serif`;
      ctx.fillStyle = color;
      let output = textOf(value);
      if (Number.isFinite(maxWidth) && ctx.measureText(output).width > maxWidth) {
        const chars = Array.from(output);
        if (ctx.measureText("…").width > maxWidth) return 0;
        let low = 0;
        let high = chars.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (ctx.measureText(`${chars.slice(0, middle).join("")}…`).width <= maxWidth) low = middle;
          else high = middle - 1;
        }
        output = `${chars.slice(0, low).join("")}…`;
      }
      ctx.fillText(output, x, y);
      return ctx.measureText(output).width;
    }
    function reading(value, x, y, size, maxWidth, color = COLORS.foreground) {
      const item = asReading(value);
      const stale = item.stale && item.text !== "—";
      const badgeWidth = stale ? 17 : 0;
      const measured = text(item.text, x, y, size, stale ? COLORS.stale : color,
        Math.max(0, maxWidth - badgeWidth));
      if (stale) text("旧", x + measured + 4, y, 10, COLORS.amber, 13, 400);
      return measured + badgeWidth;
    }
    const label = (value, x, maxWidth) => text(value, x, 14, 12, COLORS.secondary, maxWidth, 400);
    const divider = x => rect(x, 13, 1, 34, COLORS.divider);
    function dot(x, y, color) {
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    function temperature(x, title, sensor, availableWidth) {
      label(title, x, availableWidth);
      const current = asReading(sensor?.current);
      const target = asReading(sensor?.target);
      // 固定子区域为当前与目标各预留旧标记，长数值不能挤入下一区域。
      reading(current, x, 39, 26, 65);
      text("/", x + 70, 40, 16, COLORS.secondary, 9);
      const used = reading(target, x + 85, 40, 16, availableWidth - 97);
      if (target.text !== "—") text("°", x + 87 + used, 37, 15, COLORS.secondary, 10);
    }

    rect(0, 0, WIDTH, HEIGHT, COLORS.background);
    rect(0, 0, 3, HEIGHT, accent);
    // 设备自定义名始终在首段，不以型号替代。
    const printerName = ui.precondition ? textOf(model?.printerName, "打印机")
      : textOf(ui.title, textOf(model?.printerName, "打印机"));
    text(printerName, 22, 18, 21, COLORS.foreground, 145, 600);
    dot(25, 43, accent);
    reading(ui.connection, 36, 43, 12, 131, COLORS.secondary);
    divider(180);

    // 认证/设备选择为阻断态：保留身份，整条突出下一步，隐藏历史打印读数。
    const needsSetup = ui.precondition === true || (!model?.ui &&
      /登录|选择.*打印机|选择.*设备|未选择|未绑定/.test(textOf(ui.connection, "")));
    if (needsSetup) {
      reading(ui.title || ui.connection, 208, 23, 25, 610, accent);
      reading(ui.subtitle, 208, 47, 14, 1450, COLORS.secondary);
      return;
    }

    if (ui.feedback?.text) {
      const feedbackColor = ui.feedback.level === "error" ? COLORS.red
        : ui.feedback.level === "warning" ? COLORS.amber : COLORS.green;
      rect(195, 4, 285, 21, COLORS.divider);
      text(ui.feedback.text, 202, 14, 13, feedbackColor, 271);
    } else {
      label("当前任务", 202, 68);
      reading(ui.task, 282, 14, 14, 188);
    }
    reading(ui.activity, 202, 40, 18, 100, accent);
    reading(ui.layer, 312, 40, 17, 58);
    text("/", 373, 40, 14, COLORS.secondary, 9);
    reading(ui.totalLayer, 390, 40, 17, 65);
    text("层", 461, 40, 12, COLORS.secondary, 15);
    divider(490);

    const progress = asReading(ui.progress);
    // 格式化百分比来自模型；进度线仅消费明确的有效数值，不解析展示字符串。
    const numericText = progress.text.endsWith("%") ? progress.text.slice(0, -1).trim() : progress.text;
    const progressWidth = text(numericText, 512, 27, 39,
      // 宿主 Canvas 对非整百字重的字宽计算异常，会导致数字被整段裁掉。
      progress.stale ? COLORS.stale : accent, progress.stale ? 96 : 111, 600);
    if (progress.text !== "—") text("%", 516 + progressWidth, 33, 17, COLORS.secondary, 20);
    if (progress.stale && progress.text !== "—") text("旧", 540 + progressWidth, 33, 10, COLORS.amber, 13);
    rect(514, 53, 139, 2, COLORS.divider);
    if (typeof ui.progress?.value === "number" && Number.isFinite(ui.progress.value) &&
        ui.progress.value >= 0 && ui.progress.value <= 100) {
      rect(514, 53, 139 * ui.progress.value / 100, 2, progress.stale ? COLORS.stale : accent);
    }
    divider(680);
    label("预计剩余", 704, 145);
    reading(ui.remaining, 704, 39, 27, 145);
    divider(870);
    temperature(893, "喷嘴 / 目标", ui.nozzle, 168);
    temperature(1080, "热床 / 目标", ui.bed, 146);
    divider(1240);

    if (ui.urgent) {
      // 警报完整占用风扇及 AMS 区域；原始 HMS/错误码不做解释或替换。
      const historical = ui.fault?.stale === true;
      const faultColor = historical ? (ui.tone === "warning" ? COLORS.amber : COLORS.stale) : COLORS.red;
      rect(1250, 5, 718, 50, historical ? COLORS.divider : COLORS.alertBackground);
      rect(1250, 5, 3, 50, faultColor);
      text(historical ? "历史故障 · 原始信息" : "设备报告故障 · 原始信息", 1267, 16, 12, faultColor, 680, 600);
      reading(ui.fault, 1267, 39, 19, 684, faultColor);
    } else {
      const fans = Array.isArray(ui.fans) ? ui.fans.slice(0, 4) : [];
      if (!fans.length) {
        label("风扇", 1262, 165);
        reading(null, 1262, 39, 20, 165);
      } else if (fans.length <= 2) {
        fans.forEach((fan, index) => {
          const x = 1262 + index * 94;
          label(textOf(fan?.label, "风扇"), x, 84);
          reading(fan?.value, x, 39, 20, 84);
        });
      } else {
        fans.forEach((fan, index) => {
          const x = 1256 + index % 2 * 97;
          const y = index < 2 ? 20 : 43;
          text(textOf(fan?.label, "风扇"), x, y, 11, COLORS.secondary, 36);
          reading(fan?.value, x + 38, y, 13, 54);
        });
      }
      divider(1450);
      label(textOf(ui.amsLabel, "AMS"), 1472, 345);
      const allSlots = Array.isArray(ui.slots) ? ui.slots : [];
      const extraSlots = Math.max(allSlots.length - 4, Number.isFinite(ui.extraSlots) ? Math.floor(ui.extraSlots) : 0);
      if (extraSlots > 0) text(`+${extraSlots} 槽`, 1886, 14, 11, COLORS.secondary, 76);
      const slots = allSlots.slice(0, 4);
      if (!slots.length) text("暂无槽位数据", 1472, 39, 17, COLORS.secondary, 480);
      slots.forEach((slot, index) => {
        if (!slot || typeof slot !== "object") return;
        const x = 1472 + index * 122;
        const exists = asReading(slot.exists);
        const color = asReading(slot.color);
        const absent = exists.text === "空";
        const validColor = /^#[0-9a-f]{6}$/i.test(color.text);
        const swatch = absent ? COLORS.divider : validColor ? color.text : COLORS.secondary;
        ctx.globalAlpha = color.stale || exists.stale ? 0.5 : 1;
        rect(x, 28, 5, 22, swatch);
        ctx.globalAlpha = 1;
        if (color.stale && validColor && !absent) text("旧", x - 1, 55, 8, COLORS.amber, 10);
        text(`${textOf(slot.unitId, "?")}:${textOf(slot.id, "?")}`, x + 12, 28, 10, COLORS.secondary, 53);
        reading(exists.text === "—" ? { ...exists, text: "未知" } : exists, x + 68, 28, 10, 46, COLORS.secondary);
        if (absent) {
          // 空槽证据已在上行展示，不渲染遗留材质、颜色或余量。
          text("—", x + 12, 46, 15, COLORS.secondary, 102);
        } else {
          const remaining = asReading(slot.remaining);
          const hasRemaining = remaining.text !== "—";
          reading(slot.material, x + 12, 46, 14, hasRemaining ? 54 : 102);
          // Lite 及其他无余量读数的槽不制造百分比占位。
          if (hasRemaining) reading(remaining, x + 68, 46, 12, 46);
        }
      });
    }
    divider(1980);
    label("最近设备上报", 2002, 146);
    reading(ui.updated, 2002, 35, 17, 146, COLORS.secondary);
    reading(ui.fault, 2002, 53, 10, 146, ui.urgent ? COLORS.red : COLORS.secondary);
  } finally {
    ctx.restore();
  }
}

module.exports = { renderDashboard };
