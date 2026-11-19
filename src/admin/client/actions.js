/**
 * 浏览器动作：表单提交、登录/验证码/区域/设备流程与结果提示。
 *
 * 所有动作经本机 HTTP 转发给 runtime；这里不保存密码或云令牌，
 * 提交后立即清空输入框。
 */

const { accountKindError } = require("./view-model");

function createActions({
  document: documentRef,
  getState,
  api,
  renderer,
  loadStatus,
  loadDiagnostics,
  regionOf,
}) {
  function $(id) {
    return documentRef.getElementById(id);
  }

  function showMessage(text, type) {
    renderer.showMessage(text, type);
  }

  async function runAction(action, payload = {}) {
    const state = getState();
    if (!state.token || state.busy) return null;
    renderer.setBusy(true);
    state.generation += 1;
    try {
      const response = await api.action(action, payload);
      const result = response.result || {};
      handleActionResult(action, result);
      await loadStatus({ silent: true, fresh: true });
      await loadDiagnostics({ silent: true, fresh: true });
      return result;
    } catch (error) {
      if (state.token) showMessage(error.message, "error");
      return null;
    } finally {
      renderer.setBusy(false);
    }
  }

  function messageForAction(action, result) {
    switch (action) {
      case "login": return "登录成功";
      case "cancelCode": return "已取消验证码登录";
      case "logout": return "已退出登录";
      case "refreshDevices": return `已更新设备列表（${Array.isArray(result?.devices) ? result.devices.length : 0} 台）`;
      case "setPrinter": return "已更新要显示的打印机";
      case "setRegion": return "账号区域已更新";
      case "requestFullState": return result?.sent ? "已请求完整状态" : "请求完整状态失败";
      case "testConnection": return result?.message || "连接测试完成";
      default: return "操作完成";
    }
  }

  function handleActionResult(action, result) {
    const state = getState();
    const status = result?.status;
    if (action === "requestFullState" && typeof result?.sent === "boolean") {
      if (result.sent) showMessage("完整状态请求已提交，等待设备上报。", "success");
      else if (result.reason === "cooldown") {
        const seconds = Number.isFinite(result.retryInMs) ? Math.max(1, Math.ceil(result.retryInMs / 1000)) : 5;
        showMessage(`请求过于频繁，请在 ${seconds} 秒后重试。`, "warning");
      } else if (result.reason === "not-connected") showMessage("当前未连接云端，无法请求完整状态。", "warning");
      else showMessage("完整状态请求发送失败，请稍后重试。", "error");
      return;
    }
    if (status === "code-required") {
      state.awaitingCode = true;
      renderer.renderLoginMode(regionOf());
      showMessage(`请输入${regionOf() === "china" ? "短信" : "邮箱"}验证码`, "warning");
      const password = $("password-input");
      if (password) password.value = "";
      const code = $("code-input");
      if (code) code.focus();
      return;
    }
    if (status === "code-sent") {
      state.awaitingCode = true;
      renderer.renderLoginMode(regionOf());
      showMessage(`验证码已发送，请查收${regionOf() === "china" ? "短信" : "邮箱"}`, "success");
      const code = $("code-input");
      if (code) code.focus();
      return;
    }
    if (status === "unsupported") {
      showMessage(result.message || "该账号需要双重认证，当前版本尚不支持", "error");
      return;
    }
    if (status === "error" || status === "failed") {
      showMessage(result.message || "操作失败", "error");
      return;
    }
    if (status === "busy") {
      showMessage(result.message || "正在处理，请稍候", "warning");
      return;
    }
    if (status === "success") {
      if (action === "cancelCode") {
        state.awaitingCode = false;
        const code = $("code-input");
        if (code) code.value = "";
        renderer.renderLoginMode(regionOf());
      }
      if (action === "login" || action === "logout") {
        state.awaitingCode = false;
        const password = $("password-input");
        const code = $("code-input");
        if (password) password.value = "";
        if (code) code.value = "";
      }
      showMessage(messageForAction(action, result), "success");
      return;
    }
    showMessage(result?.message || "操作完成", "");
  }

  async function submitLogin(event) {
    event.preventDefault();
    const accountNode = $("account-input");
    const passwordNode = $("password-input");
    const codeNode = $("code-input");
    const account = accountNode ? accountNode.value.trim() : "";
    const password = passwordNode ? passwordNode.value : "";
    const code = codeNode ? codeNode.value.trim() : "";
    const state = getState();

    if (!account) {
      showMessage(regionOf() === "china" ? "请先填写 Bambu 账号手机号" : "请先填写 Bambu 账号邮箱", "error");
      return;
    }
    const kindError = accountKindError(account, regionOf());
    if (kindError) {
      showMessage(kindError, "error");
      return;
    }
    if (state.awaitingCode && !code) {
      showMessage("请输入验证码", "error");
      return;
    }
    if (!state.awaitingCode && !password) {
      showMessage("请输入密码，或先发送验证码", "error");
      return;
    }

    const result = await runAction("login", state.awaitingCode ? { account, code } : { account, password });
    // 无论成功失败，都不在输入框里保留密码和验证码。
    if (passwordNode) passwordNode.value = "";
    if (codeNode) codeNode.value = "";
    if (result?.status === "success") {
      state.awaitingCode = false;
      renderer.renderLoginMode(regionOf());
    }
  }

  async function sendCode() {
    const accountNode = $("account-input");
    const account = accountNode ? accountNode.value.trim() : "";
    if (!account) {
      showMessage(regionOf() === "china" ? "请先填写 Bambu 账号手机号" : "请先填写 Bambu 账号邮箱", "error");
      return;
    }
    const kindError = accountKindError(account, regionOf());
    if (kindError) {
      showMessage(kindError, "error");
      return;
    }
    const state = getState();
    const result = await runAction("requestCode", { account });
    if (result?.status === "code-sent" || result?.status === "code-required") {
      state.awaitingCode = true;
      renderer.renderLoginMode(regionOf());
      const code = $("code-input");
      if (code) code.focus();
    }
    if (result?.status === "success") {
      state.awaitingCode = false;
      renderer.renderLoginMode(regionOf());
    }
  }

  async function logout() {
    if (!window.confirm("退出登录后需要重新输入账号密码，确定吗？")) return;
    const state = getState();
    const result = await runAction("logout");
    if (result?.status === "success") {
      state.awaitingCode = false;
      const password = $("password-input");
      const code = $("code-input");
      if (password) password.value = "";
      if (code) code.value = "";
      renderer.renderLoginMode(regionOf());
    }
  }

  async function setRegion() {
    const select = $("region-select");
    if (!select) return;
    const state = getState();
    if (state.awaitingCode) return;
    const region = select.value;
    const previous = state.status?.config?.region;
    if (!region || region === previous) return;
    const result = await runAction("setRegion", { region });
    if (result?.status !== "success") {
      select.value = previous || "global";
      return;
    }
    state.awaitingCode = false;
    const account = $("account-input");
    const password = $("password-input");
    const code = $("code-input");
    if (account) account.value = "";
    if (password) password.value = "";
    if (code) code.value = "";
    renderer.renderLoginMode(regionOf());
  }

  async function setPrinter() {
    const select = $("printer-select");
    if (!select) return;
    const state = getState();
    const printerId = select.value;
    const previous = state.status?.config?.printerId || "";
    if (printerId === previous) return;
    const result = await runAction("setPrinter", { printerId });
    if (result?.status !== "success") {
      select.value = previous;
      return;
    }
    // 连接状态在后台异步变化，稍后再读一次。
    setTimeout(() => loadStatus({ silent: true }), 1_500);
  }

  return {
    runAction,
    handleActionResult,
    messageForAction,
    submitLogin,
    sendCode,
    logout,
    setRegion,
    setPrinter,
  };
}

module.exports = {
  createActions,
};
