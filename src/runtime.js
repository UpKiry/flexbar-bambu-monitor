const { createSafeLogger } = require("./util/logger");
const { CloudApi, ERROR_KINDS } = require("./cloud/cloud-api");
const { resolveRegion } = require("./cloud/region");
const { createAuthService, STATES } = require("./auth/auth-service");
const { createCredentialStore } = require("./auth/credential-store");
const { createDiagnostics } = require("./admin/diagnostics");
const { createPrinterManager } = require("./printer/printer-manager");
const { drawKey, toKeyTitle } = require("./display/key-renderer");
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
  const throttle = createDrawThrottle({ now });

  let config = { ...DEFAULT_CONFIG };
  /** 当前已启动的监控，用于避免重复建立云连接。 */
  let activeMonitor = null;
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
  /** uid → { key, serialNumber, view } */
  const keys = new Map();
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

  function monitorBlockMessage() {
    if (auth.state !== STATES.signedIn || !config.printerId) return "";
    if (!verifiedToken || verifiedToken !== auth.getAccessToken()) {
      return devicesError ? "设备列表读取失败，无法确认设备归属" : "等待验证当前账号的设备列表";
    }
    if (!devices.some((device) => device.id === config.printerId)) return "所选设备不在当前账号的设备列表中";
    return "";
  }

  function buildDisplayFor(view) {
    const printerId = config.printerId;
    const blocked = monitorBlockMessage();
    if (blocked) return { tone: "warning", title: "无法连接设备", subtitle: blocked, icon: "cloud-off", stale: true };
    const base = buildDisplay({
      signedIn: auth.state === STATES.signedIn,
      authExpired: auth.state === STATES.expired,
      hasPrinter: Boolean(printerId),
      state: printer.state,
      link: { state: printerMap(printer.status?.state), lastError: printer.status?.lastError },
      now: now(),
    });
    // 只有确实收到过设备报文时，温度 / 任务视图才有意义；
    // 登录提示等前置状态仍然显示原因，而不是一片 "无数据"。
    const hasReport = printer.state?.lastReportAt !== null && printer.state?.lastReportAt !== undefined;
    if (view && view !== "progress" && hasReport && printer.status?.state === "connected" && !base.stale && base.tone !== "critical") {
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

  function viewFor(uid) {
    const view = views.get(uid);
    return VIEWS.includes(view) ? view : "progress";
  }

  async function renderAll({ urgent = false } = {}) {
    for (const entry of keys.values()) {
      const view = viewFor(entry.key.uid);
      const display = buildDisplayFor(view);
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
  }

  // ---------------------------------------------------------------------
  // 配置
  // ---------------------------------------------------------------------

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
      printer.disconnect();
      auth.invalidate("账号区域已更改，请重新登录").catch(() => {});
      renderAll({ urgent: true }).catch(() => {});
    }
    if (printerChanged) {
      activeMonitor = null;
      printer.selectPrinter(config.printerId || null, { name: config.printerName });
      if (config.printerId) startMonitoring();
      else printer.disconnect();
    }
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
    if (activeMonitor) {
      activeMonitor = null;
      Promise.resolve(printer.disconnect()).catch(() => logError("断开云端连接失败"));
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
      devices = list;
      verifiedToken = token;
      devicesError = null;
      startMonitoring();
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
        Promise.resolve(printer.disconnect()).catch(() => logError("断开云端连接失败"));
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
      Promise.resolve(printer.disconnect()).catch(() => logError("断开云端连接失败"));
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
      keys.set(key.uid, { key, serialNumber: payload.serialNumber });
      // 每个按键独立保存视图；按键配置里选的视图优先于内存状态。
      if (VIEWS.includes(key.data?.view)) views.set(key.uid, key.data.view);
    }
    renderAll({ urgent: true }).catch((error) => logError("初始绘制失败", error));
  });

  plugin.on("plugin.data", (payload) => {
    const key = payload?.data?.key;
    if (!key || key.cid !== KEY_CID) return;
    const current = viewFor(key.uid);
    const next = nextView(current);
    views.set(key.uid, next);
    const entry = keys.get(key.uid);
    if (entry) entry.key = key;
    renderAll({ urgent: true }).catch((error) => logError("切换视图失败", error));
  });

  plugin.on("device.status", (list) => {
    const serials = new Set((list || []).map((item) => item.serialNumber));
    for (const [uid, entry] of keys) {
      if (serials.has(entry.serialNumber)) continue;
      keys.delete(uid);
      views.delete(uid);
    }
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
      if (activeMonitor) {
        activeMonitor = null;
        Promise.resolve(printer.disconnect()).catch(() => logError("断开云端连接失败"));
      }
    }
    return { result, epoch: sessionGeneration };
  }

  const actions = {
    async status() {
      return {
        status: "success",
        auth: auth.snapshot(),
        config,
        credentialStore: await credentialStore.status(),
        devices,
        devicesError,
        monitorBlockMessage: monitorBlockMessage(),
        printer: { id: config.printerId, name: printer.printerName, state: printer.state, link: printer.status },
        display: buildDisplayFor("progress"),
        views: Array.from(views.entries()).map(([uid, view]) => ({ uid, view })),
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
        disconnecting = Promise.resolve(printer.disconnect());
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
    async testConnection(payload) {
      const region = resolveRegion(payload?.region || config.region).id;
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
      // 不能在确认当前账号设备列表前使用恢复的设备选择。
      refreshDevices().catch((error) => logError("读取设备列表失败", error));
    }
    await renderAll({ urgent: true });
  }

  /** 退出时先关闭浏览器后台，再断开云连接，避免留下监听端口。 */
  async function shutdown() {
    shuttingDown = true;
    sessionGeneration += 1;
    activeMonitor = null;
    const disconnecting = printer.disconnect();
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
