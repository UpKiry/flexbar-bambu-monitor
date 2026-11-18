"use strict";

/**
 * 浏览器后台的独立开发入口。
 *
 * 不启动 FlexDesigner，用一个只保存内存配置的假宿主运行同一套 runtime，
 * 方便单独调试登录、设备列表和云端请求。令牌只保存在内存，不写系统钥匙串。
 *
 * 用法：npm run admin:dev
 */

const path = require("node:path");
const { createPluginRuntime } = require("../src/runtime");
const { createCredentialStore, createMemoryBackend } = require("../src/auth/credential-store");
const { createAdminServer } = require("../src/admin/server");

const pluginDirectory = path.join(__dirname, "..", "com.upkiry.bambumonitor.plugin");

function createDevPlugin() {
  const handlers = new Map();
  let config = { region: "global", printerId: "", printerName: "" };
  return {
    directory: pluginDirectory,
    handlers,
    on(type, handler) {
      handlers.set(type, handler);
    },
    async getConfig() {
      return { ...config };
    },
    async setConfig(next) {
      config = { ...next };
      return { status: "success" };
    },
    async draw() {
      return { status: "success" };
    },
  };
}

async function main() {
  const logger = {
    debug: (message) => console.debug(message),
    info: (message) => console.info(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
  };

  // 开发模式不碰系统钥匙串，避免和真实插件共用登录状态。
  const backend = createMemoryBackend();
  backend.probe = async () => ({ available: false, reason: "开发模式仅内存保存" });
  const credentialStore = createCredentialStore({ backend });

  const plugin = createDevPlugin();
  const runtime = createPluginRuntime({ plugin, logger, credentialStore });
  const admin = createAdminServer({
    runtime,
    staticDir: path.join(pluginDirectory, "resources", "admin"),
    logger,
  });
  runtime.attachAdmin(admin);

  await runtime.start();
  let result;
  if (process.argv.includes("--no-open")) {
    await admin.start();
    result = {
      opened: false,
      url: admin.url(),
      message: "未自动打开浏览器（--no-open）。",
    };
  } else {
    result = await admin.open();
  }
  console.info("\n浏览器后台已启动。");
  if (!result.opened) {
    console.info("未能自动打开浏览器；请在支持的桌面会话中重试。");
  }

  const shutdown = async () => {
    await runtime.shutdown();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch(() => {
    console.error("开发后台启动失败");
    process.exit(1);
  });
}

module.exports = { createDevPlugin };
