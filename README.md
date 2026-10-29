# Codex Auth Switcher

Codex Auth Switcher 是一个跨平台 Electron 应用，同时提供本地 OpenAI 兼容代理。它可以管理 ChatGPT 授权文件、DeepSeek/API Key 账号，并让 Codex、curl 或局域网客户端使用选定的代理出口。

支持 macOS、Windows、Linux。界面默认英文，可切换简体中文。

## 快速开始

需要 Node.js 20+（开发和打包建议 Node.js 22+）。

```sh
npm ci
npm start
```

应用启动后：

1. 在“本地代理”中选择或导入代理出口账号。
2. 在“Codex 配置”中选择 Key 模式或授权文件模式。
3. 应用配置后重启 Codex。

本地代理默认监听 `127.0.0.1:18888`。代理和 Codex 配置可以独立使用；切换代理出口不会修改 Codex 授权文件。

## DeepSeek / API Key 账号

在“本地代理 → 添加 DeepSeek 账号”中填写：

- 账号名称
- Base URL，默认为 `https://api.deepseek.com`
- API Key

也支持其他 OpenAI 兼容服务。Base URL 可带 `/v1`，应用会自动拼接接口路径。账号保存后选择卡片即可作为代理出口；选择时会通过 `/models` 验证 Key。Key 只保存在本地授权目录，不会返回到界面。

DeepSeek 支持：

- `POST /v1/responses`
- `POST /v1/chat/completions`
- `GET /v1/models`

## 代理设置

“设置”中可以配置自动重试：

- 最大重试次数：`0–20`，默认 `5`
- 最短等待时间：默认 `1` 秒
- 最长等待时间：默认 `5` 秒

容量错误、502 和流式网络断开会按设置重试。设置为 0 表示不重试。

## 请求记录与统计

“请求记录”保存请求状态、尝试次数和错误事件。记录按日期写入 `requests-YYYY-MM-DD.sqlite3`，单日最多保留 2000 条，单条请求/响应正文最多保存 256KB。

“用量统计”按代理出口统计 Token 使用量。统计文件保存在应用私有状态目录中。

## 独立运行代理

```sh
# 初始化
node proxy/server.mjs initialize

# 启动代理
node proxy/server.mjs serve

# 查看状态或切换账号
node proxy/server.mjs status
node proxy/server.mjs select --account account.json
```

支持的代理接口：

```text
POST /v1/responses
POST /v1/responses/compact
POST /v1/chat/completions
GET  /v1/models
```

## 局域网 Web 管理（可选）

```sh
node proxy/web.mjs
```

Web 管理默认端口为 `18889`，代理端口为 `18888`。使用前设置 `AUTH_SWITCHER_WEB_PASSWORD_FILE`，文件中放置至少 10 位管理密码。只应在可信局域网使用，不要将 HTTP 端口暴露到公网。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `AUTH_SWITCHER_HOME` | 应用状态目录 |
| `AUTH_SWITCHER_AUTH_DIR` | 授权文件目录 |
| `CODEX_HOME` | Codex 配置目录，默认 `~/.codex` |
| `HTTPS_PROXY` | 上游 HTTP/HTTPS 代理 |
| `AUTH_SWITCHER_DINGTALK_WEBHOOK` | 重要错误的钉钉通知 Webhook |
| `AUTH_SWITCHER_WEB_PASSWORD_FILE` | Web 管理密码文件 |
| `AUTH_SWITCHER_WEB_PORT` | Web 管理端口 |

## 开发、测试与打包

```sh
npm test
npm run test:desktop
npm run pack   # 生成当前平台的解包目录
npm run dist   # 生成安装包
```

macOS 解包应用默认位于：

```text
dist/mac-arm64/Codex Auth Switcher.app
```

## 数据与安全

授权文件、API Key、本地代理 Key 和请求记录都保存在本机私有目录。不要分享包含真实 Key 的 curl 命令、配置文件或请求记录。HTTP 局域网模式不加密，建议只使用 HTTPS 上游和可信网络。

## License

[MIT License](LICENSE)
