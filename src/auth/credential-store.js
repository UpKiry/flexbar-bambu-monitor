const { spawn } = require("node:child_process");

/**
 * 系统安全存储接口。
 *
 * 安全要求（见 docs/开发指南.md「编码、命名与安全约束」）：
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
    child.stdin.on("error", () => {}); // 子进程提前退出时不暴露写入内容。
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** macOS 钥匙串：写入数据仅经子进程标准输入传递。 */
function createKeychainBackend({ service = SERVICE_NAME, account = ACCOUNT_NAME, runner = run } = {}) {
  // security 的交互命令按空格解析，标识符必须是受控的单个参数。
  if (![service, account].every((value) => typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value))) {
    throw new TypeError("钥匙串标识无效");
  }
  const prefix = "bambu-base64-v1:";
  return {
    kind: "keychain",
    cleanupWhenUnavailable: true,
    async probe() {
      const result = await runner("/usr/bin/security", ["default-keychain"]);
      return result.code === 0
        ? { available: true, reason: "" }
        : { available: false, reason: "无法访问系统钥匙串，令牌仅保留在内存中，重启后需重新登录" };
    },
    async read() {
      const result = await runner("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
      if (result.code === 44) return null;
      if (result.code !== 0) throw new Error("读取系统钥匙串失败");
      const value = result.stdout.trim();
      if (!value.startsWith(prefix)) return value || null; // 兼容旧版本存储的记录。
      const encoded = value.slice(prefix.length);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("钥匙串记录格式无效");
      return Buffer.from(encoded, "base64").toString("utf8") || null;
    },
    async write(secret) {
      if (typeof secret !== "string" || !secret) throw new TypeError("凭据无效");
      const value = prefix + Buffer.from(secret, "utf8").toString("base64");
      // security -i 的命令通过 stdin 输入；交互模式不可靠地返回子命令退出码，
      // 因此必须再次读取并比较，才视为持久化成功。
      const result = await runner("/usr/bin/security", ["-i"], {
        input: `add-generic-password -U -s ${service} -a ${account} -w ${value}\n`,
      });
      if (result.code !== 0 || await this.read() !== secret) throw new Error("写入系统钥匙串失败");
    },
    async clear() {
      const result = await runner("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", account]);
      if (result.code !== 0 && result.code !== 44) throw new Error("删除系统钥匙串中的旧凭据失败，请在钥匙串访问中手动删除");
    },
  };
}

/** Windows 安全持久化尚未实现，使用内存回退。 */
function createWindowsBackend() {
  return {
    kind: "dpapi",
    async probe() {
      return { available: false, reason: "Windows 安全存储尚未实现，令牌仅保留在内存中，重启后需重新登录" };
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
      try {
        await selected.write(secret);
        return { persisted: true, reason: "" };
      } catch {
        // 避免重启时恢复上一次账号；无法确认旧记录已删除则拒绝降级。
        await selected.clear();
        await fallback.write(secret);
        probeResult = { backend: selected.kind, available: false, reason: "无法写入系统安全存储，令牌仅保留在内存中，重启后需重新登录" };
        return { persisted: false, reason: probeResult.reason };
      }
    },
    async clear() {
      await fallback.clear();
      const info = await status();
      if (!info.available && !selected.cleanupWhenUnavailable) return;
      await selected.clear();
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
