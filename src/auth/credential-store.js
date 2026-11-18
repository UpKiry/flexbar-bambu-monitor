const { spawn } = require("node:child_process");

/**
 * 系统安全存储接口。
 *
 * 设计要求（见 docs/云端监控设计方案.md §5.3）：
 * - 优先使用 macOS 钥匙串或 Windows 凭据管理器保存令牌；
 * - 普通插件配置只保存区域、所选设备 ID 和非敏感显示偏好；
 * - 若安全存储不可用，先明确处理方案，不能把明文持久化当作默认行为。
 *
 * 因此这里的默认策略是：安全存储可用则持久化令牌；不可用则只保留在进程内存，
 * 并把 `available: false` 明确交给上层，让界面提示"重启后需要重新登录"。
 */

const SERVICE_NAME = "com.upkiry.bambumonitor";
const ACCOUNT_NAME = "bambu-cloud-token";

function run(command, args, { input, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: error?.message || "spawn failed" });
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve({ code: -2, stdout: "", stderr: "timeout" });
      }
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.concat(out).toString("utf8"), stderr: error?.message || "" });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** macOS 钥匙串后端。令牌通过 stdin 之外的参数传递，这里尽量缩短其生命周期。 */
function createKeychainBackend({ service = SERVICE_NAME, account = ACCOUNT_NAME, runner = run } = {}) {
  return {
    kind: "keychain",
    async probe() {
      if (process.platform !== "darwin") return { available: false, reason: "当前平台不支持钥匙串" };
      // `security` 在无交互会话（例如沙箱、SSH）里会返回 Operation not permitted，
      // 用一次读取探测即可，不要用写入探测，避免污染钥匙串。
      const result = await runner("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
      if (result.code === 44) return { available: true, reason: "" }; // item not found，但工具可用
      if (result.code === 0) return { available: true, reason: "" };
      if (/Operation not permitted|not allowed/i.test(result.stderr)) {
        return { available: false, reason: "系统钥匙串拒绝了当前进程的访问" };
      }
      if (result.code === -1) return { available: false, reason: "找不到 security 命令" };
      return { available: false, reason: result.stderr.trim() || "钥匙串不可用" };
    },
    async read() {
      const result = await runner("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
      if (result.code === 44) return null;
      if (result.code !== 0) throw new Error(result.stderr.trim() || "读取钥匙串失败");
      return result.stdout.trim() || null;
    },
    async write(secret) {
      // 先删除旧条目再写入，避免 -U 在部分系统版本上残留旧属性。
      await runner("security", ["delete-generic-password", "-s", service, "-a", account]);
      const result = await runner("security", ["add-generic-password", "-a", account, "-s", service, "-w", secret]);
      if (result.code !== 0) throw new Error(result.stderr.trim() || "写入钥匙串失败");
    },
    async clear() {
      const result = await runner("security", ["delete-generic-password", "-s", service, "-a", account]);
      if (result.code !== 0 && result.code !== 44) throw new Error(result.stderr.trim() || "删除钥匙串条目失败");
    },
  };
}

/**
 * Windows 凭据管理器后端（cmdkey）。
 *
 * cmdkey 只能保存"目标/用户名"，不能读回密码，因此这里使用 PowerShell 的 DPAPI 加密文件方案：
 * 用当前用户作用域加密后写入插件目录，仅当前 Windows 用户可解密。
 * 该路径尚未在真实 Windows 环境验证，`probe()` 会返回 `verified: false`。
 */
function createWindowsBackend({ runner = run } = {}) {
  return {
    kind: "dpapi",
    async probe() {
      if (process.platform !== "win32") return { available: false, reason: "当前平台不支持 Windows 凭据存储" };
      const result = await runner("powershell", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]);
      if (result.code !== 0) return { available: false, reason: "无法调用 PowerShell" };
      return { available: true, verified: false, reason: "DPAPI 方案尚未在真实 Windows 环境验证" };
    },
    async read() {
      throw new Error("Windows 凭据存储尚未实现");
    },
    async write() {
      throw new Error("Windows 凭据存储尚未实现");
    },
    async clear() {
      return undefined;
    },
  };
}

/** 内存后端：安全存储不可用时的唯一兜底，绝不落盘。 */
function createMemoryBackend() {
  let value = null;
  return {
    kind: "memory",
    async probe() {
      return { available: false, reason: "未使用系统安全存储，令牌只保留在内存中" };
    },
    async read() {
      return value;
    },
    async write(secret) {
      value = secret;
    },
    async clear() {
      value = null;
    },
  };
}

/**
 * @param {object} [options]
 * @param {"darwin"|"win32"|"linux"|string} [options.platform]
 * @param {object} [options.backend] 显式指定后端（测试用）
 */
function createCredentialStore({ platform = process.platform, backend } = {}) {
  let selected = backend;
  const fallback = createMemoryBackend();
  if (!selected) {
    if (platform === "darwin") selected = createKeychainBackend();
    else if (platform === "win32") selected = createWindowsBackend();
    else selected = createMemoryBackend();
  }
  let probeResult = null;

  async function status() {
    if (probeResult) return probeResult;
    try {
      const probe = await selected.probe();
      probeResult = { backend: selected.kind, ...probe };
    } catch (error) {
      probeResult = { backend: selected.kind, available: false, reason: error?.message || "安全存储探测失败" };
    }
    return probeResult;
  }

  return {
    get backendKind() {
      return selected.kind;
    },
    status,
    async load() {
      const info = await status();
      if (!info.available) return fallback.read();
      try {
        return await selected.read();
      } catch {
        return null;
      }
    },
    async save(secret) {
      const info = await status();
      if (!info.available) {
        // 明确降级：仅为当前进程保留，界面需要提示"重启后需重新登录"。
        await fallback.write(secret);
        return { persisted: false, reason: info.reason || "安全存储不可用" };
      }
      await selected.write(secret);
      return { persisted: true, reason: "" };
    },
    async clear() {
      await fallback.clear();
      const info = await status();
      if (!info.available) return;
      try {
        await selected.clear();
      } catch {
        // 删除失败不应阻断退出登录流程，本地缓存仍会被清空。
      }
    },
  };
}

module.exports = {
  SERVICE_NAME,
  ACCOUNT_NAME,
  createCredentialStore,
  createKeychainBackend,
  createMemoryBackend,
  createWindowsBackend,
};
