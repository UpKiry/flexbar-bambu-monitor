const { VIEWS, createDrawThrottle, fingerprintDisplay, nextView } = require("./presenter");
const { toKeyTitle } = require("./key-renderer");

/**
 * Flexbar 绘制会话管理（见 docs/架构设计.md「展示与绘制」）。
 *
 * 这里只维护"宿主上有哪些按键、各自画什么、Direct Draw 会话是否在忙"，
 * 以及触摸后短暂显示在同一帧的反馈。它不读取配置、不访问账号令牌、
 * 不创建设备连接：展示输入由调用方通过注入函数提供。
 *
 * 关键约束：
 * - 普通 draw 不能覆盖 Direct Draw 的触摸区域；
 * - 同一 Flexbar 的相同 uid 属于不同按键，必须独立节流；
 * - 触摸反馈窗口独立于可被 alive / data 替换的绘制会话；
 * - `dispose()` 后旧的异步绘制结果不得再落地。
 */

const DEFAULT_TOUCH_FEEDBACK_MS = 1800;

function keyIdentity(serialNumber, uid) {
  return JSON.stringify([serialNumber, uid]);
}

/**
 * @param {object} options
 * @param {object} options.plugin FlexDesigner SDK 实例
 * @param {() => number} [options.now]
 * @param {Function} [options.createCanvas] 宿主 Canvas 工厂；缺失时禁用 Direct Draw
 * @param {Function} options.drawKeyFn 普通按键绘制
 * @param {Function} options.drawDashboardFn Direct Draw 绘制
 * @param {(key: object) => string} options.resolvePrinterId 按键实际使用的设备
 * @param {(view: string, printerId: string) => object} options.buildKeyDisplay 普通按键展示模型
 * @param {(printerId: string) => object} options.buildDashboardInput Direct Draw 绘制输入
 * @param {(printerId: string) => {blocked?: string}} options.inspectPrinter 触摸前置校验
 * @param {(printerId: string) => object} options.requestFullState 请求设备完整状态
 * @param {() => void} [options.onKeyDevicesChanged] 按键引用的设备集合变化
 * @param {(message: string) => void} [options.logError]
 * @param {(message: string) => void} [options.logWarn]
 * @param {(message: string) => void} [options.logInfo]
 * @param {number} [options.touchFeedbackMs]
 */
function createDisplayController({
  plugin,
  now = () => Date.now(),
  createCanvas,
  drawKeyFn,
  drawDashboardFn,
  resolvePrinterId,
  buildKeyDisplay,
  buildDashboardInput,
  inspectPrinter,
  requestFullState,
  onKeyDevicesChanged = () => {},
  logError = () => {},
  logWarn = () => {},
  logInfo = () => {},
  touchFeedbackMs = DEFAULT_TOUCH_FEEDBACK_MS,
} = {}) {
  /** (serialNumber, uid) → 按键；uid 只在所属 Flexbar 内唯一。 */
  const keys = new Map();
  /** Flexbar 序列号 → Direct Draw 会话。 */
  const dashboards = new Map();
  const throttles = new Map();
  /** 通知显示期间合并同一屏幕的重复触摸。 */
  const touchFeedback = new Map();
  const views = new Map();
  let disposed = false;

  function viewFor(identity) {
    const view = views.get(identity);
    return VIEWS.includes(view) ? view : "progress";
  }

  function touchFeedbackFor(serialNumber, session, printerId) {
    const feedback = touchFeedback.get(serialNumber);
    const stamp = now();
    return feedback?.uid === session.key.uid && feedback.printerId === printerId &&
      stamp >= feedback.at && stamp - feedback.at < touchFeedbackMs && feedback.message
      ? { text: feedback.message, level: feedback.level } : null;
  }

  function describeDrawError(error) {
    const message = typeof error?.message === "string" ? error.message : "";
    const hostReason = message.startsWith("Request failed:") ? message.split(", Command:")[0].slice(15) : "";
    const tags = [[/direct.?draw/i, "directDraw"], [/key/i, "key"], [/page/i, "page"], [/type/i, "type"], [/device/i, "device"], [/image|png|base64/i, "image"], [/invalid/i, "invalid"], [/not found/i, "not-found"], [/not active|inactive/i, "inactive"], [/unsupported|unknown/i, "unsupported"], [/width|size/i, "size"]]
      .filter(([pattern]) => pattern.test(hostReason)).map(([, tag]) => tag);
    return message.startsWith("Request timed out") ? "宿主请求超时"
      : message.startsWith("Request failed:") ? `宿主拒绝请求${tags.length ? `（${tags.join("、")}）` : ""}`
        : error instanceof TypeError ? "画布或参数类型错误" : "画布或宿主调用异常";
  }

  async function drawNormalKeys({ urgent = false } = {}) {
    for (const entry of keys.values()) {
      // Direct Draw 入口由宿主管理，普通 draw 会覆盖其触摸区域。
      if (entry.key.cfg?.keyType === "directDraw") continue;
      if (createCanvas && dashboards.has(entry.serialNumber)) continue;
      const identity = keyIdentity(entry.serialNumber, entry.key.uid);
      const view = viewFor(identity);
      const display = buildKeyDisplay(view, resolvePrinterId(entry.key));
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
  }

  async function drawDashboards() {
    for (const [serialNumber, session] of dashboards) {
      if (disposed || session.busy || !createCanvas) continue;
      const printerId = resolvePrinterId(session.key);
      const blocked = inspectPrinter(printerId).blocked || "";
      session.busy = true;
      Promise.resolve().then(() => {
        if (disposed || dashboards.get(serialNumber) !== session) return;
        const input = buildDashboardInput(printerId);
        return drawDashboardFn({
          plugin, serialNumber, key: session.key, createCanvas, now: now(),
          state: blocked ? null : input.state,
          link: blocked ? { state: "failed", lastError: { message: blocked } } : input.link,
          signedIn: input.signedIn, authExpired: input.authExpired,
          hasPrinter: Boolean(printerId),
          printerName: input.printerName,
          model: input.model,
          feedback: touchFeedbackFor(serialNumber, session, printerId),
        });
      }).catch((error) => {
        // 异常可能夹带宿主回显文本，只记录归类后的固定上下文。
        logError(`绘制详情页失败：${describeDrawError(error)}`);
      }).finally(() => { session.busy = false; });
    }
  }

  async function renderAll({ urgent = false } = {}) {
    await drawNormalKeys({ urgent });
    await drawDashboards();
  }

  function handleAlive(payload) {
    for (const key of payload.keys || []) {
      const identity = keyIdentity(payload.serialNumber, key.uid);
      keys.set(identity, { key, serialNumber: payload.serialNumber });
      if (key.cfg?.keyType === "directDraw") dashboards.set(payload.serialNumber, { key, busy: false });
      // 每个按键独立保存视图；按键配置里选的视图优先于内存状态。
      if (VIEWS.includes(key.data?.view)) views.set(identity, key.data.view);
    }
    onKeyDevicesChanged();
    renderAll({ urgent: true }).catch((error) => logError("初始绘制失败", error));
  }

  function handleTouch(payload) {
    if (payload?.state !== "down") return;
    const session = dashboards.get(payload.serialNumber);
    if (!session) return;
    const printerId = resolvePrinterId(session.key);
    const blocked = inspectPrinter(printerId).blocked || "";
    if (blocked) {
      logWarn(`触摸屏幕未请求完整状态：${blocked}`);
      return;
    }
    const stamp = now();
    const previous = touchFeedback.get(payload.serialNumber);
    if (previous?.uid === session.key.uid && previous.printerId === printerId &&
        stamp >= previous.at && stamp - previous.at < touchFeedbackMs) return;
    // 先占位再调用请求，避免同步回调或重复事件重入。
    const feedback = { uid: session.key.uid, printerId, at: stamp };
    touchFeedback.set(payload.serialNumber, feedback);
    const result = requestFullState(printerId);
    const level = result?.sent ? "success" : result?.reason === "cooldown" || result?.reason === "not-connected" ? "warning" : "error";
    const message = result?.sent ? "已请求完整状态，等待设备上报"
      : result?.reason === "cooldown" ? `请稍候 ${Math.max(1, Math.ceil((result.retryInMs || 0) / 1000))} 秒再请求`
        : result?.reason === "not-connected" ? "云端未连接，无法请求状态" : "状态请求未发送";
    if (!result?.sent) logInfo(`触摸屏幕请求完整状态未提交：${message}`);
    // 与遥测在同一 Canvas 帧内显示，避免原生 snackbar 与 Direct Draw 争用屏幕。
    Object.assign(feedback, { message, level });
    renderAll({ urgent: true }).catch(() => logWarn("显示屏幕触摸反馈失败"));
  }

  function handleData(payload) {
    const key = payload?.data?.key;
    if (!key) return;
    // Direct Draw 触摸只由 device.touch 报告；不把它当作普通按键点击。
    if (key.cfg?.keyType === "directDraw") {
      dashboards.set(payload.serialNumber, { key, busy: false });
      return;
    }
    const identity = keyIdentity(payload.serialNumber, key.uid);
    views.set(identity, nextView(viewFor(identity)));
    const entry = keys.get(identity);
    if (entry) entry.key = key;
    onKeyDevicesChanged();
    renderAll({ urgent: true }).catch((error) => logError("切换视图失败", error));
  }

  function handleDead(payload) {
    const session = dashboards.get(payload?.serialNumber);
    if (session && (payload.keys || []).some((key) => key.uid === session.key.uid)) {
      dashboards.delete(payload.serialNumber);
      touchFeedback.delete(payload.serialNumber);
    }
    // 页面退出未必删除父页面的入口按键，保留按键及其监控。
  }

  function handleDeviceStatus(list) {
    const serials = new Set((list || []).filter((item) => item.status !== "disconnected").map((item) => item.serialNumber));
    for (const serial of dashboards.keys()) {
      if (serials.has(serial)) continue;
      dashboards.delete(serial);
      touchFeedback.delete(serial);
    }
    for (const [identity, entry] of keys) {
      if (serials.has(entry.serialNumber)) continue;
      keys.delete(identity);
      views.delete(identity);
      throttles.delete(identity);
    }
    onKeyDevicesChanged();
  }

  /** 当前按键实际引用的设备集合，供连接编排判断需求。 */
  function selectedPrinterIds() {
    const ids = new Set();
    for (const { key } of keys.values()) {
      const id = resolvePrinterId(key);
      if (id) ids.add(id);
    }
    return ids;
  }

  function hasKeyForPrinter(printerId) {
    if (!printerId) return false;
    for (const { key } of keys.values()) if (resolvePrinterId(key) === printerId) return true;
    return false;
  }

  /** 浏览器后台展示按键视图列表；按身份还原 serialNumber 与 uid。 */
  function listViews() {
    return Array.from(views.entries()).map(([identity, view]) => {
      const [serialNumber, uid] = JSON.parse(identity);
      return { uid, view, serialNumber };
    });
  }

  function dispose() {
    disposed = true;
    dashboards.clear();
    touchFeedback.clear();
    throttles.clear();
  }

  return {
    handleAlive,
    handleData,
    handleTouch,
    handleDead,
    handleDeviceStatus,
    renderAll,
    selectedPrinterIds,
    hasKeyForPrinter,
    listViews,
    dispose,
    get disposed() { return disposed; },
  };
}

module.exports = { createDisplayController, keyIdentity, DEFAULT_TOUCH_FEEDBACK_MS };
