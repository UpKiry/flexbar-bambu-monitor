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
  let started = false;
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

  function redactSecrets() {
    const token = auth.getAccessToken();
    return token ? [token] : [];
  }

  function logError(message, error) {
    safeLogger.error(`${message}：${error?.message || error}`, redactSecrets());
  }

  /** 由入口注入浏览器后台控制器；runtime 本身不感知 HTTP。 */
  function attachAdmin(controller) {
    adminController = controller || null;
  }

  // ---------------------------------------------------------------------
  // 展示与绘制
  // ---------------------------------------------------------------------

  function buildDisplayFor(view) {
    const printerId = config.printerId;
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
    if (view && view !== "progress" && hasReport && printer.status?.state === "connected") {
      const details = buildViewDetails(printer.state, view);
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
    if (config.region !== previous.region) auth.cancelPendingLogin();
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
    if (!token) {
      await auth.invalidate();
      return { status: "error", message: "登录已失效，请重新登录" };
    }
    try {
      const api = createApiFn(resolveRegion(auth.getRegion() || config.region).id);
      devices = await api.fetchDevices(token);
      devicesError = null;
      return { status: "success", devices };
    } catch (error) {
      devicesError = error?.message || "无法读取设备列表";
      logError("读取设备列表失败", error);
      // 令牌失效必须转移到"需要重新登录"，否则界面会一直停留在登录态。
      if (error?.kind === ERROR_KINDS.unauthorized) {
        activeMonitor = null;
        printer.disconnect();
        await auth.invalidate("登录已失效，请重新登录");
        renderAll({ urgent: true }).catch(() => {});
      }
      return { status: "error", message: devicesError, kind: error?.kind };
    }
  }

  /** 登录成功后的统一收尾：刷设备、单设备自动选中、启动监控。 */
  async function finishSignIn() {
    await refreshDevices();
    await queueConfig(async () => {
      if (!config.printerId && devices.length === 1) {
        const only = devices[0];
        const next = { ...config, printerId: only.id, printerName: only.name };
        try {
          await plugin.setConfig?.(next);
          applyConfig(next);
        } catch (error) {
          logError("保存插件配置失败", error);
        }
      }
    });
    startMonitoring();
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

  const actions = {
    async status() {
      return {
        status: "success",
        auth: auth.snapshot(),
        config,
        credentialStore: await credentialStore.status(),
        devices,
        devicesError,
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
      const result = await auth.requestEmailCode({ region: config.region, account: payload?.account });
      // 少数账号不需要验证码，服务端会直接返回令牌；此时与密码登录走同样的收尾。
      if (result.status === "success") await finishSignIn();
      renderAll({ urgent: true }).catch(() => {});
      return { status: result.status, message: result.message || result.error?.message || "", auth: result, devices, config };
    },
    async login(payload) {
      const result = payload?.code
        ? await auth.submitCode({ code: payload.code })
        : await auth.loginWithPassword({
          region: config.region,
          account: payload?.account,
          password: payload?.password,
        });
      if (result.status === "success") await finishSignIn();
      renderAll({ urgent: true }).catch(() => {});
      return { status: result.status, message: result.error?.message || "", auth: result, devices, config };
    },
    async cancelCode() {
      return { status: "success", auth: auth.cancelPendingLogin() };
    },
    async logout() {
      activeMonitor = null;
      printer.disconnect();
      await auth.logout({ revokeRemote: true });
      devices = [];
      devicesError = null;
      renderAll({ urgent: true }).catch(() => {});
      return { status: "success", auth: auth.snapshot() };
    },
    async refreshDevices() {
      return refreshDevices();
    },
    async setPrinter(payload) {
      return queueConfig(async () => {
        const printerId = typeof payload?.printerId === "string" ? payload.printerId : "";
        const device = devices.find((item) => item.id === printerId);
        const next = { ...config, printerId, printerName: device?.name || payload?.printerName || "" };
        try {
          await plugin.setConfig(next);
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
      return queueConfig(async () => {
        const region = resolveRegion(payload?.region).id;
        if (region === config.region) return { status: "success", config };
        const next = { ...config, region };
        try {
          await plugin.setConfig(next);
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
      try {
        const api = createApiFn(region);
        const token = auth.getAccessToken();
        if (!token) return { status: "error", message: "请先登录" };
        const list = await api.fetchDevices(token);
        return { status: "success", message: `已读取 ${list.length} 台绑定设备`, devices: list };
      } catch (error) {
        return {
          status: "error",
          message: error?.message || "连接测试失败",
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
      return { status: "error", message: error?.message || "操作失败" };
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
    const hydrated = await auth.hydrate();
    if (hydrated.state === STATES.signedIn) {
      startMonitoring();
      // 设备列表在后台补拉，不阻塞按键首帧。
      refreshDevices().catch((error) => logError("读取设备列表失败", error));
    }
    await renderAll({ urgent: true });
  }

  /** 退出时先关闭浏览器后台，再断开云连接，避免留下监听端口。 */
  async function shutdown() {
    try {
      await adminController?.stop?.();
    } catch (error) {
      logError("关闭浏览器后台失败", error);
    }
    try {
      printer.disconnect();
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
