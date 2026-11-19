const { resolveRegion } = require("../cloud/region");

/**
 * 设备连接注册表（见 docs/架构设计.md「设备生命周期」）。
 *
 * 一个设备对应一个 manager；默认设备与按键指定的其他设备走同一套建立、
 * 订阅、连接和关闭逻辑。区别只在"谁需要它"：默认设备由配置决定，
 * 其他设备由按键引用决定。鉴权失效、关闭屏障与重试因此只有一份实现。
 *
 * 关闭语义：
 * - 同一 manager 的关闭请求合并为一个 Promise，避免重复 disconnect；
 * - 关闭成功后移除屏障；关闭失败则保留记录，替换连接继续被阻塞，
 *   不允许在无法确认旧连接已关闭时建立新连接；
 * - 屏障解除后由调用方重新收敛，注册表不自行猜测会话状态。
 */

function createMonitorRegistry({ createManager, logger, onFrame, onEvent = () => {} } = {}) {
  /** 默认设备管理器：对象身份稳定，切换默认设备时复用并重置内部状态。 */
  const defaultManager = createManager({ logger, onFrame });
  let defaultIdentity = { printerId: null, name: null };
  /** 默认设备之外、被按键引用的设备：id → { manager, token }。 */
  const additional = new Map();
  /** manager → 关闭 Promise；成功后移除，失败则保留以阻塞替换。 */
  const closing = new Map();
  const detachers = new Map();
  /** manager → 最近一次 connect 使用的令牌，供上层判断事件是否属于当前会话。 */
  const tokens = new WeakMap();
  /** manager → 已发起的连接 { token, printerId }；避免同一会话重复建连。 */
  const active = new WeakMap();
  let disposed = false;

  function closeManager(manager) {
    if (closing.has(manager)) return closing.get(manager);
    let result;
    try { result = manager.disconnect(); } catch { result = Promise.reject(new Error("无法确认旧连接已关闭")); }
    const pending = Promise.resolve(result);
    closing.set(manager, pending);
    pending.then(() => {
      if (closing.get(manager) === pending) closing.delete(manager);
    }, () => {
      // 保留失败的记录：未确认关闭前不能替换连接。
      logger?.error?.("断开云端连接失败");
    });
    return pending;
  }

  function waitForCloses() {
    return Promise.all([...closing.values()]);
  }

  function subscribeManager(manager, printerId) {
    if (detachers.has(manager)) return;
    const detach = manager.subscribe((change) => {
      if (disposed) return;
      onEvent({ printerId, change, token: tokens.get(manager) || null });
    });
    detachers.set(manager, typeof detach === "function" ? detach : () => {});
  }

  function detachManager(manager) {
    const detach = detachers.get(manager);
    if (!detach) return;
    detachers.delete(manager);
    try { detach(); } catch { /* 解绑失败不影响关闭流程 */ }
  }

  function ensureAdditional(printerId, name) {
    let entry = additional.get(printerId);
    if (entry) {
      if (name) entry.manager.selectPrinter(printerId, { name });
      return entry;
    }
    const manager = createManager({ logger, onFrame });
    entry = { manager, token: null };
    additional.set(printerId, entry);
    subscribeManager(manager, printerId);
    manager.selectPrinter(printerId, { name });
    return entry;
  }

  function dropAdditional(printerId) {
    const entry = additional.get(printerId);
    if (!entry) return null;
    additional.delete(printerId);
    entry.token = null;
    active.delete(entry.manager);
    detachManager(entry.manager);
    return entry.manager;
  }

  function alreadyConnected(manager, printerId, token) {
    if (closing.has(manager)) return false;
    if (manager.printerId !== printerId) return false;
    const started = active.get(manager);
    return Boolean(started && started.token === token && started.printerId === printerId);
  }

  function startConnection(manager, printerId, token, connectArgs) {
    const result = manager.connect(connectArgs);
    if (result?.started) {
      tokens.set(manager, token);
      active.set(manager, { token, printerId });
    }
    return result;
  }

  /**
   * 依据当前会话与需求集合收敛连接。
   *
   * @param {object} context
   * @param {string|null} token 当前访问令牌
   * @param {string|null} userId
   * @param {string} [region]
   * @param {boolean} verified 设备列表是否属于当前令牌
   * @param {string[]} devices 已验证设备 id
   * @param {string|null} defaultId 默认设备
   * @param {string|null} defaultName
   * @param {Iterable<string>} wantedIds 按键引用且需要连接的设备
   * @param {boolean} [blocked] 暂停新连接（重配置/退出）
   * @returns {{deferred: boolean, started: string[], stopped: string[]}}
   */
  function reconcile(context = {}) {
    const {
      token = null, userId = null, region = "global",
      verified = false, devices = [], defaultId = null, defaultName = null,
      wantedIds = [], blocked = false,
    } = context;
    const summary = { deferred: false, started: [], stopped: [] };
    if (disposed) return summary;
    if (blocked) { summary.deferred = true; return summary; }

    const verifiedIds = new Set(devices);
    const authorized = Boolean(token && userId && verified);
    const wanted = new Set([...wantedIds].filter((id) => id && id !== defaultId));

    // 1. 不再需要的设备：断开并从注册表移除。
    for (const id of [...additional.keys()]) {
      if (authorized && verifiedIds.has(id) && wanted.has(id)) continue;
      const manager = dropAdditional(id);
      if (manager) {
        summary.stopped.push(id);
        closeManager(manager).catch(() => {});
      }
    }

    // 2. 默认设备选择；切换发生在连接前，保留 manager 的状态重置语义。
    if (defaultIdentity.printerId !== defaultId || defaultIdentity.name !== defaultName) {
      defaultIdentity = { printerId: defaultId || null, name: defaultName || null };
      defaultManager.selectPrinter(defaultId || null, { name: defaultName || undefined });
    }
    subscribeManager(defaultManager, defaultId || null);

    if (!authorized) return summary;

    const resolved = resolveRegion(region);
    const connectArgs = { host: resolved.mqttHost, port: resolved.mqttPort, userId, accessToken: token };

    // 3. 默认设备。
    if (defaultId && verifiedIds.has(defaultId)) {
      if (closing.has(defaultManager)) {
        summary.deferred = true;
      } else if (alreadyConnected(defaultManager, defaultId, token)) {
        summary.started.push(defaultId);
      } else if (startConnection(defaultManager, defaultId, token, connectArgs).started) {
        summary.started.push(defaultId);
      }
    }

    // 4. 按键引用的其他设备。
    for (const id of wanted) {
      if (!verifiedIds.has(id)) continue;
      const entry = ensureAdditional(id, null);
      if (closing.has(entry.manager)) { summary.deferred = true; continue; }
      if (alreadyConnected(entry.manager, id, token)) { entry.token = token; continue; }
      entry.token = token;
      if (startConnection(entry.manager, id, token, connectArgs).started) {
        summary.started.push(id);
      } else entry.token = null;
    }

    if (summary.deferred) {
      // 屏障解除后重新收敛；失败时屏障保留，不会擅自重连。
      waitForCloses().then(() => reconcile(context), () => {});
    }
    return summary;
  }

  /** 关闭并移除所有连接。会话结束时设备身份不再可信，因此默认选择一并清空。 */
  function closeAll() {
    const pending = [];
    for (const id of [...additional.keys()]) {
      const manager = dropAdditional(id);
      if (manager) pending.push(closeManager(manager));
    }
    active.delete(defaultManager);
    detachManager(defaultManager);
    defaultIdentity = { printerId: null, name: null };
    defaultManager.selectPrinter(null, {});
    pending.push(closeManager(defaultManager));
    return Promise.all(pending);
  }

  function get(printerId) {
    if (printerId && printerId === defaultIdentity.printerId) return defaultManager;
    return additional.get(printerId)?.manager || null;
  }

  function tick() {
    defaultManager.tick?.();
    for (const { manager } of additional.values()) manager.tick?.();
  }

  function dispose() {
    disposed = true;
    for (const id of [...additional.keys()]) {
      const manager = dropAdditional(id);
      try { manager?.disconnect(); } catch { /* 退出时尽力清理 */ }
    }
    detachManager(defaultManager);
    try { defaultManager.disconnect(); } catch { /* ignore */ }
  }

  return {
    defaultManager,
    reconcile,
    closeAll,
    get,
    tick,
    waitForCloses,
    dispose,
    get defaultIdentity() { return { ...defaultIdentity }; },
    get closingCount() { return closing.size; },
  };
}

module.exports = { createMonitorRegistry };
