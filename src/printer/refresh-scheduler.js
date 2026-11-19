const AUTO_INTERVAL_MS = 5 * 60_000;
const SYNC_DELAY_MS = 5_000;
const FIELD_DELAY_MS = 30_000;
const PERIODIC_INTERVAL_MS = 15 * 60_000;
const CORE_FIELDS = ["activity", "nozzle.current", "bed.current"];
const MEASURED_FIELDS = new Set([
  ...CORE_FIELDS, "progressPercent", "remainingMinutes", "layerNum", "totalLayerNum",
  "nozzle.target", "bed.target", "chamber.current", "printError", "printErrorCode", "hms",
  "fans.part", "fans.auxiliary", "fans.chamber", "fans.heatbreak",
]);

// Missing optional fields and identity metadata never create refresh work.
function refreshTargets(state) {
  const targets = new Set();
  const fields = state.freshness.fields;
  for (const field of CORE_FIELDS) {
    if (!fields[field]) targets.add(`fields/${field}`);
  }
  for (const [field, mark] of Object.entries(fields)) {
    if (MEASURED_FIELDS.has(field) && mark.stale) targets.add(`fields/${field}`);
  }
  function visit(node, path) {
    for (const [key, value] of Object.entries(node || {})) {
      if (!value || typeof value !== "object") continue;
      if (Object.hasOwn(value, "stale")) {
        if (value.stale && !["model", "rawInfo", "rawTrayNow"].includes(key)) targets.add(`${path}/${key}`);
      } else visit(value, `${path}/${key}`);
    }
  }
  visit(state.freshness.ams, "ams");
  return targets;
}

function createRefreshScheduler({ now = () => Date.now(), random = Math.random } = {}) {
  let ready = false;
  let syncAt = null;
  let lastRequestAt = null;
  let nextPeriodicAt = null;
  const pending = new Map();
  function observe(state) {
    const targets = refreshTargets(state);
    for (const key of pending.keys()) if (!targets.has(key)) pending.delete(key);
    for (const key of targets) {
      if (!pending.has(key)) pending.set(key, { since: now(), attempts: 0 });
    }
    return targets;
  }
  return {
    observe,
    broker(connected) {
      if (connected && !ready) {
        syncAt = now() + SYNC_DELAY_MS;
        nextPeriodicAt ??= now() + PERIODIC_INTERVAL_MS + Math.floor(random() * 60_000);
      }
      if (!connected) syncAt = null;
      ready = connected;
    },
    onlineEvent() { if (ready) syncAt ??= now() + SYNC_DELAY_MS; },
    due(state, presence, recoveryDue) {
      observe(state);
      const at = now();
      if (!ready || presence.state === "offline" || presence.state === "unknown") return null;
      // A manual request and every automatic reason share the same interval.
      if (lastRequestAt !== null && (at < lastRequestAt || at - lastRequestAt < AUTO_INTERVAL_MS)) return null;
      if (recoveryDue) return "recovery";
      if (presence.state === "unresponsive") return null;
      if (syncAt !== null && at < syncAt) return null;
      const eligible = [...pending.values()].filter(item => item.attempts < 2);
      if (syncAt !== null && at >= syncAt) {
        syncAt = null;
        if (eligible.length && (presence.state === "online" || presence.autoAttempts < 2)) return "sync";
      }
      if (presence.state !== "online") return null;
      if (eligible.some(item => at >= item.since && at - item.since >= FIELD_DELAY_MS)) return "fields";
      // An unresolved batch must not use periodic polling to evade its retry budget.
      if (!pending.size && nextPeriodicAt !== null && at >= nextPeriodicAt) return "periodic";
      return null;
    },
    requested(state, automatic = false) {
      observe(state);
      lastRequestAt = now();
      syncAt = null;
      nextPeriodicAt = now() + PERIODIC_INTERVAL_MS + Math.floor(random() * 60_000);
      if (automatic) for (const item of pending.values()) item.attempts = Math.min(2, item.attempts + 1);
    },
  };
}

module.exports = { createRefreshScheduler };
