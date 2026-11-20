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

/**
 * 自动完整状态调度（见 docs/设备协议与状态模型.md「presence、超时与有限恢复」）。
 *
 * 活性底线：任何预算耗尽都不能永久停止自动刷新。快速档（sync / fields / recovery）
 * 决定"多快"重试，周期兜底（periodic）保证"总会"再试；明确 offline 才停止查询。
 * 唤醒/时钟跳变的盲窗由 `resume()` 重置预算与节流，由 manager 决定触发。
 */
function createRefreshScheduler({ now = () => Date.now(), random = Math.random } = {}) {
  let ready = false;
  let syncAt = null;
  let forcedSync = false;
  let lastRequestAt = null;
  let nextPeriodicAt = null;
  let lastNow = null;
  const pending = new Map();

  // 时钟回退防御：被越过的时戳下修到当前时间，冷却从回拨时刻重新起算。
  // 大幅回退由 manager 的 tick 跳变检测走完整 resume，这里只防小步回拨死锁。
  function advanceClock(at) {
    if (lastNow !== null && at < lastNow) {
      if (lastRequestAt !== null && lastRequestAt > at) lastRequestAt = at;
      for (const item of pending.values()) if (item.since > at) item.since = at;
    }
    lastNow = at;
  }

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
    /**
     * 唤醒/时钟跳变后的盲窗恢复：立即重置节流与快速档预算，
     * 五秒宽限后强制一次全量同步（不看字段状态，盲窗里错过了什么不可知）。
     */
    resume() {
      const at = now();
      lastNow = at;
      lastRequestAt = null;
      syncAt = at + SYNC_DELAY_MS;
      forcedSync = true;
      nextPeriodicAt = at + PERIODIC_INTERVAL_MS + Math.floor(random() * 60_000);
      for (const item of pending.values()) item.attempts = 0;
    },
    due(state, presence, recoveryDue) {
      const at = now();
      advanceClock(at);
      observe(state);
      if (!ready || presence.state === "offline" || presence.state === "unknown") return null;
      // A manual request and every automatic reason share the same interval.
      if (lastRequestAt !== null && at - lastRequestAt < AUTO_INTERVAL_MS) return null;
      if (recoveryDue) return "recovery";
      if (syncAt !== null) {
        if (at < syncAt) return null;
        const forced = forcedSync;
        syncAt = null;
        forcedSync = false;
        // 盲窗（resume）后强制同步；（重）订阅后的同步由缺失/标旧目标决定。
        if (forced || refreshTargets(state).size > 0) return "sync";
      }
      if (presence.state === "online") {
        const eligible = [...pending.values()].filter(item => item.attempts < 2);
        if (eligible.some(item => at >= item.since && at - item.since >= FIELD_DELAY_MS)) return "fields";
      }
      // 活性底线：预算耗尽、失活未恢复也保留周期兜底，不能永久停止自动刷新。
      if (nextPeriodicAt !== null && at >= nextPeriodicAt) return "periodic";
      return null;
    },
    requested(state, automatic = false) {
      const at = now();
      advanceClock(at);
      observe(state);
      lastRequestAt = at;
      syncAt = null;
      forcedSync = false;
      nextPeriodicAt = at + PERIODIC_INTERVAL_MS + Math.floor(random() * 60_000);
      if (automatic) for (const item of pending.values()) item.attempts = Math.min(2, item.attempts + 1);
    },
  };
}

module.exports = { createRefreshScheduler };
