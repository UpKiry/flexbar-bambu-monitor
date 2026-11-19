/**
 * 浏览器轮询：同一端点只保留一个请求；操作后等待旧请求结束再读新状态。
 *
 * 代次（generation）用于丢弃旧会话的迟到响应，避免退出或换账号后旧数据覆盖界面。
 */

const STATUS_POLL_MS = 1_000;
const DIAGNOSTICS_POLL_MS = 2_500;

/**
 * @param {object} options
 * @param {object} options.api createApi 返回值
 * @param {() => object} options.getState 读取共享状态
 * @param {() => number} options.getGeneration
 * @param {(data: object) => void} options.onStatus
 * @param {(data: object) => void} options.onDiagnostics
 * @param {(type: "status"|"diagnostics", payload: object) => void} options.onFailure
 * @param {(type: "status"|"diagnostics", error: Error) => void} options.onError
 * @param {(type: "status"|"diagnostics") => void} options.onRecovered
 * @param {() => number} options.now
 */
function createPoller({
  api,
  getState,
  getGeneration,
  onStatus,
  onDiagnostics,
  onFailure,
  onError,
  onRecovered,
  now = () => Date.now(),
}) {
  const requests = { status: null, diagnostics: null };
  let statusTimer = null;
  let diagnosticsTimer = null;

  function token() {
    return getState().token;
  }

  async function loadStatus({ silent = false, fresh = false } = {}) {
    if (!token()) return;
    if (requests.status) {
      if (!fresh) return requests.status;
      await requests.status;
      if (!token()) return;
      if (requests.status) return loadStatus({ silent, fresh });
    }
    const generation = getGeneration();
    const request = (async () => {
      try {
        const data = await api.status();
        if (generation !== getGeneration() || !token()) return;
        onStatus(data);
        if (!silent) onRecovered("status");
      } catch (error) {
        if (generation !== getGeneration() || !token()) return;
        onFailure("status", error);
        if (!silent) onError("status", error);
      }
    })();
    requests.status = request;
    try { await request; } finally {
      if (requests.status === request) requests.status = null;
    }
  }

  async function loadDiagnostics({ silent = false, fresh = false } = {}) {
    if (!token()) return;
    if (requests.diagnostics) {
      if (!fresh) return requests.diagnostics;
      await requests.diagnostics;
      if (!token()) return;
      if (requests.diagnostics) return loadDiagnostics({ silent, fresh });
    }
    const generation = getGeneration();
    const request = (async () => {
      try {
        const data = await api.diagnostics();
        if (generation !== getGeneration() || !token()) return;
        onDiagnostics(data);
        if (!silent) onRecovered("diagnostics");
      } catch (error) {
        if (generation === getGeneration() && !silent && token()) onError("diagnostics", error);
      }
    })();
    requests.diagnostics = request;
    try { await request; } finally {
      if (requests.diagnostics === request) requests.diagnostics = null;
    }
  }

  function start(documentRef) {
    stop();
    statusTimer = setInterval(() => {
      if (!documentRef?.hidden && token() && !getState().busy) loadStatus({ silent: true });
    }, STATUS_POLL_MS);
    diagnosticsTimer = setInterval(() => {
      if (!documentRef?.hidden && token()) loadDiagnostics({ silent: true });
    }, DIAGNOSTICS_POLL_MS);
  }

  function stop() {
    if (statusTimer) clearInterval(statusTimer);
    if (diagnosticsTimer) clearInterval(diagnosticsTimer);
    statusTimer = null;
    diagnosticsTimer = null;
  }

  return { loadStatus, loadDiagnostics, start, stop, now };
}

module.exports = {
  STATUS_POLL_MS,
  DIAGNOSTICS_POLL_MS,
  createPoller,
};
