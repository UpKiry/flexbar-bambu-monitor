# Bambu Monitor

Flexbar 的 Bambu 打印机监控插件项目。目前包含 FlexCLI 生成的点击计数器示例，尚未接入打印机。

## 环境

- Node.js 20（本机已安装的 FlexCLI 1.0.7 在 Node.js 26 下无法启动）
- FlexDesigner 1.3.0 或更高版本，以及 Flexbar 设备
- FlexCLI：`npm install -g @eniac/flexcli`

## 开发

```sh
nvm use
npm install
npm run build
npm run plugin:validate
npm run dev
```

运行 `npm run dev` 前请启动 FlexDesigner。打包插件使用 `npm run plugin:pack`。插件标识为 `com.upkiry.bambumonitor`；作者和标识可在发布前按需修改，仓库地址尚未设置。

更多说明参见 [Flexbar SDK 文档](https://eniac-tech.github.io/FlexDocumentation/flexbar/en/sdk/getting_started.html)。
