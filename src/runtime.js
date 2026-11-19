const { createSafeLogger } = require("./util/logger");
const { CloudApi, ERROR_KINDS } = require("./cloud/cloud-api");
const { resolveRegion } = require("./cloud/region");
const { createAuthService, STATES } = require("./auth/auth-service");
const { createCredentialStore } = require("./auth/credential-store");
const { createDiagnostics } = require("./admin/diagnostics");
const { createPrinterManager } = require("./printer/printer-manager");
const { drawKey, toKeyTitle } = require("./display/key-renderer");
const { drawDashboard } = require("./display/dashboard");
const {
  buildDisplay,
  buildViewDetails,
  createDrawThrottle,
  fingerprintDisplay,
  fieldIsFresh,
  nextView,
  VIEWS,
} = require("./display/presenter");

const KEY_CID = "com.upkiry.bambumonitor.monitor";
/** 补画节流丢掉的更新的检查间隔：与绘制上限一致，最多每秒一次。 */
const DRAW_TICK_MS = 1_000;

/** 插件配置只保存非敏感字段；令牌走系统安全存储。 */
const DEFAULT_CONFIG = {
  region: "global",
  printerId: "",
  printerName: "",
};

function normalizeConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const region = resolveRegion(typeof value.region === "string" ? value.region : undefined).id;
  return {
    region,
    printerId: typeof value.printerId === "string" ? value.printerId : "",
    printerName: typeof value.printerName === "string" ? value.printerName : "",
  };
}

/**
 * 插件运行时。入口只负责接线，协议细节留在各模块。
 */
function createPluginRuntime({
  plugin,
  logger,
  createApi,
  credentialStore = createCredentialStore(),
  createMqttManager = createPrinterManager,
  drawKeyFn = drawKey,
  drawDashboardFn = drawDashboard,
  createCanvas,
  now = () => Date.now(),
  configRetryDelayMs = 400,
  diagnostics = createDiagnostics({ now }),
} = {}) {
  const safeLogger = createSafeLogger(logger, {
    onRecord: (entry) => diagnostics.recordLog?.(entry),
  });
  const createApiFn = createApi || ((region) => new CloudApi({
    region,
    onRequest: (event) => diagnostics.recordRequest?.(event),
  }));
  const auth = createAuthService({
    createApi: createApiFn,
    credentialStore,
    logger: safeLogger,
    now,
  });
  const printer = createMqttManager({ logger: safeLogger, now });
  const throttles = new Map();
  const additionalPrinters = new Map();
  const closingManagers = new Map();

  let config = { ...DEFAULT_CONFIG };
  /** 当前已启动的监控，用于避免重复建立云连接。 */
  let activeMonitor = null;
  let reconfiguring = false;
  let reconfiguration = 0;
  let devices = [];
  let devicesError = null;
  // 只有当前会话成功读取的设备列表才能授权监控。
  let verifiedToken = null;
  let started = false;
  let shuttingDown = false;
  let sessionGeneration = 0;
  let deviceRequestGeneration = 0;
  /** 浏览器后台控制器由入口在创建后注入，runtime 不依赖 HTTP 细节。 */
  let adminController = null;
  // 串行化配置读取和写入，避免并发请求互相覆盖。
  let configQueue = Promise.resolve();
  function queueConfig(operation) {
    const result = configQueue.then(operation);
    configQueue = result.catch(() => {});
    return result;
  }
  /** (serialNumber, uid) → 按键；uid 只在所属 Flexbar 内唯一。 */
  const keys = new Map();
  const dashboards = new Map();
  /** 每个按键的视图，按键点击时轮换。 */
  const views = new Map();

  function logError(message) {
    // 异常可能包含设备文本、云响应或凭据，日志只记录固定上下文。
    safeLogger.error(message);
  }

  /** 由入口注入浏览器后台控制器；runtime 本身不感知 HTTP。 */
  function attachAdmin(controller) {
    adminController = controller || null;
  }

  // ---------------------------------------------------------------------
  // 展示与绘制
  // ---------------------------------------------------------------------

  function clearDeviceVerification() {
    verifiedToken = null;
    devices = [];
    devicesError = null;
  }

  function monitorBlockMessage(printerId = config.printerId) {
    if (auth.state !== STATES.signedIn || !printerId) return "";
    if (!verifiedToken || verifiedToken !== auth.getAccessToken()) {
      return devicesError ? "设备列表读取失败，无法确认设备归属" : "等待验证当前账号的设备列表";
    }
    if (!devices.some((device) => device.id === printerId)) return "所选设备不在当前账号的设备列表中";
    return "";
  }

  function buildDisplayFor(view, printerId = config.printerId) {
    const printer = printerFor(printerId);
    const blocked = monitorBlockMessage(printerId);
    if (blocked) return { tone: "warning", title: "无法连接设备", subtitle: blocked, icon: "cloud-off", stale: true };
    const base = buildDisplay({
      signedIn: auth.state === STATES.signedIn,
      authExpired: auth.state === STATES.expired,
      hasPrinter: Boolean(printerId),
      state: printer?.state,
      link: { state: printerMap(printer?.status?.state), lastError: printer?.status?.lastError },
      now: now(),
    });
    // 只有确实收到过设备报文时，温度 / 任务视图才有意义；
    // 登录提示等前置状态仍然显示原因，而不是一片 "无数据"。
    const hasReport = printer?.state?.lastReportAt !== null && printer?.state?.lastReportAt !== undefined;
    if (view && view !== "progress" && hasReport && printer?.status?.state === "connected" && !base.stale && base.tone !== "critical") {
      const source = printer.state;
      const at = now();
      const fields = view === "temperature"
        ? [["nozzle.current", source.nozzle?.current], ["nozzle.target", source.nozzle?.target], ["bed.current", source.bed?.current], ["bed.target", source.bed?.target]]
        : [["taskName", source.taskName], ["layerNum", source.layerNum], ["totalLayerNum", source.totalLayerNum]];
      if (fields.some(([field, value]) => value != null && !fieldIsFresh(source, field, at))) {
        return { ...base, tone: "warning", title: "数据已过期", subtitle: "部分字段等待更新", stale: true };
      }
      const details = buildViewDetails(source, view);
      return { ...base, title: details.title, subtitle: details.subtitle };
    }
    return base;
  }

  function printerMap(mqttState) {
    if (mqttState === "connected") return "connected";
    if (mqttState === "connecting") return "connecting";
    if (mqttState === "reconnecting") return "reconnecting";
    if (mqttState === "failed") return "failed";
    return "idle";
  }

  function keyIdentity(serialNumber, uid) {
    return JSON.stringify([serialNumber, uid]);
  }

  function viewFor(identity) {
    const view = views.get(identity);
    return VIEWS.includes(view) ? view : "progress";
  }

  async function renderAll({ urgent = false } = {}) {
    for (const entry of keys.values()) {
      // Direct Draw 入口由宿主管理，普通 draw 会覆盖其触摸区域。
      if (entry.key.cfg?.keyType === "directDraw") continue;
      if (createCanvas && dashboards.has(entry.serialNumber)) continue;
      const identity = keyIdentity(entry.serialNumber, entry.key.uid);
      const view = viewFor(identity);
      const display = buildDisplayFor(view, keyPrinterId(entry.key));
      let throttle = throttles.get(identity);
      if (!throttle) { throttle = createDrawThrottle({ now }); throttles.set(identity, throttle); }
      const fingerprint = fingerprintDisplay(display, view);
      if (!throttle.shouldDraw(fingerprint, { urgent })) continue;
      try {
        await drawKeyFn(plugin, entry.serialNumber, entry.key, display, {
          titleText: toKeyTitle(display, { view }),
        });
      } catch (error) {
        logError("绘制按键失败", error);
      }
    }
    for (const [serialNumber, session] of dashboards) {
      if (shuttingDown || session.busy || !createCanvas) continue;
      const printerId = keyPrinterId(session.key);
      const selected = printerFor(printerId);
      const blocked = monitorBlockMessage(printerId);
      session.busy = true;
      Promise.resolve().then(() => {
        if (shuttingDown || dashboards.get(serialNumber) !== session) return;
        return drawDashboardFn({
          plugin, serialNumber, key: session.key, createCanvas, now: now(),
          state: blocked || auth.state !== STATES.signedIn ? null : selected?.state,
          link: blocked ? { state: "failed", lastError: { message: blocked } } : selected?.status,
          signedIn: auth.state === STATES.signedIn, authExpired: auth.state === STATES.expired,
          hasPrinter: Boolean(printerId),
          printerName: devices.find((device) => device.id === printerId)?.name || (printerId === config.printerId ? config.printerName : ""),
        });
      }).catch((error) => {
        const message = typeof error?.message === "string" ? error.message : "";
        const hostReason = message.startsWith("Request failed:") ? message.split(", Command:")[0].slice(15) : "";
        const tags = [[/direct.?draw/i, "directDraw"], [/key/i, "key"], [/page/i, "page"], [/type/i, "type"], [/device/i, "device"], [/image|png|base64/i, "image"], [/invalid/i, "invalid"], [/not found/i, "not-found"], [/not active|inactive/i, "inactive"], [/unsupported|unknown/i, "unsupported"], [/width|size/i, "size"]].filter(([pattern]) => pattern.test(hostReason)).map(([, tag]) => tag);
        const reason = message.startsWith("Request timed out") ? "宿主请求超时"
          : message.startsWith("Request failed:") ? `宿主拒绝请求${tags.length ? `（${tags.join("、")}）` : ""}`
            : error instanceof TypeError ? "画布或参数类型错误" : "画布或宿主调用异常";
        logError(`绘制详情页失败：${reason}`);
      }).finally(() => { session.busy = false; });
    }
  }

  // ---------------------------------------------------------------------
  // 配置
  // ---------------------------------------------------------------------

  function keyPrinterId(key) {
    return typeof key?.data?.printerId === "string" && key.data.printerId ? key.data.printerId : config.printerId;
  }

  function printerFor(id) {
    return id === config.printerId ? printer : additionalPrinters.get(id)?.manager;
  }

  // A manager must not reconnect until its previous disconnect has settled.
  // Retain a rejected close so an unconfirmed transport cannot be replaced.
  function closeManager(manager) {
    if (closingManagers.has(manager)) return closingManagers.get(manager);
    let result;
    try { result = manager.disconnect(); } catch { result = Promise.reject(new Error("无法确认旧连接已关闭")); }
    const pending = Promise.resolve(result);
    closingManagers.set(manager, pending);
    pending.then(() => {
      if (closingManagers.get(manager) === pending) closingManagers.delete(manager);
    }, () => {});
    return pending;
  }

  function waitForCloses() {
    return Promise.all([...closingManagers.values()]);
  }

  function stopAdditional() {
    const pending = [];
    for (const entry of additionalPrinters.values()) {
      entry.token = null;
      pending.push(closeManager(entry.manager));
    }
    return Promise.all(pending);
  }

  function syncAdditional() {
    if (reconfiguring || shuttingDown) return;
    const token = auth.getAccessToken();
    const wanted = new Set([...keys.values()].map(({ key }) => keyPrinterId(key)).filter((id) => id && id !== config.printerId));
    for (const [id, entry] of additionalPrinters) {
      if ((!wanted.has(id) || verifiedToken !== token || !devices.some((d) => d.id === id)) && entry.token) {
        entry.token = null;
        closeManager(entry.manager).catch(() => logError("断开云端连接失败"));
      }
    }
    if (!token || verifiedToken !== token || !auth.getUserId()) return;
    const region = resolveRegion(auth.getRegion() || config.region);
    for (const id of wanted) {
      const device = devices.find((item) => item.id === id);
      if (!device) continue;
      let entry = additionalPrinters.get(id);
      if (!entry) {
        const manager = createMqttManager({ logger: safeLogger, now });
        entry = { manager, token: null };
        additionalPrinters.set(id, entry);
        manager.subscribe((change) => {
          if (change.type === "connection" && change.status?.state === "failed" && change.status?.lastError?.kind === "unauthorized" && entry.token === auth.getAccessToken()) {
            sessionGeneration += 1;
            activeMonitor = null;
            clearDeviceVerification();
            Promise.resolve(closeManager(printer)).catch(() => {});
            stopAdditional().catch(() => {});
            auth.invalidate("登录已失效，请重新登录").catch(() => logError("清理本地凭据失败")).finally(() => renderAll({ urgent: true }).catch(() => {}));
          }
          if (["state", "connection", "report"].includes(change.type)) renderAll({ urgent: change.type !== "report" || Boolean(change.taskSwitched) }).catch(() => {});
        });
        manager.selectPrinter(id, { name: device.name });
      }
      if (entry.token === token) continue;
      const closing = closingManagers.get(entry.manager);
      if (closing) {
        closing.then(() => syncAdditional(), () => {}).catch(() => {});
        continue;
      }
      entry.token = token;
      if (!entry.manager.connect({ host: region.mqttHost, port: region.mqttPort, userId: auth.getUserId(), accessToken: token }).started) entry.token = null;
    }
  }

  function applyConfig(next) {
    const previous = config;
    config = normalizeConfig(next);
    const printerChanged = config.printerId !== previous.printerId;
    if (config.region !== previous.region) {
      sessionGeneration += 1;
      clearDeviceVerification();
      auth.cancelPendingLogin();
    }
    if (config.region !== previous.region && auth.state === STATES.signedIn) {
      // 区域变更后旧令牌属于另一个服务端，必须停止监控并要求重新登录。
      activeMonitor = null;
      closeManager(printer).catch(() => logError("断开云端连接失败"));
      stopAdditional().catch(() => {});
      auth.invalidate("账号区域已更改，请重新登录").catch(() => {});
      renderAll({ urgent: true }).catch(() => {});
    }
    if (printerChanged) {
      activeMonitor = null;
      const needsHandoff = reconfiguring || [...additionalPrinters.values()].some((entry) => entry.token) ||
        [...keys.values()].some(({ key }) => keyPrinterId(key) === previous.printerId && previous.printerId);
      const revision = ++reconfiguration;
      if (needsHandoff) {
        reconfiguring = true;
        const closed = Promise.all([closeManager(printer), stopAdditional()]);
        printer.selectPrinter(config.printerId || null, { name: config.printerName });
        closed.then(() => {
          if (revision !== reconfiguration || shuttingDown) return;
          reconfiguring = false;
          startMonitoring();
          syncAdditional();
          renderAll({ urgent: true }).catch(() => {});
        }, () => {
          logError("断开云端连接失败");
        });
      } else {
        reconfiguring = false;
        printer.selectPrinter(config.printerId || null, { name: config.printerName });
        if (config.printerId) startMonitoring();
        else closeManager(printer);
      }
    }
    syncAdditional();
  }

  /**
   * 读取宿主配置。
   *
   * 插件进程启动时宿主 WebSocket 可能还没连上（readyState 0），此时 getConfig 会直接抛错。
   * 设计文档要求"重启 FlexDesigner 后在令牌有效时恢复会话"，所以这里带重试。
   */
  async function loadConfig({ attempts = 5, delayMs = configRetryDelayMs } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const stored = await plugin.getConfig?.();
        if (shuttingDown) return false;
        applyConfig(stored);
        return true;
      } catch (error) {
        if (attempt === attempts) {
          logError("读取插件配置失败", error);
          return false;
        }
        // 不 unref：启动阶段必须等这次重试结束，否则会话恢复会被跳过。
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
    return false;
  }

  async function refreshDevices() {
    if (auth.state !== STATES.signedIn) return { status: "error", message: "请先登录" };
    const token = auth.getAccessToken();
    const epoch = sessionGeneration;
    const requestGeneration = ++deviceRequestGeneration;
    clearDeviceVerification();
    stopAdditional().catch(() => logError("断开云端连接失败"));
    if (activeMonitor) {
      activeMonitor = null;
      Promise.resolve(closeManager(printer)).catch(() => logError("断开云端连接失败"));
    }
    renderAll({ urgent: true }).catch(() => {});
    const current = () => !shuttingDown && epoch === sessionGeneration && requestGeneration === deviceRequestGeneration && auth.state === STATES.signedIn && auth.getAccessToken() === token;
    if (!token) {
      await auth.invalidate();
      return { status: "error", message: "登录已失效，请重新登录" };
    }
    try {
      const api = createApiFn(resolveRegion(auth.getRegion() || config.region).id);
      const list = await api.fetchDevices(token);
      if (!current()) return { status: "cancelled" };
      try {
        await waitForCloses();
      } catch {
        if (!current()) return { status: "cancelled" };
        devicesError = "无法确认旧云连接已关闭";
        renderAll({ urgent: true }).catch(() => {});
        return { status: "error", message: devicesError };
      }
      if (!current()) return { status: "cancelled" };
      devices = list;
      verifiedToken = token;
      devicesError = null;
      startMonitoring();
      syncAdditional();
      renderAll({ urgent: true }).catch(() => {});
      return { status: "success", devices };
    } catch (error) {
      if (!current()) return { status: "cancelled" };
      devicesError = "无法读取设备列表，请检查登录状态和网络";
      renderAll({ urgent: true }).catch(() => {});
      safeLogger.error("读取设备列表失败");
      // 令牌失效必须转移到"需要重新登录"，否则界面会一直停留在登录态。
      if (error?.kind === ERROR_KINDS.unauthorized) {
        sessionGeneration += 1;
        activeMonitor = null;
        clearDeviceVerification();
        devicesError = "登录已失效，请重新登录";
        Promise.resolve(closeManager(printer)).catch(() => logError("断开云端连接失败"));
        await auth.invalidate("登录已失效，请重新登录");
        renderAll({ urgent: true }).catch(() => {});
      }
      return { status: "error", message: devicesError, kind: error?.kind };
    }
  }

  /** 登录成功后的统一收尾：刷设备、单设备自动选中、启动监控。 */
  async function finishSignIn(epoch) {
    const token = auth.getAccessToken();
    const current = () => !shuttingDown && epoch === sessionGeneration && auth.state === STATES.signedIn && auth.getAccessToken() === token;
    if (!token || !current()) return;
    await refreshDevices();
    if (!current()) return;
    await queueConfig(async () => {
      if (!current()) return;
      if (!config.printerId && devices.length === 1) {
        const only = devices[0];
        const next = { ...config, printerId: only.id, printerName: only.name };
        try {
          await plugin.setConfig?.(next);
          if (!current()) {
            // 写入在退出前已开始；恢复排队时的现有配置，避免保存旧账号设备。
            await plugin.setConfig?.(config);
            return;
          }
          applyConfig(next);
        } catch (error) {
          logError("保存插件配置失败", error);
        }
      }
    });
    if (current()) startMonitoring();
  }

  // ---------------------------------------------------------------------
  // 监控生命周期
  // ---------------------------------------------------------------------

  /**
   * 幂等：登录流程和配置变更都可能调用它，重复调用不能建出两条连接。
   */
  function startMonitoring() {
    if (reconfiguring || shuttingDown) return { started: false, reason: "reconfiguring" };
    const closing = closingManagers.get(printer);
    if (closing) {
      closing.then(() => startMonitoring(), () => {}).catch(() => {});
      return { started: false, reason: "closing" };
    }
    const token = auth.getAccessToken();
    const userId = auth.getUserId();
    if (!token) return { started: false, reason: "no-token" };
    if (!userId) return { started: false, reason: "no-user-id" };
    if (!config.printerId) return { started: false, reason: "no-printer" };
    if (verifiedToken !== token || !devices.some((device) => device.id === config.printerId)) {
      return { started: false, reason: "device-unverified" };
    }
    if (activeMonitor && activeMonitor.printerId === config.printerId && activeMonitor.token === token) {
      return { started: false, reason: "already-running" };
    }
    const region = resolveRegion(auth.getRegion() || config.region);
    const result = printer.connect({
      host: region.mqttHost,
      port: region.mqttPort,
      userId,
      accessToken: token,
    });
    activeMonitor = result.started ? { printerId: config.printerId, token } : null;
    return result;
  }

  /** 上一次绘制的业务状态，用于判断"这次是不是状态切换"。 */
  let lastActivity = null;

  printer.subscribe((change) => {
    if (change.type === "connection" && change.status?.state === "failed" &&
        change.status?.lastError?.kind === "unauthorized" && activeMonitor &&
        activeMonitor.printerId === config.printerId && activeMonitor.token === auth.getAccessToken()) {
      sessionGeneration += 1;
      activeMonitor = null;
      clearDeviceVerification();
      stopAdditional().catch(() => {});
      Promise.resolve(closeManager(printer)).catch(() => logError("断开云端连接失败"));
      auth.invalidate("登录已失效，请重新登录")
        .catch(() => logError("清理本地凭据失败"))
        .finally(() => renderAll({ urgent: true }).catch(() => {}));
    }
    if (change.type === "state" || change.type === "connection") {
      const urgent = change.type === "connection" || change.state?.activity !== lastActivity;
      lastActivity = change.state?.activity ?? lastActivity;
      renderAll({ urgent }).catch((error) => logError("刷新按键失败", error));
      return;
    }
    if (change.type === "report") {
      // 设计文档 §6.4：状态切换、断线和故障可以立即更新，普通进度按节流刷新。
      const activityChanged = change.state?.activity !== lastActivity;
      lastActivity = change.state?.activity ?? lastActivity;
      const urgent = activityChanged || Boolean(change.taskSwitched);
      renderAll({ urgent }).catch((error) => logError("刷新按键失败", error));
    }
  });

  // 被节流掉的进度更新需要有人补画，否则打印中会停在旧百分比。
  let drawTimer = null;

  function ensureDrawTimer() {
    if (drawTimer) return;
    drawTimer = setInterval(() => {
      renderAll({ urgent: false }).catch((error) => logError("定时刷新按键失败", error));
    }, DRAW_TICK_MS);
    if (typeof drawTimer.unref === "function") drawTimer.unref();
  }

  // ---------------------------------------------------------------------
  // 宿主事件
  // ---------------------------------------------------------------------

  plugin.on("plugin.alive", (payload) => {
    for (const key of payload.keys || []) {
      if (key.cid !== KEY_CID) continue;
      const identity = keyIdentity(payload.serialNumber, key.uid);
      keys.set(identity, { key, serialNumber: payload.serialNumber });
      if (key.cfg?.keyType === "directDraw") dashboards.set(payload.serialNumber, { key, busy: false });
      // 每个按键独立保存视图；按键配置里选的视图优先于内存状态。
      if (VIEWS.includes(key.data?.view)) views.set(identity, key.data.view);
    }
    syncAdditional();
    renderAll({ urgent: true }).catch((error) => logError("初始绘制失败", error));
  });

  plugin.on("plugin.data", (payload) => {
    const key = payload?.data?.key;
    if (!key || key.cid !== KEY_CID) return;
    if (key.cfg?.keyType === "directDraw") dashboards.set(payload.serialNumber, { key, busy: false });
    const identity = keyIdentity(payload.serialNumber, key.uid);
    const current = viewFor(identity);
    const next = nextView(current);
    views.set(identity, next);
    const entry = keys.get(identity);
    if (entry) entry.key = key;
    syncAdditional();
    renderAll({ urgent: true }).catch((error) => logError("切换视图失败", error));
  });

  plugin.on("plugin.dead", (payload) => {
    const session = dashboards.get(payload?.serialNumber);
    if (session && (payload.keys || []).some((key) => key.uid === session.key.uid)) dashboards.delete(payload.serialNumber);
    // 页面退出未必删除父页面的入口按键，保留按键及其监控。

  });

  plugin.on("device.status", (list) => {
    const serials = new Set((list || []).filter((item) => item.status !== "disconnected").map((item) => item.serialNumber));
    for (const serial of dashboards.keys()) if (!serials.has(serial)) dashboards.delete(serial);
    for (const [uid, entry] of keys) {
      if (serials.has(entry.serialNumber)) continue;
      keys.delete(uid);
      views.delete(uid);
      throttles.delete(uid);
    }
    syncAdditional();
  });

  plugin.on("plugin.config.updated", () => {
    queueConfig(() => loadConfig()).catch((error) => logError("应用插件配置失败", error));
  });

  // ---------------------------------------------------------------------
  // UI 消息
  // ---------------------------------------------------------------------

  /** 认证方法在首次 await 前同步进入 signingIn；busy 或校验失败不会启动新代次。 */
  function beginAuthentication(start) {
    const previousState = auth.state;
    const result = start();
    if (previousState !== STATES.signingIn && auth.state === STATES.signingIn) {
      sessionGeneration += 1;
      clearDeviceVerification();
      stopAdditional().catch(() => logError("断开云端连接失败"));
      if (activeMonitor) {
        activeMonitor = null;
        Promise.resolve(closeManager(printer)).catch(() => logError("断开云端连接失败"));
      }
    }
    return { result, epoch: sessionGeneration };
  }

  const actions = {
    async status() {
      return {
        status: "success",
        auth: auth.snapshot(),
        // 恢复的令牌所属区域是已登录会话的权威来源；配置可能因旧版本/重启而不同。
        config: auth.state === STATES.signedIn && auth.getRegion()
          ? { ...config, region: auth.getRegion() }
          : config,
        credentialStore: await credentialStore.status(),
        devices,
        devicesError,
        monitorBlockMessage: monitorBlockMessage(),
        printer: { id: config.printerId, name: printer.printerName, state: printer.state, link: printer.status },
        display: buildDisplayFor("progress"),
        views: Array.from(views.entries()).map(([identity, view]) => {
          const [serialNumber, uid] = JSON.parse(identity);
          return { uid, view, serialNumber };
        }),
        admin: adminController ? adminController.info() : { available: false },
      };
    },
    async openAdmin() {
      if (!adminController) return { status: "error", message: "浏览器后台未初始化" };
      return adminController.open();
    },
    async requestCode(payload) {
      const { result: pending, epoch } = beginAuthentication(() =>
        auth.requestEmailCode({ region: config.region, account: payload?.account }));
      const result = await pending;
      // 少数账号不需要验证码，服务端会直接返回令牌；此时与密码登录走同样的收尾。
      if (result.status === "success") await finishSignIn(epoch);
      renderAll({ urgent: true }).catch(() => {});
      return { status: result.status, message: result.message || result.error?.message || "", auth: result, devices, config };
    },
    async login(payload) {
      const { result: pending, epoch } = beginAuthentication(() => payload?.code
        ? auth.submitCode({ code: payload.code })
        : auth.loginWithPassword({
          region: config.region,
          account: payload?.account,
          password: payload?.password,
        }));
      const result = await pending;
      if (result.status === "success") await finishSignIn(epoch);
      renderAll({ urgent: true }).catch(() => {});
      return { status: result.status, message: result.error?.message || "", auth: result, devices, config };
    },
    async cancelCode() {
      if ([STATES.signingIn, STATES.awaitingCode, STATES.awaitingTwoFactor].includes(auth.state)) sessionGeneration += 1;
      return { status: "success", auth: auth.cancelPendingLogin() };
    },
    async logout() {
      const epoch = ++sessionGeneration;
      activeMonitor = null;
      let disconnecting;
      try {
        disconnecting = Promise.all([Promise.resolve(closeManager(printer)), stopAdditional()]);
      } catch {
        disconnecting = Promise.reject(new Error("无法确认云端连接已关闭"));
      }
      // 退出立即清除旧界面数据，异步撤销完成后不得覆盖新会话。
      clearDeviceVerification();
      const [cleanup, disconnected] = await Promise.allSettled([
        auth.logout({ revokeRemote: true }),
        disconnecting,
      ]);
      if (disconnected.status === "rejected") logError("断开云端连接失败");
      if (cleanup.status === "rejected" || disconnected.status === "rejected") {
        const message = cleanup.status === "rejected"
          ? "已退出登录，但旧凭据可能仍在系统钥匙串中，请手动删除"
          : "已退出登录，但无法确认云端连接已关闭";
        if (epoch === sessionGeneration) renderAll({ urgent: true }).catch(() => {});
        return { status: "error", message };
      }
      if (epoch !== sessionGeneration || shuttingDown) return { status: "cancelled" };
      renderAll({ urgent: true }).catch(() => {});
      return { status: "success", auth: auth.snapshot() };
    },
    async refreshDevices() {
      return refreshDevices();
    },
    async setPrinter(payload) {
      const epoch = sessionGeneration;
      const token = auth.getAccessToken();
      const current = () => !shuttingDown && epoch === sessionGeneration && auth.getAccessToken() === token;
      return queueConfig(async () => {
        if (!current()) return { status: "cancelled" };
        const printerId = typeof payload?.printerId === "string" ? payload.printerId : "";
        const device = devices.find((item) => item.id === printerId);
        if (printerId && auth.state === STATES.signedIn && (verifiedToken !== token || !device)) {
          return { status: "error", message: "所选设备不在当前账号的设备列表中" };
        }
        const next = { ...config, printerId, printerName: device?.name || payload?.printerName || "" };
        try {
          await plugin.setConfig(next);
          if (!current()) {
            await plugin.setConfig(config);
            return { status: "cancelled" };
          }
        } catch (error) {
          logError("保存插件配置失败", error);
          return { status: "error", message: "保存插件配置失败" };
        }
        applyConfig(next);
        renderAll({ urgent: true }).catch(() => {});
        return { status: "success", config };
      });
    },
    async setRegion(payload) {
      const epoch = sessionGeneration;
      return queueConfig(async () => {
        if (shuttingDown || epoch !== sessionGeneration) return { status: "cancelled" };
        const region = resolveRegion(payload?.region).id;
        if (region === config.region) return { status: "success", config };
        const next = { ...config, region };
        try {
          await plugin.setConfig(next);
          if (shuttingDown || epoch !== sessionGeneration) {
            await plugin.setConfig(config);
            return { status: "cancelled" };
          }
        } catch (error) {
          logError("保存插件配置失败", error);
          return { status: "error", message: "保存插件配置失败" };
        }
        applyConfig(next);
        return { status: "success", config, auth: auth.snapshot() };
      });
    },
    async requestFullState() {
      return printer.requestFullState();
    },
    async testConnection() {
      const region = resolveRegion(auth.getRegion() || config.region).id;
      const epoch = sessionGeneration;
      const token = auth.getAccessToken();
      const current = () => !shuttingDown && epoch === sessionGeneration && token === auth.getAccessToken() && auth.state === STATES.signedIn;
      try {
        const api = createApiFn(region);
        if (!token) return { status: "error", message: "请先登录" };
        const list = await api.fetchDevices(token);
        if (!current()) return { status: "cancelled" };
        return { status: "success", message: `已读取 ${list.length} 台绑定设备`, devices: list };
      } catch (error) {
        if (!current()) return { status: "cancelled" };
        return {
          status: "error",
          message: "连接测试失败，请检查登录状态和网络",
          kind: error?.kind,
        };
      }
    },
  };

  plugin.on("ui.message", async (payload) => {
    const action = payload?.action;
    if (!Object.hasOwn(actions, action)) {
      return { status: "error", message: "未知的操作" };
    }
    try {
      return await actions[action](payload);
    } catch (error) {
      logError(`处理界面消息 ${action} 失败`, error);
      return { status: "error", message: "操作失败" };
    }
  });

  // ---------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------

  async function start() {
    if (started) return;
    started = true;
    ensureDrawTimer();
    await loadConfig();
    if (shuttingDown) return;
    const epoch = sessionGeneration;
    const hydrated = await auth.hydrate();
    if (shuttingDown || epoch !== sessionGeneration) return;
    if (hydrated.state === STATES.signedIn) {
      // 恢复会话的令牌区域优先，并回写配置，避免重启后再次按错误区域登录/验证。
      const sessionRegion = resolveRegion(auth.getRegion() || config.region).id;
      if (sessionRegion !== config.region) {
        await queueConfig(async () => {
          if (shuttingDown || epoch !== sessionGeneration || auth.state !== STATES.signedIn || auth.getRegion() !== sessionRegion) return;
          const next = { ...config, region: sessionRegion };
          config = next;
          try {
            await plugin.setConfig?.(next);
          } catch {
            safeLogger.warn("保存账号区域配置失败");
          }
        });
      }
      if (shuttingDown || epoch !== sessionGeneration) return;
      // 不能在确认当前账号设备列表前使用恢复的设备选择。
      refreshDevices().catch((error) => logError("读取设备列表失败", error));
    }
    await renderAll({ urgent: true });
  }

  /** 退出时先关闭浏览器后台，再断开云连接，避免留下监听端口。 */
  async function shutdown() {
    shuttingDown = true;
    dashboards.clear();
    sessionGeneration += 1;
    activeMonitor = null;
    if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
    const disconnecting = Promise.all([closeManager(printer), stopAdditional()]);
    try {
      await adminController?.stop?.();
    } catch (error) {
      logError("关闭浏览器后台失败", error);
    }
    try {
      await disconnecting;
    } catch (error) {
      logError("断开云端连接失败", error);
    }
  }

  return {
    start,
    shutdown,
    attachAdmin,
    diagnostics,
    actions,
    renderAll,
    get auth() {
      return auth;
    },
    get printer() {
      return printer;
    },
    get config() {
      return config;
    },
    get devices() {
      return devices;
    },
  };
}

module.exports = { createPluginRuntime, normalizeConfig, DEFAULT_CONFIG, KEY_CID };
