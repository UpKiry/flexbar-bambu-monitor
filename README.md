# Bambu Monitor

Flexbar 的 Bambu Lab 打印机监控插件。登录、选择打印机和诊断都在本机浏览器后台完成；FlexDesigner 的插件设置页只保留一个「进入后台」按钮。选好设备后，可在 Flexbar 上查看设备状态、打印进度、剩余时间和温度。回归云端优先：不需要填写打印机局域网 IP 或 LAN Access Code。

当前版本：`0.3.1`（阶段 1、阶段 2 与浏览器后台代码已完成，支持国区手机号 + 短信验证码，等待真实账号与真机验收）

## 环境

- Node.js 20（本机已安装的 FlexCLI 1.0.7 在 Node.js 26 下无法启动）
- FlexDesigner 1.3.0 或更高版本，以及 Flexbar 设备
- FlexCLI：`npm install -g @eniac/flexcli`

## 开发

```sh
nvm use
npm install
npm test
npm run build
npm run plugin:validate
npm run dev
```

运行 `npm run dev` 前请启动 FlexDesigner。打包与安装：

```sh
npm run plugin:pack
npm run plugin:install
```

只调登录和云端接口、不想启动 FlexDesigner 时：

```sh
npm run admin:dev
```

它会用内存配置启动同一套后台，并打印带一次性令牌的浏览器地址；`npm run admin:dev -- --no-open` 只打印地址、不自动打开浏览器。开发模式不读写系统钥匙串，避免和真实插件共用登录状态。

插件标识为 `com.upkiry.bambumonitor`；作者和标识可在发布前按需修改，仓库地址尚未设置。

## 使用

1. 在 FlexDesigner 打开插件设置，点击**进入后台**。
2. 浏览器打开本机后台后，先选择**账号区域**（全球 / 中国大陆），必须与账号所属区域一致。
3. **全球账号**填写邮箱，验证码发到邮箱；**中国大陆账号**填写手机号（可带 `+86`），验证码以短信发送。
4. 输入密码登录；服务端要求验证码时，点击「发送短信验证码」或「发送邮箱验证码」并按提示提交。
5. 登录后选择要显示的打印机（只有一台时自动选中）。
6. 回到 FlexDesigner，把「打印机状态」按键拖到 Flexbar 上；点击按键可在进度、温度、任务信息三种视图间切换。

后台地址只监听 `127.0.0.1`，插件退出后失效。浏览器没有自动打开时，设置页会显示完整地址，可手动复制访问。

按键显示：未登录 / 登录已失效 / 请选择打印机 / 正在连接云端 / 等待打印机状态 / 打印机离线 / 空闲 / 打印中 / 暂停 / 完整 / 异常 / 云端断开 / 数据已过期。

## 实现概览

```text
src/
  plugin.js                   # FlexDesigner 入口，只做接线
  runtime.js                  # 事件、配置、UI 消息、后台控制与绘制调度
  admin/
    server.js                 # 127.0.0.1 本地后台 HTTP 服务、令牌与路由
    diagnostics.js            # 脱敏日志 / 云端请求时间线缓冲
    open-browser.js           # 跨平台拉起默认浏览器
  auth/
    auth-service.js           # 登录状态机（含验证码流程）
    credential-store.js       # 系统安全存储接口（钥匙串 / DPAPI / 内存兜底）
  cloud/
    region.js                 # 账号区域与云端地址
    cloud-api.js              # 云 HTTP 请求、错误分类与脱敏请求追踪
    cloud-mqtt.js             # 云 MQTT 连接、订阅、抖动退避重连
  printer/
    printer-manager.js        # 设备选择与监控生命周期
    state-reducer.js          # 快照 / 增量合并、任务切换清理
    state-mapper.js           # 原始字段 → 统一模型
  display/
    presenter.js              # 展示文案、语气、绘制节流
    key-renderer.js           # 调用宿主绘制 API
  util/
    logger.js                 # 脱敏日志

com.upkiry.bambumonitor.plugin/
  ui/
    configPage.vue            # 只显示状态和一个「进入后台」按钮
    monitor.vue               # 单按键视图选择
  resources/admin/            # 浏览器后台的静态页面（无构建、无 CDN）
```

要点：

- **浏览器后台**：插件启动时在 `127.0.0.1` 的随机端口启动 HTTP 服务，使用进程级随机令牌；除静态页面外所有 API 都校验令牌，并拒绝非本机 Host / 跨站 Origin 请求。账号区域会决定输入类型：全球用邮箱，中国大陆用手机号。
- **设置页只做入口**：FlexDesigner 设置页不再包含登录表单，只显示登录 / 打印机状态和一个按钮；点击后由插件后台拉起系统默认浏览器。
- **业务逻辑不搬家**：后台页面只调用 `runtime.actions`，登录、设备、配置写入和 MQTT 仍由插件负责，避免两套状态。
- **凭据**：令牌写入系统安全存储（macOS 钥匙串）。安全存储不可用时明确降级为仅内存保存，后台会提示"重启后需重新登录"；不会把令牌明文写入插件配置。
- **不记录敏感信息**：日志统一脱敏（令牌、密码、验证码、`auth-token`、设备接入码）；诊断只记录云端请求的方法、路径、状态码、错误类型和耗时，不记录请求头、请求体或响应体。设备列表在适配层就已丢弃 `dev_access_code`。
- **状态合并**：增量报文缺失字段保留旧值；完整快照、设备切换与任务切换按明确规则清理旧字段，避免把上一个任务的进度带入新任务。
- **绘制节流**：数据到达立即更新内存，常规绘制最多每秒一次；状态切换、断线、故障立即重绘。
- **云连接**：TLS + 证书校验，断线使用带抖动的指数退避重连；认证失效时停止重试并提示重新登录。
- **验证码通道**：参考 [ha-bambulab](https://github.com/greghesp/ha-bambulab) 的实际行为，邮箱账号调用 `sendemail/code`，手机号账号调用国区 `api.bambulab.cn` 的 `sendsmscode`；代码验证码仍提交到登录接口。

## 验证状态

已通过：

- `npm test`：146 项单元测试（登录状态机、国区手机号 / 邮箱分流、错误分类、字段映射、增量合并、任务切换、重连退避、绘制节流、运行时事件流、本地后台鉴权/路由/限流、脱敏诊断、跨平台浏览器命令）。
- `npm run build`、`npm run plugin:validate`、`npm run plugin:pack`、`npm run plugin:install`。
- 安装后插件进程在 FlexDesigner 内正常运行，日志显示浏览器后台已监听 `127.0.0.1` 随机端口；静态页面返回 200，未带令牌的 `/api/status` 返回 401。
- 独立 `npm run admin:dev` 可启动同一套后台，并在 Chrome 无头模式下渲染出登录页与状态页。

**尚未完成（需真实账号与设备）**：

- 真实账号的登录、手机号短信验证码 / 邮箱验证码与双重认证流程；当前按 ha-bambulab 的接口实现，尚未用真实国区手机号验收。
- FlexDesigner 设置页按钮在 iframe 内拉起系统浏览器、以及真实浏览器中的完整登录操作（当前已验证后台服务本身和 `openBrowser` 命令层）。
- 云 MQTT 能否访问目标机型，以及实际推送延迟与可用字段。
- 系统钥匙串在插件运行环境中的读写（当前探测到沙箱内 `security` 返回 Operation not permitted，需在真实插件进程内确认）。
- Flexbar 上中文标题的显示效果与理想视图布局。

详见 [云端监控设计方案](docs/云端监控设计方案.md) 的"分阶段实施与验收"。

## 参考资料

- [Flexbar SDK 文档](https://eniac-tech.github.io/FlexDocumentation/flexbar/en/sdk/getting_started.html)
- [ha-bambulab（Home Assistant 集成，国区手机号 / 短信验证码参考）](https://github.com/greghesp/ha-bambulab)
- [OpenBambuAPI：云 HTTP 接口（社区）](https://raw.githubusercontent.com/Doridian/OpenBambuAPI/main/cloud-http.md)
- [OpenBambuAPI：MQTT 协议（社区）](https://raw.githubusercontent.com/Doridian/OpenBambuAPI/main/mqtt.md)
