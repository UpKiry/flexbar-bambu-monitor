/**
 * 诊断导出：只保留白名单字段与数值。
 *
 * 路径、日志、任务名、设备标识和错误文本可能包含任意内容，一律不导出。
 */

const { EXPORTABLE_METHODS, EXPORTABLE_REQUEST_KINDS, EXPORTABLE_ACTIVITIES } = require("./api");

function diagnosticExport({ status, diagnostics, now = () => new Date() }) {
  const snapshot = status || {};
  const printer = snapshot.printer || {};
  const report = printer.state || {};
  const link = printer.link || {};
  const oneOf = (value, allowed) => (allowed.includes(value) ? value : null);
  const number = (value) => (Number.isFinite(value) ? value : null);
  const sensor = (value) => ({ current: number(value?.current), target: number(value?.target) });
  const requests = Array.isArray(diagnostics?.requests) ? diagnostics.requests : [];
  return {
    generatedAt: now().toISOString(),
    status: {
      authState: oneOf(snapshot.auth?.state, ["signed-in", "signed-out", "expired"]),
      region: oneOf(snapshot.config?.region, ["global", "china"]),
      credentialStoreAvailable: snapshot.credentialStore?.available === true,
      deviceCount: Array.isArray(snapshot.devices) ? snapshot.devices.length : null,
      link: {
        state: oneOf(link.state, ["idle", "connecting", "connected", "reconnecting", "failed"]),
        attempt: number(link.attempt),
        subscribed: link.subscribed === true,
      },
      printerState: {
        activity: oneOf(report.activity, EXPORTABLE_ACTIVITIES),
        lastReportAt: number(report.lastReportAt),
        progressPercent: number(report.progressPercent),
        remainingMinutes: number(report.remainingMinutes),
        nozzle: sensor(report.nozzle),
        bed: sensor(report.bed),
        chamber: { current: number(report.chamber?.current) },
      },
    },
    diagnostics: {
      requests: requests.map((request) => ({
        at: number(request.at),
        method: oneOf(request.method, EXPORTABLE_METHODS),
        status: number(request.status),
        kind: oneOf(request.kind, EXPORTABLE_REQUEST_KINDS),
        durationMs: number(request.durationMs),
      })),
    },
  };
}

/** 复制导出文本；优先 Clipboard API，回退到隐藏 textarea。 */
async function copyDiagnosticsText({ text, documentRef, showMessage }) {
  try {
    await navigator.clipboard.writeText(text);
    showMessage("诊断信息已复制（已隐去用户、设备和任务标识）", "success");
    return;
  } catch {
    // 回退到隐藏 textarea + execCommand。
  }

  const fallback = documentRef.getElementById("copy-fallback");
  if (!fallback) {
    showMessage("无法复制诊断信息，请展开已隐去标识的状态快照手动复制。", "error");
    return;
  }
  fallback.hidden = false;
  fallback.value = text;
  fallback.select();
  let copied = false;
  try {
    copied = documentRef.execCommand("copy");
  } catch {
    copied = false;
  }
  fallback.hidden = true;
  showMessage(copied ? "诊断信息已复制（已隐去用户、设备和任务标识）" : "无法复制诊断信息，请展开已隐去标识的状态快照手动复制。", copied ? "success" : "error");
}

module.exports = {
  diagnosticExport,
  copyDiagnosticsText,
};
