/**
 * 展示能力只取决于本次传入的机型和领域状态，不缓存设备能力。
 * true 表示允许展示该项目；读数缺失/过期的展示仍由 presenter 处理。
 * 未知型号保留名称，仅以有效的已映射读数退化；不解释原始协议编码。
 */
const catalog = require("./model-catalog.json");

function modelKey(value) {
  return value.trim().replace(/^bambu\s+lab\s+/i, "").replace(/\s+/g, "").toLowerCase();
}

// 显式产品名称与官方型号 ID 共用一份能力配置，避免别名绕过硬件限制。
const MODELS = new Map();
for (const profile of catalog.models) {
  for (const alias of [profile.id, profile.name, ...(profile.aliases || [])]) {
    const key = modelKey(alias);
    if (MODELS.has(key) && MODELS.get(key) !== profile) throw new Error(`机型别名冲突：${alias}`);
    MODELS.set(key, profile);
  }
}

function modelProfile(value) {
  return typeof value === "string" && value.trim() ? MODELS.get(modelKey(value)) : undefined;
}

function normalizeModel(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return modelProfile(value)?.name || value.trim();
}

function isReading(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPercent(value) {
  return isReading(value) && value >= 0 && value <= 100;
}

const AMS_TYPES = new Map([
  ["ams", { type: "ams", label: "AMS" }],
  ["ams lite", { type: "ams-lite", label: "AMS lite" }],
  ["ams 2 pro", { type: "ams-2-pro", label: "AMS 2 Pro" }],
  ["ams ht", { type: "ams-ht", label: "AMS HT" }],
  ["ams 3h", { type: "ams-3h", label: "AMS 3H" }],
  ["ams3h", { type: "ams-3h", label: "AMS 3H" }],
  ["ams lite mixed", { type: "ams-lite-mixed", label: "AMS lite（混合型）" }],
  // 官方尚未给出 ZMULTI 的商品名，保留协议名称。
  ["zmulti_a", { type: "zmulti-a", label: "AMS（ZMULTI_A）" }],
  ["zmulti_b", { type: "zmulti-b", label: "AMS（ZMULTI_B）" }],
]);

function amsType(unit, usesAmsLite) {
  // 仅允许明确的产品名称。数值、数字字符串、未知编码均不能推断类型。
  const matches = [unit.model, unit.rawType, unit.type].flatMap((value) => {
    if (typeof value !== "string") return [];
    const key = value.trim().replace(/^bambu\s+lab\s+/i, "").replace(/\s+/g, " ").toLowerCase();
    return AMS_TYPES.has(key) ? [AMS_TYPES.get(key)] : [];
  });
  // 互相冲突的明确元数据也按未知处理，不任意挑选。
  if (matches.length) {
    return matches.every((match) => match.type === matches[0].type)
      ? matches[0] : { type: "unknown", label: "AMS（类型未知）" };
  }
  if (Object.hasOwn(unit, "rawInfo")) {
    // 官方 DevFilaSystem::ParseAmsInfo 用十六进制 info 的低四位；
    // DevDefs.h: 1=AMS, 2=AMS lite, 3=AMS 2 Pro, 4=AMS HT,
    // 5=AMS_LITE_MIXED (N9), 6=ZMULTI_A, 7=ZMULTI_B。
    // https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/DeviceCore/DevFilaSystem.cpp
    // 未知/清空的 info 不回退为机型推断，避免掩盖新硬件类型。
    const info = unit.rawInfo;
    const code = typeof info === "string" && /^(?:0x)?[0-9a-f]{1,128}$/i.test(info.trim())
      ? parseInt(info.trim().slice(-1), 16) : null;
    const names = { 1: "ams", 2: "ams lite", 3: "ams 2 pro", 4: "ams ht", 5: "ams lite mixed", 6: "zmulti_a", 7: "zmulti_b" };
    return AMS_TYPES.get(names[code]) || { type: "unknown", label: "AMS（类型未知）" };
  }
  return usesAmsLite ? AMS_TYPES.get("ams lite") : { type: "unknown", label: "AMS（类型未知）" };
}

/**
 * @param {string|null} model 打印机型号，规范名称或带 Bambu Lab 前缀的名称。
 * @param {object|null} state 已映射领域状态（温度 current、fans 百分比、ams.units）。
 * @returns {{model: string|null, sensors: object, ams: object}}
 * AMS remaining 为该 unit 是否有可展示的余量；每个槽位仍须单独验证读数。
 */
function getPrinterCapabilities(model, state) {
  const normalized = normalizeModel(model);
  const profile = modelProfile(model);
  // 官方 N8 配置仅有摄像头信息；不能因登记了型号就推断有打印温度传感器。
  const known = Boolean(profile) && [profile.chamber, profile.auxiliaryFan, profile.chamberFan]
    .some(value => typeof value === "boolean");
  const usesAmsLite = profile?.amsType === "f1";
  const sensors = {
    nozzle: known || isReading(state?.nozzle?.current),
    bed: known || isReading(state?.bed?.current),
    chamber: profile?.chamber !== false && isReading(state?.chamber?.current),
    fanPart: known || isPercent(state?.fans?.part),
    fanAuxiliary: profile?.auxiliaryFan !== false && isPercent(state?.fans?.auxiliary),
    fanChamber: profile?.chamberFan !== false && isPercent(state?.fans?.chamber),
    // 不按机型虚构读数；有效上报才展示，0% 也有效。
    fanHeatbreak: isPercent(state?.fans?.heatbreak),
  };
  const ams = {};
  const units = Array.isArray(state?.ams?.units) ? state.ams.units : [];
  for (const unit of units) {
    if (!unit || typeof unit !== "object" || Array.isArray(unit)) continue;
    const id = unit.id;
    // 领域模型的 AMS unit ID 为非负十进制整数；不引入虚构的 unit。
    if (!(typeof id === "string" && /^\d+$/.test(id)) &&
        !(Number.isSafeInteger(id) && id >= 0)) continue;
    const identity = amsType(unit, usesAmsLite);
    const slots = Array.isArray(unit.slots) ? unit.slots : [];
    ams[String(id)] = {
      ...identity,
      remaining: identity.type !== "ams-lite" && slots.some((slot) =>
        slot && isPercent(slot.remaining)),
    };
    if (Array.isArray(unit.zones)) {
      const zones = {};
      for (const zone of unit.zones) {
        if (!zone || typeof zone.id !== "string" || !/^\d+$/.test(zone.id)) continue;
        zones[zone.id] = {
          temperature: isReading(zone.temperature),
          humidity: isPercent(zone.humidity),
          dryingMinutes: isReading(zone.dryingMinutes) && zone.dryingMinutes >= 0,
        };
      }
      ams[String(id)].zones = zones;
    }
  }
  return { model: normalized, sensors, ams };
}

module.exports = { getPrinterCapabilities };
