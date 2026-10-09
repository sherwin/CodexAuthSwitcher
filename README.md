# Codex Auth Switcher

Electron desktop account picker with an independently runnable Node.js Responses proxy.
The previous Swift application is retained as a legacy version; new development uses Electron and Node.js.

## Run

Use Node.js 22.12+ for development and packaging. The standalone service supports Node.js 20.11+.

```sh
npm ci
npm start
```

The **本地 API 服务** and **Codex 连接配置** are independent: the proxy runs whether Codex
uses Key, a direct authorization file, or has not been configured by this tool.
The two tabs are **本地代理** (exit file, network, curl and statistics) and **Codex 配置**
(empty / Key / authorization-file). Selecting a mode only previews its controls; applying is explicit.
New installations default to empty and never write Codex configuration automatically. Existing
configured modes persist. Applying empty relinquishes management without writing or clearing
`config.toml` or `auth.json`; it does not undo an earlier configuration. There is no desktop restore action.
Choose your authorization backup directory and proxy exit account. Under Codex connection settings,
click **应用 Key 模式** to connect Codex through the proxy.
The tool backs up `config.toml` and `auth.json` before installing local API-key authentication.
It scans active and archived rollout metadata for saved provider IDs, redirects the built-in
OpenAI provider through `openai_base_url`, and installs local aliases for custom provider IDs.
Conversation logs and SQLite indexes are never rewritten. Existing custom provider sections
are retained privately and restored when applying authorization-file mode.
Restart Codex once after applying this setup, then continue the original conversations.
Already-loaded connections cannot be changed by writing files. Later proxy account switches
affect new requests immediately. Applying Key mode remains available for repair and newly imported histories.
The renderer never receives access tokens, refresh tokens, or the gateway key.

In any Codex mode, expand **curl 调用示例** for a masked Responses request (ordinary JSON by default).
Choose **流式 SSE** to copy a streaming request instead.
The **复制** button attached to the command copies a runnable command with the real local key
immediately, without a confirmation dialog.
The main process writes directly to the clipboard; the renderer receives only the masked preview.
The command defaults to `gpt-6.1-sol` without changing Codex's own configured model, and uses the selected proxy
account at execution time. macOS/Linux commands target POSIX shells; Windows commands target
PowerShell and use `curl.exe`. Running a request consumes account usage. Treat copied commands
as credentials: do not share them, and remember clipboard and terminal history retain the key.

Under **授权文件**, the same account cards and usage status as the local proxy are displayed.
Click **切换到此账号** on a card to back up configuration and credentials, write the selected
ChatGPT account to `auth.json`, select the OpenAI provider, and set file credential storage.
This direct-file switch does not renew tokens or query upstream usage. Expired/revoked credentials
can be copied; Codex may still require a new login when using them. Usage-query errors do not block
the copy. Proxy exit changes still validate account access before routing requests.
It removes only the managed proxy section and authentication fields, preserving unrelated settings
including edits made since proxy setup. Mode changes require restarting Codex.
Changing the proxy exit never writes Codex authorization, even in direct-file mode. Applying a
different direct-file account never changes the proxy exit. Curl and LAN calls continue using the
proxy exit in every Codex mode. Updating Codex authorization requires restarting Codex, not the proxy.
Key mode means a fixed local proxy key, not converting a subscription token into an OpenAI API key.
Stop active Codex tasks before changing modes or direct authorization files; other Codex processes
can still independently refresh credentials. Timestamp/UUID backups stay in the private state directory.

Closing the window hides it; the tray icon opens it again. Quitting the application stops its proxy.
If a standalone service already owns the port, the window connects to that service instead.
The desktop does not offer a restore action; private safety backups are retained.

## Standalone service

### Daily, weekly, and monthly tokens

Open the **用量统计** chart-icon button for a separate statistics page. Select today, this week,
or this month, then filter a single account
or all accounts, with input/output/total tokens, cached and reasoning details, request coverage,
and a 24-hour daily chart or per-day weekly/monthly chart. Weeks start on Monday and months are
calendar months, in Beijing time; future dates appear as zero. Existing daily records are aggregated
without double-counting. The page refreshes every ten seconds. Requests are assigned to their completion
date in Asia/Shanghai (UTC+8), and to the account fixed when that request was admitted.
Statistics include all calls through the proxy (Codex, curl, LAN), not direct authorization-file
traffic or use before this feature was installed. Unknown usage from missing/failed/interrupted
responses is shown separately; displayed token totals may therefore be lower than actual usage.
Cached tokens are already part of input tokens and reasoning tokens are already part of output:
neither is added again to total tokens. Daily JSON files are stored privately under `statistics/`
in the state directory, using cross-process locks and atomic writes. No prompts, responses, authentication tokens,
or raw account IDs are persisted. Copies of the same authenticated identity share one account row.
Statistics endpoints remain local-only when LAN access is enabled. Failed writes trigger the
existing DingTalk error path; configuring its webhook is still required for actual delivery.

## Standalone service commands

```sh
node proxy/server.mjs initialize --account account.json
node proxy/server.mjs serve
# In another terminal:
node proxy/server.mjs select --account account.json
node proxy/server.mjs configure
node proxy/server.mjs status
node proxy/server.mjs restore
```

Environment variables:

| Variable | Purpose |
| --- | --- |
| `AUTH_SWITCHER_HOME` | Private state directory. Defaults to macOS Application Support or `~/.codex-auth-switcher`. |
| `AUTH_SWITCHER_AUTH_DIR` | Authorization backups directory used on first initialization. Choose a different directory in the Electron window. |
| `CODEX_HOME` | Codex configuration directory. Defaults to `~/.codex`. |
| `HTTPS_PROXY` | Outbound HTTP proxy. macOS system HTTPS proxy settings are detected when this is absent. |
| `AUTH_SWITCHER_DINGTALK_WEBHOOK` | DingTalk robot webhook for serious proxy/authorization errors, deduplicated for five minutes. Tokens and prompts are excluded. |

New installs default to `127.0.0.1:18888`; existing saved ports are preserved until changed.
Use **允许局域网访问** and **应用网络设置** to enable trusted LAN clients. The proxy then binds
to all IPv4 interfaces and permits only private/link-local IPv4 peers. Public-address peers are rejected.
Account management and health endpoints still require a loopback connection, even with a valid key;
forwarded-IP headers do not grant access. No browser origins are accepted.
The window lists detected LAN Base URLs and offers LAN-specific curl commands with the same key.
When LAN access is enabled, the displayed address and default curl use the first discovered LAN IP,
not loopback. Select another LAN interface if needed. With no LAN IPv4 address available, copying is
disabled rather than generating an unusable loopback command. The local Codex connection still uses
loopback so its configuration does not depend on DHCP addresses.
Choose the reachable physical network interface if VPNs create multiple addresses. On the remote
computer, configure the displayed LAN Base URL and copied local key using a Responses-compatible client.
Firewalls must allow the chosen port; IP addresses may change with DHCP. This feature does not configure
firewalls or routers. Do not forward the port to the internet: HTTP traffic is unencrypted.

Ports are editable from 1024 through 65535. Active requests block reconfiguration. A failed bind restores
the old settings and restarts the previous listener. In Key mode, port changes update the local Codex
provider Base URL with a backup; restart Codex afterward. Remote clients must update their URLs separately.
Turning LAN access off does not require changing the local Codex Base URL.
The generated key is stored in a private `proxy.json` and Codex provider settings, both mode `0600` on Unix.
Authorization files retain the existing JSON format and use atomic replacement with `0600` permissions.
Keychain migration is not included in this version; Windows users should restrict the state and auth directories to their own account.

Supported routes: `POST /v1/responses`, `POST /v1/responses/compact`, `GET /v1/models`.
Each request fixes its upstream account at admission. Existing streams retain that account after a switch.
SSE streams use backpressure and propagate cancellation; headers, upstream status codes, request IDs, and rate-limit headers are forwarded.
Responses requests honor `stream`: omitted/false returns one Responses JSON object; true forwards SSE unchanged.
For legacy Codex credentials the upstream requires SSE, so non-streaming requests collect the final response
while retaining output items (including tools/reasoning), usage, and incomplete status. Failed or truncated
streams produce an error instead of partial success; aggregation is limited to 32 MiB of upstream events.
API-key upstreams receive the requested streaming flag directly. Ordinary text `input` is adapted to the
legacy Codex backend's message-array format. The API remains Responses, not Chat Completions.
WebSockets are disabled in the installed provider. Conversation requests must carry full input, without `previous_response_id`.
Model inference is routed to the Codex backend for legacy Codex OAuth credentials, and to the standard API for explicit API credentials or newer OAuth registrations.
Subscription accounts are validated using the usage API before selection. API-key account selection is currently not exposed in the subscription picker.
Refreshing a legacy Codex session uses its legacy OAuth endpoint; newer registered clients use the documented registration endpoint.
Refreshes use `proper-lockfile` across UI and service requests, save rotated credentials together, and retry an expired-token request at most once.
Refresh terminal errors require a new login. The application does not pool accounts or switch automatically on limits.
Do not run the old Swift switcher alongside the new application: it may overwrite or independently refresh the same credentials.

## Package

```sh
npm test
npm run pack
```

Electron Builder has targets for macOS, Windows (NSIS), and Linux (AppImage).
Build release artifacts on the corresponding platform; only macOS has been locally exercised here.
Production signing/notarization must be configured before distributing outside this computer.
