# Codex Auth Switcher

## 中文

Codex Auth Switcher 是一个跨平台 Electron 应用，同时提供本地 OpenAI 兼容代理。它可以管理 ChatGPT 授权文件、DeepSeek/API Key 账号，并让 Codex、curl 或局域网客户端使用选定的代理出口。

支持 macOS、Windows、Linux。界面默认英文，可切换简体中文。

### 快速开始

需要 Node.js 20+；开发和打包建议 Node.js 22+。

```sh
npm ci
npm start
```

应用启动后：

1. 在“本地代理”中选择或导入代理出口账号。
2. 在“Codex 配置”中选择 Key 模式或授权文件模式。
3. 应用配置后重启 Codex。

本地代理默认监听 `127.0.0.1:18888`。代理和 Codex 配置可以独立使用；切换代理出口不会修改 Codex 授权文件。

### DeepSeek / API Key 账号

在“本地代理 → 添加 DeepSeek 账号”中填写账号名称、Base URL 和 API Key。Base URL 默认为 `https://api.deepseek.com`，也支持其他 OpenAI 兼容服务，可带 `/v1` 路径。

保存后选择账号卡片即可作为代理出口；选择时会通过 `/models` 验证 Key。Key 只保存在本地授权目录，不会返回到界面。

支持接口：

```text
POST /v1/responses
POST /v1/chat/completions
GET  /v1/models
```

### 内部重试机制

当上游返回：

```text
Selected model is at capacity. Please try a different model.
```

本地代理会在请求返回给 Codex 之前进行内部重试；502 Bad Gateway 和流式网络断开也会按同一策略重试。这样可以在上游短暂繁忙时自动恢复，避免立即把容量错误暴露给 Codex。

在“代理设置”中可调整：

- 最大重试次数：`0–20`，默认 `5`
- 最短等待时间：默认 `1` 秒
- 最长等待时间：默认 `5` 秒

设置为 0 表示不重试。达到上限后，代理才会把最后一次上游错误返回给客户端。

### 请求记录与统计

“请求记录”保存请求状态、尝试次数和错误事件。记录按日期写入 `requests-YYYY-MM-DD.sqlite3`，单日最多保留 2000 条，单条请求/响应正文最多保存 256KB。

“用量统计”按代理出口统计 Token 使用量。统计文件保存在应用私有状态目录中。

### 独立运行代理

```sh
node proxy/server.mjs initialize
node proxy/server.mjs serve
node proxy/server.mjs status
node proxy/server.mjs select --account account.json
```

### 局域网 Web 管理（可选）

```sh
node proxy/web.mjs
```

Web 管理默认端口为 `18889`，代理端口为 `18888`。使用前设置 `AUTH_SWITCHER_WEB_PASSWORD_FILE`，文件中放置至少 10 位管理密码。只应在可信局域网使用，不要将 HTTP 端口暴露到公网。

### 环境变量

| 变量 | 用途 |
| --- | --- |
| `AUTH_SWITCHER_HOME` | 应用状态目录 |
| `AUTH_SWITCHER_AUTH_DIR` | 授权文件目录 |
| `CODEX_HOME` | Codex 配置目录 |
| `HTTPS_PROXY` | 上游 HTTP/HTTPS 代理 |
| `AUTH_SWITCHER_DINGTALK_WEBHOOK` | 重要错误钉钉通知 |
| `AUTH_SWITCHER_WEB_PASSWORD_FILE` | Web 管理密码文件 |
| `AUTH_SWITCHER_WEB_PORT` | Web 管理端口 |

### 开发、测试与打包

```sh
npm test
npm run test:desktop
npm run pack
npm run dist
npm run dist:win
```

macOS 解包应用位于 `dist/mac-arm64/Codex Auth Switcher.app`。`npm run dist:win` 生成 Windows x64 NSIS 安装包和 zip 包；请在 Windows 上运行 `Codex Auth Switcher Setup 1.1.0.exe` 安装，不要直接运行解包目录。

### 数据与安全

授权文件、API Key、本地代理 Key 和请求记录都保存在本机私有目录。不要分享包含真实 Key 的 curl 命令、配置文件或请求记录。HTTP 局域网模式不加密，建议只使用 HTTPS 上游和可信网络。

## English

Codex Auth Switcher is a cross-platform Electron app with a local OpenAI-compatible proxy. It manages ChatGPT authorization files and DeepSeek/API key accounts, allowing Codex, curl, or trusted LAN clients to use the selected proxy account.

It supports macOS, Windows, and Linux. The UI defaults to English and can switch to Simplified Chinese.
The web process owns the scheduled authorization refresh loop. It scans every six
hours and renews renewable OAuth files whose access token expires within 24 hours.
The loop stops with the process, detects a changed authorization directory within
one minute, and does not require a separate system timer or service. The desktop
process uses the same embedded loop when it owns the local gateway.

### Quick start

Node.js 20+ is required. Node.js 22+ is recommended for development and packaging.

```sh
npm ci
npm start
```

After launch:

1. Select or import a proxy account in **Local proxy**.
2. Choose key mode or authorization-file mode in **Codex configuration**.
3. Restart Codex after applying the configuration.

The local proxy listens on `127.0.0.1:18888` by default. Proxy and Codex configuration are independent; switching the proxy account does not modify Codex authorization files.

### DeepSeek / API key accounts

Open **Local proxy → Add DeepSeek account** and enter an account name, Base URL, and API key. The default Base URL is `https://api.deepseek.com`. Other OpenAI-compatible services are supported, including URLs with a `/v1` path.

After saving, select the account card as the proxy exit. Selection validates the key through `/models`. Keys are stored only in the local authorization directory and are never returned to the UI.

Supported routes:

```text
POST /v1/responses
POST /v1/chat/completions
GET  /v1/models
```

### Internal retry mechanism

When the upstream returns:

```text
Selected model is at capacity. Please try a different model.
```

The local proxy internally retries this response before returning it to Codex. `502 Bad Gateway` and streaming disconnects use the same retry policy. This can recover from temporary upstream capacity or network failures without immediately exposing the error to Codex.

The **Proxy settings** dialog controls:

- Max retries: `0–20`, default `5`
- Minimum delay: default `1` second
- Maximum delay: default `5` seconds

Set max retries to 0 to disable retries. Once the limit is reached, the proxy returns the final upstream error to the client.

### Request logs and statistics

**Request logs** store status, attempt counts, and error events. Logs are stored in daily files named `requests-YYYY-MM-DD.sqlite3`; each day keeps at most 2,000 records and each request/response body is limited to 256KB.

**Usage statistics** report token usage by proxy account and are stored in the private application state directory.

### Standalone proxy

```sh
node proxy/server.mjs initialize
node proxy/server.mjs serve
node proxy/server.mjs status
node proxy/server.mjs select --account account.json
```

### Optional LAN web manager

```sh
node proxy/web.mjs
```

The web manager uses port `18889` and the proxy uses `18888` by default. Set `AUTH_SWITCHER_WEB_PASSWORD_FILE` to a file containing a password of at least 10 characters. Use it only on a trusted LAN and never expose the HTTP port to the public internet.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `AUTH_SWITCHER_HOME` | Application state directory |
| `AUTH_SWITCHER_AUTH_DIR` | Authorization directory |
| `CODEX_HOME` | Codex configuration directory |
| `HTTPS_PROXY` | Upstream HTTP/HTTPS proxy |
| `AUTH_SWITCHER_DINGTALK_WEBHOOK` | DingTalk alerts for serious errors |
| `AUTH_SWITCHER_WEB_PASSWORD_FILE` | Web manager password file |
| `AUTH_SWITCHER_WEB_PORT` | Web manager port |

### Development, testing, and packaging

```sh
npm test
npm run test:desktop
npm run pack
npm run dist
npm run dist:win
```

The macOS unpacked app is generated at `dist/mac-arm64/Codex Auth Switcher.app`. `npm run dist:win` generates a Windows x64 NSIS installer and zip package. Run `Codex Auth Switcher Setup 1.1.0.exe` on Windows to install the app; do not launch the unpacked directory directly.

### Data and security

Authorization files, API keys, the local proxy key, and request logs are stored in private local directories. Do not share curl commands, configuration files, or request logs containing real keys. LAN HTTP is unencrypted; use HTTPS upstreams and trusted networks.

## License

[MIT License](LICENSE)
