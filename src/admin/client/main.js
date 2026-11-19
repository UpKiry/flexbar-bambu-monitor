/**
 * 本机浏览器后台入口。
 *
 * 这个页面是无构建工具链之外的静态客户端：只通过同源 fetch 访问 /api/*，
 * 不直接连接 Bambu 云，也不把云令牌写进 localStorage。
 *
 * 模块分工：
 * - api.js 负责鉴权请求与令牌读写；
 * - polling.js 负责轮询、请求合并与代次丢弃；
 * - view-model.js 负责展示值与共享时效规则；
 * - render.js 只更新 DOM；
 * - actions.js 负责表单流程；
 * - diagnostics.js 负责白名单导出。
 */

const apiModule = require("./api");
const format = require("./format");
const model = require("./view-model");
const { createPoller } = require("./polling");
const { createRenderer } = require("./render");
const { createActions } = require("./actions");
const { diagnosticExport, copyDiagnosticsText } = require("./diagnostics");

function buildApp({ document: documentRef, location: locationRef, history: historyRef, fetchFn, storage: storageRef } = {}) {
  const doc = documentRef || document;
  const locationResolver = locationRef || location;
  const historyResolver = historyRef || history;
  const fetcher = fetchFn || ((path, init) => fetch(path, init));
  const storage = storageRef === undefined
    ? (() => { try { return sessionStorage; } catch { return null; } })()
    : storageRef;

  const state = {
    token: "",
    status: null,
    diagnostics: null,
    awaitingCode: false,
    busy: false,
    generation: 0,
    statusFailures: 0,
    lastStatusAt: null,
    serviceUnavailable: false,
    activeTab: "overview",
    debugPaused: false,
    debugFrames: [],
    debugSignature: "",
  };

  const getState = () => state;
  const getGeneration = () => state.generation;

  let renderer;
  let poller;
  let actions;

  const api = apiModule.createApi({
    fetchFn: fetcher,
    getToken: () => state.token,
    onUnauthorized: (message) => {
      stopSession();
      renderer.showTokenScreen(message);
    },
  });

  function regionOf() {
    return state.status?.config?.region || "global";
  }

  function stopSession() {
    poller?.stop();
    state.generation += 1;
    state.token = "";
    apiModule.clearStoredToken(storage);
  }

  renderer = createRenderer({ document: doc, getState, model, format });

  poller = createPoller({
    api,
    getState,
    getGeneration,
    onStatus: (data) => {
      state.statusFailures = 0;
      state.lastStatusAt = Date.now();
      if (state.serviceUnavailable) {
        state.serviceUnavailable = false;
        renderer.showServiceWarning("");
        renderer.showMessage("本地服务连接已恢复，状态已更新。", "success");
      }
      state.status = data;
      renderer.renderStatus(data, { onFirstPayload: () => renderSnapshot() });
    },
    onDiagnostics: (data) => {
      state.diagnostics = data;
      renderer.renderDiagnostics(data);
      renderSnapshot();
    },
    onFailure: (type, error) => {
      if (type !== "status") return;
      state.statusFailures += 1;
      if (state.statusFailures < 2) return;
      state.serviceUnavailable = true;
      const lastUpdate = state.lastStatusAt === null ? "尚未成功读取状态。" : `最后成功更新：${format.formatDateTime(state.lastStatusAt)}。`;
      renderer.showServiceWarning(`无法连接本地服务，页面显示的可能是旧状态；${lastUpdate}请检查插件是否运行。恢复连接后会自动更新。`);
      void error;
    },
    onError: (type, error) => {
      if (type === "status") {
        if (!state.serviceUnavailable) renderer.showMessage(error.message, "error");
        return;
      }
      renderer.showMessage(error.message, "error");
    },
    onRecovered: (type) => {
      if (type === "status") renderer.showMessage("状态已刷新", "success");
      else renderer.showMessage("诊断信息已刷新", "success");
    },
  });

  actions = createActions({
    document: doc,
    getState,
    api,
    renderer,
    loadStatus: poller.loadStatus,
    loadDiagnostics: poller.loadDiagnostics,
    regionOf,
  });

  function renderSnapshot() {
    const snapshot = diagnosticExport({ status: state.status, diagnostics: state.diagnostics }).status;
    renderer.renderSnapshot(state.status, JSON.stringify(snapshot, null, 2));
  }

  async function copyDiagnostics() {
    const text = JSON.stringify(diagnosticExport({ status: state.status, diagnostics: state.diagnostics }), null, 2);
    await copyDiagnosticsText({ text, documentRef: doc, showMessage: renderer.showMessage });
  }

  function bindEvents() {
    for (const [index, name] of renderer.TAB_NAMES.entries()) {
      const tab = doc.getElementById(`tab-${name}`);
      tab.addEventListener("click", () => renderer.selectTab(name));
      tab.addEventListener("keydown", (event) => {
        let next;
        if (event.key === "ArrowRight") next = (index + 1) % renderer.TAB_NAMES.length;
        if (event.key === "ArrowLeft") next = (index + renderer.TAB_NAMES.length - 1) % renderer.TAB_NAMES.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = renderer.TAB_NAMES.length - 1;
        if (next === undefined) return;
        event.preventDefault();
        renderer.selectTab(renderer.TAB_NAMES[next]);
        doc.getElementById(`tab-${renderer.TAB_NAMES[next]}`).focus();
      });
    }
    doc.getElementById("debug-protocol").addEventListener("change", renderer.renderDebugFrames);
    doc.getElementById("debug-search").addEventListener("input", renderer.renderDebugFrames);
    doc.getElementById("debug-pause").addEventListener("click", () => {
      state.debugPaused = !state.debugPaused;
      const button = doc.getElementById("debug-pause");
      button.setAttribute("aria-pressed", String(state.debugPaused));
      button.textContent = state.debugPaused ? "继续显示" : "暂停显示";
      if (!state.debugPaused) state.debugFrames = state.diagnostics?.frames || [];
      renderer.renderDebugFrames();
    });
    doc.getElementById("manual-token-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = doc.getElementById("manual-token");
      const token = apiModule.extractToken(input ? input.value : "");
      if (!token) {
        const node = doc.getElementById("token-message");
        if (node) node.textContent = "没有识别到有效令牌，请重新粘贴。";
        return;
      }
      state.generation += 1;
      state.statusFailures = 0;
      state.lastStatusAt = null;
      state.serviceUnavailable = false;
      renderer.showServiceWarning("");
      state.token = token;
      apiModule.persistToken(storage, token);
      apiModule.stripTokenFromAddress(locationResolver, historyResolver);
      if (input) input.value = "";
      renderer.showApp();
      poller.loadStatus();
      poller.loadDiagnostics();
      poller.start(doc);
    });

    doc.getElementById("login-form").addEventListener("submit", actions.submitLogin);
    doc.getElementById("send-code-btn").addEventListener("click", actions.sendCode);
    doc.getElementById("switch-password-btn").addEventListener("click", async () => {
      const result = await actions.runAction("cancelCode");
      if (result?.status === "success") doc.getElementById("password-input")?.focus();
    });
    doc.getElementById("logout-btn").addEventListener("click", actions.logout);
    doc.getElementById("region-select").addEventListener("change", actions.setRegion);
    doc.getElementById("printer-select").addEventListener("change", actions.setPrinter);

    doc.getElementById("refresh-btn").addEventListener("click", () => {
      poller.loadStatus();
      poller.loadDiagnostics({ silent: true });
    });
    doc.getElementById("refresh-devices-btn").addEventListener("click", () => actions.runAction("refreshDevices"));
    doc.getElementById("test-connection-btn").addEventListener("click", () => actions.runAction("testConnection"));
    doc.getElementById("full-state-btn").addEventListener("click", () => actions.runAction("requestFullState"));
    doc.getElementById("refresh-diag-btn").addEventListener("click", () => poller.loadDiagnostics());
    doc.getElementById("copy-diag-btn").addEventListener("click", () => { copyDiagnostics().catch(() => {}); });

    doc.addEventListener("visibilitychange", () => {
      if (!doc.hidden && state.token) {
        poller.loadStatus({ silent: true });
        poller.loadDiagnostics({ silent: true });
      }
    });
  }

  function init() {
    bindEvents();
    const token = apiModule.readHashToken(locationResolver) || apiModule.storedToken(storage);
    if (!token) {
      renderer.showTokenScreen();
      return;
    }
    state.token = token;
    apiModule.persistToken(storage, token);
    apiModule.stripTokenFromAddress(locationResolver, historyResolver);
    renderer.showApp();
    poller.loadStatus();
    poller.loadDiagnostics();
    poller.start(doc);
  }

  init();

  return {
    state,
    api,
    poller,
    renderer,
    actions,
    loadStatus: poller.loadStatus,
    loadDiagnostics: poller.loadDiagnostics,
    renderStatus: renderer.renderStatus,
    handleActionResult: actions.handleActionResult,
    runAction: actions.runAction,
    selectTab: renderer.selectTab,
    renderDiagnostics: renderer.renderDiagnostics,
    renderDebugFrames: renderer.renderDebugFrames,
    diagnosticExport: () => diagnosticExport({ status: state.status, diagnostics: state.diagnostics }),
  };
}

function boot() {
  if (typeof document === "undefined" || !document.getElementById || !document.getElementById("app")) return null;
  return buildApp();
}

module.exports = { boot, createApp: buildApp, app: boot() };