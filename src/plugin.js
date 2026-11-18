const path = require("node:path");
const { plugin, logger } = require("@eniac/flexdesigner");
const { createPluginRuntime } = require("./runtime");
const { createAdminServer } = require("./admin/server");

/**
 * FlexDesigner 入口（见 docs/云端监控设计方案.md §7）。
 *
 * 这里只做接线：事件注册、服务启动、生命周期收尾。协议细节都在各模块中，
 * 以便脱离宿主环境做单元测试。
 */
const pluginDirectory = plugin.directory || path.join(__dirname, "..");
const runtime = createPluginRuntime({ plugin, logger });
const admin = createAdminServer({
  runtime,
  staticDir: path.join(pluginDirectory, "resources", "admin"),
  logger,
});
runtime.attachAdmin(admin);

// 先连宿主：之后 runtime 才能读到配置、注册的事件也才会收到消息。
plugin.start();

runtime.start().catch(() => {
  logger.error("Bambu Monitor 启动失败");
});

// 浏览器后台尽早启动，设置页点按钮时只需要拉起浏览器。
// 启动失败不影响 Flexbar 监控，设置页会显示后台不可用。
admin.start().catch(() => {
  logger.error("浏览器后台启动失败");
});

// 进程退出时关闭本地后台并断开云端连接，避免留下监听端口或悬挂的 MQTT 会话。
function shutdown() {
  return runtime.shutdown().catch(() => {
    logger.error("退出清理失败");
  });
}
function shutdownAndExit() {
  shutdown().finally(() => process.exit(0));
}
process.once("beforeExit", () => {
  shutdown();
});
process.once("SIGINT", shutdownAndExit);
process.once("SIGTERM", shutdownAndExit);

module.exports = { runtime, admin };
