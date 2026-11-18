/**
 * 账号区域配置。
 *
 * 设计要求（见 docs/云端监控设计方案.md §2、§6.2）：
 * - 区域必须由用户在设置中明确选择，不能根据系统时区或 IP 猜测；
 * - 服务地址属于社区资料，未经全部账号验证，因此集中在此处，便于按实测修改。
 *
 * 所有地址都是"默认值"，调用方应允许测试注入覆盖。
 */

const REGIONS = {
  global: {
    id: "global",
    label: "全球",
    apiBaseUrl: "https://api.bambulab.com",
    mqttHost: "us.mqtt.bambulab.com",
    mqttPort: 8883,
  },
  china: {
    id: "china",
    label: "中国大陆",
    apiBaseUrl: "https://api.bambulab.cn",
    mqttHost: "cn.mqtt.bambulab.com",
    mqttPort: 8883,
  },
};

const DEFAULT_REGION = "global";

/** 是否是我们已知的区域 ID。 */
function isKnownRegion(regionId) {
  return typeof regionId === "string" && Object.hasOwn(REGIONS, regionId);
}

/**
 * 读取区域配置。未知区域回落到默认值，但会通过 `fallback` 告知调用方，
 * 避免把"配置坏了"当成"用户选了全球"悄悄处理掉。
 */
function resolveRegion(regionId) {
  if (isKnownRegion(regionId)) {
    return { ...REGIONS[regionId], fallback: false };
  }
  return { ...REGIONS[DEFAULT_REGION], fallback: regionId !== undefined && regionId !== null && regionId !== "" };
}

function listRegions() {
  return Object.values(REGIONS).map(({ id, label }) => ({ id, label }));
}

/** 区域不匹配时，云端通常会返回 401/账号不存在，需要能给出可操作的提示。 */
function regionMismatchHint(regionId) {
  const region = resolveRegion(regionId);
  return `当前账号区域设置为「${region.label}」。若提示账号不存在或登录失败，请先确认 Bambu 账号所属区域。`;
}

module.exports = {
  REGIONS,
  DEFAULT_REGION,
  isKnownRegion,
  resolveRegion,
  listRegions,
  regionMismatchHint,
};
