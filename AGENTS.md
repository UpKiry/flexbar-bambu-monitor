# 仓库指南

## 项目结构与模块组织

- `src/plugin.js` 是 FlexDesigner 入口，只做事件接线、启动与退出清理；不要把协议细节塞进这里。
- `src/runtime.js` 负责宿主事件、配置读写、UI 消息分发与绘制调度。
- `src/auth/`、`src/cloud/`、`src/printer/`、`src/display/`、`src/util/` 按职责分层；模块之间通过显式参数注入依赖（`createApi`、`createMqttClient`、`drawKeyFn`），便于脱离宿主测试。
- `test/*.test.js` 使用 Node.js 内置 `node:test` 与 `node:assert/strict`。
- `com.upkiry.bambumonitor.plugin/` 是插件发布目录：`manifest.json` 定义元数据和按键，`ui/` 存放 Vue 配置页，`resources/` 存放静态资源。`ui/<name>.vue` 与 `manifest.json` 里的 `configPage` / 按键配置页名称一一对应。
- `rollup.config.mjs` 把源码打包到被忽略的 `com.upkiry.bambumonitor.plugin/backend/`。不要直接修改生成文件，也不要提交 `.flexplugin` 或 `logs/`。

## 构建、测试与开发命令

- `npm install`：安装依赖（包含 `mqtt`，会被打进插件包）。
- `npm test`：运行全部单元测试。
- `npm run build`：Rollup 构建生产包。
- `npm run plugin:validate`：校验插件目录与 manifest。
- `npm run plugin:pack` / `npm run plugin:install`：打包并安装到本机 FlexDesigner。
- `npm run dev`：链接插件、监听源码与 UI 文件、重启插件并输出调试日志。

Node.js 需要 20：FlexCLI 在 Node.js 26 下会因 `import ... assert { type: 'json' }` 崩溃。

## 编码风格与命名约定

两个空格缩进、分号、`const`/`let`；`src/` 为 CommonJS，`rollup.config.mjs` 为 ESM。函数与变量 `camelCase`，类 `PascalCase`，常量 `UPPER_SNAKE_CASE`。面向用户的文字使用简洁中文。

## 安全与配置

- 令牌只进系统安全存储，插件配置只保存区域、所选设备 ID 与名称。
- 日志必须经过 `src/util/logger.js` 的脱敏；不得记录密码、验证码、令牌、授权头或设备接入码。
- 设备列表在适配层丢弃 `dev_access_code`，不要把原始完整响应写进日志或测试样本。
- 测试样本必须是手写的脱敏数据，不要粘贴真实账号响应。
- 新增云端字段或状态值前先确认可在目标机型上验证；未知值保留原始串，不要猜测含义。

## 测试与验证

提交前运行 `npm test`、`npm run build`、`npm run plugin:validate`。涉及登录、云连接、绘制或配置持久化的改动还需在 FlexDesigner / Flexbar 上手动验证；未完成的真机验证必须在 `docs/云端监控设计方案.md` 的进度章节里记录，不能默认通过。
