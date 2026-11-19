/**
 * 观测时效的唯一共享规则（见 docs/设备协议与状态模型.md「freshness」）。
 *
 * 三个消费入口必须得到一致结论：
 * - printer/presence.js：维护 presence 与恢复预算；
 * - display/presenter.js 及 Dashboard：决定是否标旧、是否显示"无响应"；
 * - admin 浏览器页面：在轮询间隙按当前时间判断快照时效。
 *
 * 本模块不访问 Node、DOM、时钟或网络：时间一律由调用方传入。
 * 这里的判断只说明"读数是否可作为当前值展示"，不代表设备离线或在线证据。
 */

/** 有效遥测后多久不再视为活跃：沉默只判无响应，不判离线。 */
const TELEMETRY_TIMEOUT_MS = 120_000;

/** 无 presence 的兼容调用使用的读时效；持续有效遥测时不按此标旧。 */
const FIELD_STALE_MS = 5 * 60_000;

/** AMS 旧空槽证据的保护期；与展示兼容回退不是同一规则。 */
const AMS_ABSENCE_MAX_AGE_MS = 5 * 60_000;

const ONLINE_PRESENCE_STATES = new Set(["online"]);

/**
 * presence 快照是否仍代表活跃遥测。
 * 未来时间、缺失时间和状态非 online 都不算活跃。
 *
 * @param {object|null} presence
 * @param {number} now
 * @returns {boolean}
 */
function presenceIsActive(presence, now) {
  if (!presence || !ONLINE_PRESENCE_STATES.has(presence.state)) return false;
  if (!validTelemetryTime(presence.lastTelemetryAt, now)) return false;
  return now - presence.lastTelemetryAt < TELEMETRY_TIMEOUT_MS;
}

/** 遥测时间必须有限、非负且不晚于当前时间；clock 回退不能把未来观测视为新鲜。 */
function validTelemetryTime(at, now) {
  return Number.isFinite(at) && at >= 0 && Number.isFinite(now) && now >= at;
}

/**
 * 根据 presence 与当前时间推导展示状态。
 * presence 是展示快照，不写回设备观测；state 为 online 但遥测已沉默时降级为 unresponsive。
 *
 * @param {object|null} presence
 * @param {number} now
 * @returns {string} 未知时返回 "unknown"
 */
function effectivePresenceState(presence, now) {
  if (!presence) return "unknown";
  if (!presence.state) return "unknown";
  if (presence.state !== "online") return presence.state;
  // 时间缺失或非法说明没有可用的在线证据，不能据此推断设备无响应。
  if (!validTelemetryTime(presence.lastTelemetryAt, now)) return "unknown";
  return presenceIsActive(presence, now) ? "online" : "unresponsive";
}

/**
 * 单条观测标记是否可视为当前值。
 *
 * @param {{at: number, stale: boolean}|undefined} mark
 * @param {object|null} presence 提供时以有效遥测为准；不提供时回退到年龄判断
 * @param {number} now
 * @returns {boolean}
 */
function markIsFresh(mark, presence, now) {
  if (!mark || mark.stale !== false) return false;
  // 负时间戳不是有效观测；未来时间同样不能作为当前值。
  if (!Number.isFinite(mark.at) || mark.at < 0) return false;
  if (!Number.isFinite(now) || now < mark.at) return false;
  if (presence) return presenceIsActive(presence, now);
  return now - mark.at < FIELD_STALE_MS;
}

/**
 * 字段是否有可展示的当前值。
 *
 * 带 presence 的快照必须有对应字段标记，不能用其他字段的上报时间补足；
 * 无 presence 的兼容路径沿用五分钟年龄判断。
 *
 * @param {object} state 领域状态
 * @param {string} field 领域字段名
 * @param {number} now
 * @param {object|null} [presence]
 */
function fieldIsFresh(state, field, now, presence = state?.presence) {
  const marks = state?.freshness?.fields;
  if (!marks) {
    if (presence) return false;
    if (state?.reportStale === true) return false;
    const at = state?.lastReportAt;
    return Number.isFinite(at) && Number.isFinite(now) && now >= at && now - at < FIELD_STALE_MS;
  }
  return markIsFresh(marks[field], presence || null, now);
}

/** AMS 空槽旧证据是否仍有效：只用于保护旧掩码，不用于把所有读数标旧。 */
function amsAbsenceIsFresh(mark, now) {
  return Boolean(mark) && mark.stale === false && Number.isFinite(mark.at) &&
    Number.isFinite(now) && now >= mark.at && now - mark.at < AMS_ABSENCE_MAX_AGE_MS;
}

module.exports = {
  TELEMETRY_TIMEOUT_MS,
  FIELD_STALE_MS,
  AMS_ABSENCE_MAX_AGE_MS,
  validTelemetryTime,
  presenceIsActive,
  effectivePresenceState,
  markIsFresh,
  fieldIsFresh,
  amsAbsenceIsFresh,
};
