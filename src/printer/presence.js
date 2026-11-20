const { mapReport } = require("./state-mapper");
const { TELEMETRY_TIMEOUT_MS } = require("./observation-policy");

const AUTO_RETRY_MS = 300_000;

// Use the domain mapper's validation; structural IDs and version metadata alone
// are not evidence that the printer is reporting live measurements.
function hasTelemetry(raw) {
  const patch = mapReport(raw);
  const measured = value => value !== null && value !== undefined && value !== "";
  const hasFields = (object, fields) => fields.some(key => measured(object?.[key]));
  const telemetryFields = ["progressPercent", "remainingMinutes", "nozzleCurrent", "nozzleTarget",
    "bedCurrent", "bedTarget", "chamberCurrent", "layerNum", "totalLayerNum", "printError", "printErrorCode"];
  if (hasFields(patch, telemetryFields)) return true;
  if (patch.activity && patch.activity !== "unknown") return true;
  // An explicitly empty HMS list reports no errors and is valid telemetry.
  if (Array.isArray(patch.hms)) return true;
  if (hasFields(patch.fans, ["part", "auxiliary", "chamber", "heatbreak"])) return true;
  const ams = patch.ams;
  if (!ams) return false;
  // Only interpreted AMS fields establish life. Unknown status/raw tray values,
  // slot rawState and metadata are intentionally excluded from this allowlist.
  if (measured(ams.existBits) || (ams.current &&
      measured(ams.current.unitId) && measured(ams.current.slotId))) return true;
  return (ams.units || []).some(unit =>
    (unit.slots || []).some(slot => hasFields(slot, ["color", "material", "remaining"])) ||
    (unit.zones || []).some(zone => hasFields(zone, ["temperature", "humidity", "dryingMinutes"])));
}

function createPresence({ now = () => Date.now() } = {}) {
  let data = { state: "unknown", source: "initial", evidence: null, changedAt: now(),
    lastMessageAt: null, lastTelemetryAt: null, waitingSince: null,
    autoAttempts: 0, nextAutoRequestAt: null, lastRequestAt: null };
  let ready = false;
  let explicitlyOffline = false;
  let lastAutoAt = null;
  function transition(state, source, at, evidence = source) {
    if (data.state !== state || data.source !== source) data.changedAt = at;
    data.state = state;
    data.source = source;
    data.evidence = evidence;
  }
  function schedule(at) {
    // 时钟回退防御：未来时戳（回拨越过的旧记录）按当前时间计，避免把下次请求推到遥遥无期。
    const autoBase = lastAutoAt === null ? -Infinity : Math.min(lastAutoAt, at) + AUTO_RETRY_MS;
    const requestBase = data.lastRequestAt === null ? -Infinity : Math.min(data.lastRequestAt, at) + AUTO_RETRY_MS;
    data.nextAutoRequestAt = data.autoAttempts >= 2 ? null : Math.max(at + TELEMETRY_TIMEOUT_MS, autoBase, requestBase);
  }
  return {
    get value() { return { ...data }; },
    broker(connected) {
      const at = now();
      if (connected === ready) return;
      ready = connected;
      data.waitingSince = connected ? at : null;
      if (!connected) {
        transition("unknown", "broker-disconnected", at);
        data.nextAutoRequestAt = null;
      } else {
        transition(explicitlyOffline ? "offline" : "syncing", "broker-connected", at);
        if (!explicitlyOffline) schedule(at);
      }
    },
    message(at = now()) { data.lastMessageAt = at; },
    event(event, at = now()) {
      if (event === "client.disconnected") {
        explicitlyOffline = true;
        transition("offline", "mqtt-event", at, event);
        data.nextAutoRequestAt = null;
      } else if (event === "client.connected") {
        // Duplicate events must not postpone synchronization indefinitely.
        if (data.state === "syncing" && !explicitlyOffline) return;
        // Connection events establish reachability, but wait for live telemetry.
        explicitlyOffline = false;
        transition("syncing", "mqtt-event", at, event);
        data.waitingSince = at;
        schedule(at);
      }
    },
    telemetry(at = now()) {
      explicitlyOffline = false;
      data.lastTelemetryAt = at;
      data.waitingSince = at;
      data.autoAttempts = 0;
      lastAutoAt = null;
      transition("online", "telemetry", at);
      schedule(at);
    },
    requested(at = now(), automatic = false) {
      data.lastRequestAt = at;
      if (automatic) { data.autoAttempts += 1; lastAutoAt = at; }
      if (!explicitlyOffline && ready) schedule(at);
    },
    tick() {
      const at = now();
      if (!ready || explicitlyOffline || data.waitingSince === null) return false;
      // 时钟回退防御：等待起点被回拨越过时下修到当前时间，重新计时而不是永久不超时。
      if (at < data.waitingSince) data.waitingSince = at;
      if (at - data.waitingSince >= TELEMETRY_TIMEOUT_MS) {
        transition("unresponsive", "telemetry-timeout", at);
        return data.autoAttempts < 2 && data.nextAutoRequestAt !== null && at >= data.nextAutoRequestAt;
      }
      return false;
    },
    /**
     * 唤醒/时钟跳变后的盲窗恢复：重置失活快速档预算并重新武装恢复请求时间。
     * 观测时间戳是事实，不改写；标记与超时仍按原有规则推进。
     */
    resume() {
      const at = now();
      if (data.waitingSince !== null && data.waitingSince > at) data.waitingSince = at;
      data.autoAttempts = 0;
      lastAutoAt = null;
      if (!explicitlyOffline && ready) schedule(at);
    },
  };
}

module.exports = { createPresence, hasTelemetry, TELEMETRY_TIMEOUT_MS, AUTO_RETRY_MS };
