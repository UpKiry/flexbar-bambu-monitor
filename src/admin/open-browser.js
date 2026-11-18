const { spawn } = require("node:child_process");

/**
 * 从插件后台拉起系统默认浏览器。
 *
 * 这里刻意不依赖宿主 Electron API：SDK 的 electronAPI 白名单没有 shell，
 * 而插件进程本身是 Node 环境，用系统命令最稳。
 *
 * 只允许打开本机回环地址，避免把后台 token 拼进任意 URL 后交给系统命令。
 */

const LOCAL_ADMIN_URL = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/(?:#.*)?$/;

function isLocalAdminUrl(url) {
  return typeof url === "string" && LOCAL_ADMIN_URL.test(url);
}

/** 返回 `{ command, args, windowsHide? }`，便于单元测试和跨平台调整。 */
function browserCommandFor(url, platform = process.platform) {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    // `start` 的第一个引号参数是窗口标题，必须给一个空标题占位。
    return { command: "cmd", args: ["/c", "start", "", url], windowsHide: true };
  }
  return { command: "xdg-open", args: [url] };
}

/**
 * 尝试打开浏览器。永远 resolve，不抛错：
 * 上层需要根据 `opened` 决定是否把 URL 显示给用户手动打开。
 *
 * @returns {Promise<{opened: boolean, reason: string}>}
 */
function openBrowser(url, { platform = process.platform, spawnFn = spawn, timeoutMs = 1_500 } = {}) {
  return new Promise((resolve) => {
    if (!isLocalAdminUrl(url)) {
      resolve({ opened: false, reason: "invalid-url" });
      return;
    }

    const spec = browserCommandFor(url, platform);
    let child;
    try {
      child = spawnFn(spec.command, spec.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: spec.windowsHide === true,
      });
    } catch (error) {
      resolve({ opened: false, reason: error?.message || "spawn-failed" });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // `open` 和 `xdg-open` 通常会快速退出；若子进程一直不退出，
    // 只要没有报错就按"已拉起"处理，不阻塞设置页。
    const timer = setTimeout(() => finish({ opened: true, reason: "launching" }), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.once("error", (error) => finish({ opened: false, reason: error?.message || "spawn-failed" }));
    child.once("close", (code) => {
      finish({ opened: code === 0, reason: code === 0 ? "" : `exit-${code}` });
    });
    if (typeof child.unref === "function") child.unref();
  });
}

module.exports = { isLocalAdminUrl, browserCommandFor, openBrowser };
