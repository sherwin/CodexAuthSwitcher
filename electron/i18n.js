(() => {
    const translations = {
        '本地代理与 Codex 连接配置，独立管理。': 'Manage the local proxy and Codex connection independently.',
        '用量统计': 'Usage', '请求记录': 'Request logs', '设置': 'Settings', '刷新额度': 'Refresh usage',
        '导入授权文件': 'Import auth files', '退出登录': 'Log out', '配置管理': 'Configuration',
        '本地代理': 'Local proxy', 'Codex 配置': 'Codex config', '连接本地代理…': 'Connecting to local proxy…',
        '本地代理运行中': 'Local proxy running', '本地代理不可用': 'Local proxy unavailable',
        '独立运行 · 不受 Codex 认证模式影响': 'Runs independently · unaffected by Codex auth mode',
        '允许局域网访问': 'Allow LAN access', '端口': 'Port', '应用网络设置': 'Apply network settings',
        '选择授权目录': 'Choose auth directory', '更改授权目录': 'Change auth directory', '更改远程授权目录': 'Change remote auth directory',
        '远程管理本地代理与 Codex 配置。': 'Manage the local proxy and Codex configuration on this Linux host.',
        '代理出口账号': 'Proxy accounts', '添加自定义 API 账号': 'Add custom API account',
        '切换只影响代理的新请求，不修改 Codex 直连授权；进行中的请求继续使用原账号。': 'Switching affects new proxy requests only; direct Codex auth is unchanged and in-flight requests keep the current account.',
        '读取账号…': 'Loading accounts…', '拖动账号调整优先级；上方参与自动切换，下方不参与。': 'Drag accounts to set priority; the upper group participates in automatic switching.',
        '参与自动切换': 'Included in automatic switching', '不参与自动切换': 'Excluded from automatic switching',
        '暂无账号，拖动账号到这里以参与自动切换。': 'No accounts. Drag accounts here to include them.',
        '暂无账号，拖动账号到这里以退出自动切换。': 'No accounts. Drag accounts here to exclude them.',
        '代理出口': 'Proxy account', 'Codex 直连': 'Codex direct', '当前账号': 'Current account',
        '未选择': 'not selected', '自定义 API 账号已保存，可作为代理出口或 Codex 直连地址。': 'Custom API account saved. It can be used as a proxy account or direct Codex URL.',
        '切换到此账号': 'Switch to this account', '刷新': 'Refresh', '刷新中…': 'Refreshing…',
        '自定义 API · Key': 'Custom API · Key', '编辑配置': 'Edit config', '设为 Codex 地址': 'Use as Codex URL',
        '5 小时额度': '5-hour limit', '周额度': 'Weekly limit', '重置卡': 'Reset credits', '会员到期': 'Membership',
        '剩余': 'remaining', '刷新时间不可用': 'Refresh time unavailable', '查询中…': 'Checking…',
        '查询失败': 'Unavailable', '未提供': 'Not provided', '暂无可用重置卡': 'No reset credits available',
        '最近过期时间：未提供': 'No expiry provided', '随额度一起刷新': 'Updated with usage',
        '授权令牌到期': 'Auth token expires', '与会员到期无关': 'independent of membership expiry',
        'Responses / Chat Completions · API Key 已保存': 'Responses / Chat Completions · API key saved',
        '可作为代理出口，也可设为 Codex 直连地址': 'Usable as a proxy account or direct Codex URL',
        '空': 'None', '空 · 不管理 Codex 配置': 'None · Do not manage Codex config',
        '授权文件': 'Auth file', '应用 Key 模式': 'Apply key mode', '设为空（保留现有配置）': 'Set to none (keep current config)',
        '请求体': 'Request body', '返回体': 'Response body', '记录详情': 'Log details', '清空': 'Clear',
        '上一页': 'Previous', '下一页': 'Next', '跳转': 'Go', '刷新记录': 'Refresh logs',
        '全部记录': 'All records', '仅失败': 'Failures only', '容量错误': 'Capacity errors', '网络/断开错误': 'Network/disconnect errors',
        '今日': 'Today', '本周': 'This week', '本月': 'This month', '账号用量': 'Account usage',
        '总 Token': 'Total tokens', '输入 Token': 'Input tokens', '输出 Token': 'Output tokens', '请求次数': 'Requests',
        '本机代理': 'Local proxy', '读取 Codex 连接方式…': 'Loading Codex connection mode…',
        '当前账号': 'Current account', '重试设置已保存。': 'Retry settings saved.', '取消': 'Cancel', '保存设置': 'Save settings',
        '代理设置': 'Proxy settings', '开启自动重试': 'Enable automatic retry', '最大重试次数': 'Max retries', '最短秒': 'Min seconds', '最长秒': 'Max seconds',
        '暂无请求记录。': 'No request logs.', '正在读取请求记录…': 'Loading request logs…', '从左侧选择一条记录。': 'Select a log from the left.',
        '未选择记录': '(No record selected)', '未发现局域网 IPv4 地址，请检查网络连接。': 'No LAN IPv4 address found. Check the network connection.',
        '局域网已开启，但未发现私有 IPv4 地址，请检查网络连接。': 'LAN is enabled, but no private IPv4 address was found.',
        '仅本机访问': 'Local access only', '局域网 Base URL': 'LAN base URL', '本机': 'Local machine',
        '普通 JSON（默认）': 'Standard JSON (default)', '流式 SSE（Codex）': 'Streaming SSE (Codex)',
        '默认 18888 · 管理接口仅限本机 · 局域网 HTTP 不加密，请勿公网转发。Key 模式改端口会同步 Codex 地址，需重启 Codex；远程客户端须自行更新。': 'Default 18888 · management APIs stay local · LAN HTTP is unencrypted; do not expose it publicly. Changing the key-mode port updates the Codex URL; restart Codex and update remote clients.',
        '此目录没有 JSON 授权文件，请选择授权目录。': 'This directory has no JSON auth files. Choose an auth directory.',
        '复制': 'Copy', '一键复制完整 curl': 'Copy full curl command', 'curl 调用示例 · 当前代理出口': 'curl example · current proxy account',
        '时间不可用': 'Time unavailable', '登录': 'Sign in', '使用管理账号继续。': 'Use the administrator account to continue.', '用户名': 'Username', '密码': 'Password', '正在登录…': 'Signing in…', '登录已过期，请重新登录。': 'Session expired. Please sign in again.', '用户名或密码不正确': 'Invalid username or password', '尝试次数过多，请一分钟后重试': 'Too many attempts. Try again in one minute.', '管理账号继续。': 'Continue with the administrator account.',
        '固定本地密钥 · 流式转发': 'Fixed local key · streaming relay', '调用地址': 'Request URL', '返回方式': 'Response mode',
        '默认返回完整 JSON。预览隐藏 Key，一键复制包含真实本地 Key；消耗代理出口账号额度。请勿公开命令，Key 会留在剪贴板和终端历史中。': 'Returns complete JSON by default. The preview hides the key; copying includes the local key and consumes the proxy account quota. Do not share the command; the key remains in clipboard and shell history.',
        '账号名称': 'Account name', '例如：DeepSeek 主账号': 'Example: DeepSeek primary account',
        '填写 OpenAI 兼容 API 根地址，例如 DeepSeek 或局域网 Codex Auth Switcher 地址，可带 /v1。': 'Enter an OpenAI-compatible API root URL, such as DeepSeek or a LAN Codex Auth Switcher URL. An optional /v1 is allowed.',
        'Key 仅保存在当前授权目录，保存后不会显示。HTTP 地址会以明文传输 Key，请优先使用 HTTPS。': 'The key is stored only in the current auth directory and is never shown after saving. HTTP sends the key in plaintext; prefer HTTPS.',
        '支持 Responses 和 Chat Completions。保存后可作为代理出口，也可应用为 Codex 的直连地址。': 'Supports Responses and Chat Completions. After saving, it can be used as a proxy account or direct Codex URL.',
        '读取 Codex 连接方式…': 'Loading Codex connection mode…', 'Codex 模式': 'Codex mode',
        '首次默认选项。不清除、不改写 config.toml 或 auth.json；Codex 继续使用它自己的现有配置。本地代理仍独立运行。': 'The default option. Does not clear or rewrite config.toml or auth.json; Codex keeps its existing configuration. The local proxy continues to run independently.',
        '自动配置 Base URL 和本地 Key，使用「本地代理」Tab 中的出口授权文件。': 'Automatically configures the Base URL and local key using the account selected in the Local proxy tab.',
        '点击卡片直接覆盖 Codex 授权文件，不刷新令牌、不校验额度，也不改变代理出口。应用后需重启 Codex；文件失效时仍需重新登录。': 'Click a card to replace the Codex auth file directly. Tokens and quota are not refreshed, and the proxy account is unchanged. Restart Codex after applying; sign in again if the file expires.',
        '返回账号': 'Back to accounts', '请求与返回体都会保存；点击记录查看详情。': 'Request and response bodies are saved; click a record to view details.',
        '筛选错误类型': 'Filter error type', '第 1 / 1 页': 'Page 1 / 1', '返回体': 'Response body', '统计周期': 'Statistics period',
        '筛选账号': 'Filter account', '刷新统计': 'Refresh statistics', '每小时 Token': 'Hourly tokens', '每日 Token': 'Daily tokens',
        '用量未知': 'Unknown usage', '今日 Token 用量': 'Today\'s token usage', '关闭提示': 'Dismiss notification',
        '容量、502 Bad Gateway 和流式网络断开会在内部随机等待后重试。': 'Capacity, 502 Bad Gateway, and streaming disconnects retry after a random internal delay.',
        '已取消。': 'Cancelled.', '复制失败，请确认本地代理运行、所选地址可用。': 'Copy failed. Confirm that the local proxy is running and the selected address is available.',
        '正在验证': 'Verifying', '代理出口已切换到': 'Proxy account switched to', '新请求立即生效': 'new requests use it immediately',
        '保存中…': 'Saving…', '已保存': 'Saved', '保存失败：': 'Save failed: ', '读取记录…': 'Loading record…', '读取中…': 'Loading…',
        '编辑自定义 API 账号': 'Edit custom API account', '留空保留已有 Key': 'Leave blank to keep the existing key', '输入 API Key': 'Enter API key',
        '保存 API 账号': 'Save API account', '尚未由工具配置 Codex。可选择 Key 接入代理，或授权文件直连；两者都不会关闭本地代理。配置后需重启 Codex。': 'Codex has not been configured by this tool. Choose key mode or auth-file direct mode; neither disables the local proxy. Restart Codex after configuring.',
        'Codex 连接配置': 'Codex connection configuration', 'Key · 连接本地代理': 'Key · Connect to local proxy', 'Codex 授权文件': 'Codex auth files',
        'Key 连接已验证': 'Key connection verified', '重新应用 Key 配置': 'Reapply key configuration', '修复 Key 配置': 'Repair key configuration',
        '代理空闲': 'Proxy idle', '授权或额度查询失败，请刷新重试': 'Auth or usage query failed. Refresh and try again.', '查询额度中…': 'Checking usage…',
        '最近过期时间：查询中…': 'Nearest expiry: checking…', '未提供到期时间': 'No expiry provided', '上游未返回此账号的会员日期': 'The upstream did not return a membership date for this account',
        '会员有效期 · 随额度刷新': 'Membership period · refreshed with usage', '订阅未激活': 'Subscription inactive', '账期已到，会员仍有效（以上游为准）': 'Billing period ended; membership is still active (according to the upstream)',
        '宽限至 ': 'Grace period until ', '续费 ': 'Renews ', '没有可用于 Codex 直连的 ChatGPT 授权文件。': 'No ChatGPT auth file is available for direct Codex access.',
        'Key 已接入：本次代理启动后已收到本机 Codex 客户端请求。用量按代理出口账号统计；之后切换出口无需重启 Codex。': 'Key mode is connected: a request from the local Codex client was received after the proxy started. Usage is counted against the proxy account; switching proxy accounts no longer requires a Codex restart.',
        '代理配置已覆盖新旧会话的连接标识 · 等待 Codex 请求验证。请完全退出并重开 Codex，然后在原会话发送消息验证；无需新建会话。之后切换代理出口无需重启。': 'The proxy configuration covers new and existing session identifiers; waiting for a Codex request to verify it. Fully quit and reopen Codex, then send a message in the existing conversation; no new conversation is needed. Switching proxy accounts afterward does not require a restart.',
        'Codex 当前配置：局域网 Base URL · ': 'Current Codex configuration: LAN base URL · ', 'Codex 当前配置：授权文件直连 · ': 'Current Codex configuration: auth-file direct · ',
        'Codex 已切换到': 'Codex switched to', '请重启 Codex；代理出口未改变。': 'Restart Codex; the proxy account is unchanged.',
        '不支持的操作': 'Unsupported operation', '操作失败': 'Operation failed', '复制命令': 'Copy command', '读取目录…': 'Loading directory…',
        '选择文件夹进入，或使用当前目录。': 'Choose a folder to open it, or use the current directory.', '此目录没有可见子文件夹。': 'This directory has no visible subfolders.',
        '文件超过 1 MiB：': 'File exceeds 1 MiB: ', '已导入': 'Imported', '个账号。': ' account(s).', '个账号；': ' account(s);', '浏览器未允许复制，请在 HTTPS 环境重试。': 'The browser did not allow copying. Retry over HTTPS.',
        '局域网访问未开启。': 'LAN access is disabled.', '此局域网地址当前不可用。': 'This LAN address is currently unavailable.', '端口必须为 1024–65535 的整数。': 'The port must be an integer from 1024 to 65535.',
        '代理配置标记不完整。': 'Proxy configuration markers are incomplete.', 'Codex 的代理配置已被修改，请先检查配置后再改端口。': 'Codex proxy configuration was modified. Check it before changing the port.',
        '请选择有效的 ChatGPT 授权文件。': 'Choose a valid ChatGPT auth file.', '请输入局域网服务 Key。': 'Enter the LAN service key.',
        'Base URL 格式无效。': 'Invalid Base URL format.', 'Base URL 只支持 http/https，且不能包含账号密码。': 'Base URL must use http or https and cannot include credentials.',
        '上游事件格式无效。': 'Invalid upstream event format.', '上游最终响应格式无效。': 'Invalid final upstream response format.', '上游未返回响应内容。': 'The upstream returned no response content.',
        '上游生成失败。': 'Upstream generation failed.', '非流式响应超过大小限制，请使用流式请求。': 'The non-streaming response exceeded the size limit. Use a streaming request.',
        '系统 HTTP 代理地址无效。': 'Invalid system HTTP proxy address.', '请将系统代理设置为 HTTP/HTTPS 代理。': 'Set the system proxy to an HTTP/HTTPS proxy.',
        '个子进程正在运行': 'child process(es) running', '飞书连接运行中': 'Feishu bridge running', '飞书连接未运行': 'Feishu bridge is not running',
        '确认重启': 'Confirm restart',
        '正在应用代理配置并重启…': 'Applying proxy configuration and restarting…', '正在重启…': 'Restarting…',
        '代理模式已接入，飞书连接已重启。之后切换代理出口即可，无需重启。': 'Proxy mode connected and the Feishu bridge restarted. Switching proxy accounts afterward does not require a restart.',
        '飞书连接已重启，后续 Codex 请求将读取当前配置。': 'The Feishu bridge restarted. Future Codex requests will use the current configuration.',
        '飞书连接运行中': 'Feishu bridge running', '飞书连接未运行': 'Feishu bridge is not running',
        '选择远程授权目录': 'Choose remote auth directory', '浏览此 Linux 主机上的文件夹。选择目录会清除代理账号选择，但保留现有 Codex 授权不变。': 'Browse folders on this Linux host. Selecting a directory clears the proxy account selection and keeps existing Codex auth unchanged.',
        '查看日周月 Token 用量': 'View daily, weekly and monthly token usage', '今日每小时 Token 柱状图': 'Hourly token chart for today', '配置管理': 'Configuration', '筛选账号': 'Filter account', '筛选错误类型': 'Filter error type', '统计周期': 'Statistics period', '关闭提示': 'Dismiss notification',
        '成功': 'Success', '失败': 'Failed', '模型未知': 'Unknown model', '未知': 'Unknown', '（历史）': '(history)', '点': 'hour', '精确用量': 'Exact usage', '次请求未收到完整用量（中断、失败或上游未提供），总 Token 可能低于实际消耗。': ' requests did not return complete usage (interrupted, failed, or not provided upstream); total tokens may be lower than actual usage.', '无未知用量请求。未经过本地代理的调用不在统计范围内。': 'No requests with unknown usage. Calls that did not pass through the local proxy are excluded.',
        '已应用并更新 Codex Base URL，请重启 Codex。': 'Applied and updated the Codex Base URL. Restart Codex.', '网络设置已应用。': 'Network settings applied.', '已复制，可粘贴到对应电脑终端。': 'Copied. Paste it into the target computer terminal.', '已取消复制。': 'Copy cancelled.', '地址已变化，请刷新后重试。': 'The address changed. Refresh and try again.',
        ' · 与会员到期无关': ' · independent of membership expiry', '· 与会员到期无关': '· independent of membership expiry', '局域网 Base URL：': 'LAN Base URL: ',
        'Key 配置已覆盖新旧会话的连接标识 · 等待 Codex 请求验证。请完全退出并重开 Codex，然后在原会话发送消息验证；无需新建会话。之后切换代理出口无需重启。': 'Key configuration covers new and existing session identifiers; waiting for a Codex request to verify it. Fully quit and reopen Codex, then send a message in the existing conversation; no new conversation is needed. Switching proxy accounts afterward does not require a restart.',
        'Key 配置未匹配：Codex 配置被改动或无法读取。点击「修复 Key 配置」，保留其他设置并重新写入代理地址和 Key。': 'Key configuration mismatch: Codex configuration was changed or cannot be read. Click “Repair key configuration” to preserve other settings and write the proxy URL and key again.',
        'Key 配置已覆盖新旧会话。请完全退出并重开 Codex，在原会话发送消息验证；聊天记录不变。': 'Key configuration covers new and existing sessions. Fully quit and reopen Codex, then send a message in the existing conversation to verify it; chat history is unchanged.',
        'Base URL 配置无效': 'Invalid Base URL configuration', '全部账号': 'All accounts', '已收到上游用量': 'Usage received from upstream',
        '所选周期和账号没有经过代理的请求。': 'No proxied requests for the selected period and account.', '统计已更新，每 10 秒自动刷新。': 'Statistics updated; refreshes every 10 seconds.',
        '统计数据格式不完整，请刷新代理后重试。': 'Statistics data is incomplete. Refresh the proxy and try again.', '统计读取失败：': 'Failed to read statistics: ',
        '已设为空；Codex 现有配置和授权未改写，本地代理继续运行。': 'Set to none; existing Codex configuration and auth were not changed, and the local proxy continues running.',
        '已将该 API 账号应用为 Codex 直连地址，请重启 Codex。': 'Applied this API account as the direct Codex URL. Restart Codex.', '保存失败：': 'Save failed: ',
        '登录已过期': 'Session expired', '已知用量': 'Known usage', '查询额度中…': 'Checking usage…',
        '(未选择记录)': '(No record selected)', '(空)': '(Empty)',
    };
    const reverse = Object.fromEntries(Object.entries(translations).map(([zh, en]) => [en, zh]));
    const englishToChinese = {
        'Codex / Feishu connection': 'Codex / 飞书连接', 'Restart the Feishu bridge and its Codex child processes after applying key mode or switching an auth file. Proxy account changes take effect on new requests without a restart.': '应用 Key 模式或切换授权文件后，重启飞书连接及其 Codex 子进程。代理账号切换会对新请求生效，无需重启。',
        'Restart Codex / Feishu': '重启 Codex / 飞书', 'Apply proxy mode and restart': '应用代理模式并重启', 'Loading service status…': '正在读取服务状态…',
        'Choose remote auth directory': '选择远程授权目录', 'Browse folders on this Linux host. Selecting a directory clears the proxy account selection and keeps existing Codex auth unchanged.': '浏览此 Linux 主机上的文件夹。选择目录会清除代理账号选择，但保留现有 Codex 授权不变。',
        'Remote directory path': '远程目录路径', 'Open': '打开', 'Parent': '上级目录', 'Cancel': '取消', 'Use this directory': '使用此目录',
        'child process(es) running': '个子进程正在运行', 'Feishu bridge running': '飞书连接运行中', 'Feishu bridge is not running': '飞书连接未运行',
        'Confirm restart': '确认重启', 'Connect Codex to the local proxy and restart Feishu. Running Feishu tasks will be interrupted; existing chat history is kept.': '将 Codex 连接到本地代理并重启飞书。正在运行的飞书任务会被中断，但现有聊天记录会保留。',
        'Applying proxy configuration and restarting…': '正在应用代理配置并重启…', 'Restarting…': '正在重启…',
        'Proxy mode connected and the Feishu bridge restarted. Switching proxy accounts afterward does not require a restart.': '代理模式已接入，飞书连接已重启。之后切换代理出口无需重启。',
        'The Feishu bridge restarted. Future Codex requests will use the current configuration.': '飞书连接已重启，后续 Codex 请求将读取当前配置。'
    };
    let language = localStorage.getItem('codex-auth-switcher-language') || 'en';
    function translateText(value) {
        if (typeof value !== 'string') return value;
        if (language === 'zh') return englishToChinese[value] || reverse[value] || value;
        const leading = value.match(/^\s*/)?.[0] || '', trailing = value.match(/\s*$/)?.[0] || '', core = value.trim();
        if (translations[core]) return leading + translations[core] + trailing;
        const dynamic = core
            .replace(/^第 (\d+) \/ (\d+) 页 · 共 (\d+) 条$/, 'Page $1 / $2 · $3 records')
            .replace(/^记录 #(.+?) · /, 'Record #$1 · ')
            .replace(/^正在验证 (.+)…$/, 'Verifying $1…')
            .replace(/^飞书连接运行中 · PID (\d+)$/, 'Feishu bridge running · PID $1')
            .replace(/^局域网 (.+)$/, 'LAN $1')
            .replace(/^授权令牌到期 (.+) · 与会员到期无关$/, 'Auth token expires $1 · independent of membership expiry')
            .replace(/^授权令牌到期 (.+)$/, 'Auth token expires $1')
            .replace(/^Codex 当前配置：局域网 Base URL · (.+)。更新地址或 Key 后需重启 Codex。$/, 'Current Codex configuration: LAN base URL · $1. Restart Codex after updating the URL or key.')
            .replace(/^Codex 当前配置：授权文件直连 · (.+)。更新授权后需重启 Codex；代理仍独立运行。$/, 'Current Codex configuration: auth-file direct · $1. Restart Codex after updating auth; the proxy still runs independently.')
            .replace(/^尚未由工具配置 Codex。(.+)$/, 'Codex has not been configured by this tool. $1')
            .replace(/^(.+) 个请求进行中$/, '$1 request(s) in flight')
            .replace(/^(.+) · 北京时间 · 周一开始 \/ 自然月 · 数据保存在本机$/, '$1 · Beijing time · Monday start / calendar month · data saved locally')
            .replace(/ · 模型 /g, ' · model ').replace(/ · 尝试 /g, ' · attempts ').replace(/ · 错误事件 /g, ' · error events ')
            .replace(/ · 成功/g, ' · success').replace(/ · 失败/g, ' · failed')
            .replace(/^Codex 已切换到 (.+)，请重启 Codex；代理出口未改变。$/, 'Codex switched to $1. Restart Codex; the proxy account is unchanged.')
            .replace(/^保存失败：(.+)$/, 'Save failed: $1')
            .replace(/^已导入 (\d+) 个账号。$/, 'Imported $1 account(s).').replace(/^已导入 (\d+) 个账号；$/, 'Imported $1 account(s);')
            .replace(/^(.+) 次请求未收到完整用量（中断、失败或上游未提供），总 Token 可能低于实际消耗。$/, '$1 requests did not return complete usage (interrupted, failed, or not provided upstream); total tokens may be lower than actual usage.')
            .replace(/^宽限至 (.+)$/, 'Grace period until $1')
            .replace(/^续费 (.+)$/, 'Renews $1')
            .replace(/^已知用量 (.+) 次$/, 'Known usage: $1 requests')
            .replace(/^代理错误：(.+)$/, 'Proxy error: $1')
            .replace(/^统计读取失败：(.+)。显示数据可能不是最新。$/, 'Failed to read statistics: $1. The displayed data may be stale.')
            .replace(/^正在写入 (.+) 的 Codex 授权文件…$/, 'Writing the Codex auth file for $1…')
            .replace(/^代理出口已切换到 (.+)，新请求立即生效；Codex 直连授权未改变。$/, 'Proxy account switched to $1; new requests use it immediately. Direct Codex auth is unchanged.')
            .replace(/^刷新 (.+) 的额度和状态$/, 'Refresh usage and status for $1')
            .replace(/^最近过期时间 (.+)$/, 'Nearest expiry $1')
            .replace(/^已更新 (.+) 保存$/, 'Updated $1 · saved')
            .replace(/^点击「刷新额度」重试（(.+)）$/, 'Click “Refresh usage” to retry ($1)')
            .replace(/^刷新 (\S+)/g, 'Refresh $1').replace(/(\d+)% 剩余/g, '$1% remaining')
            .replace(/已更新 /g, 'Updated ').replace(/保存/g, 'saved').replace(/账号/g, 'account')
            .replace(/出口：/g, 'Account: ').replace(/局域网 Base URL：/g, 'LAN base URL: ')
            .replace(/仅本机访问：/g, 'Local access only: ').replace(/局域网访问：/g, 'LAN access: ')
            .replace(/未选择/g, 'not selected').replace(/未发现局域网 IP/g, 'No LAN IP found').replace(/未记录地址/g, 'address not recorded').replace(/未记录账号/g, 'account not recorded')
            .replace(/代理错误：/g, 'Proxy error: ').replace(/正在验证 /g, 'Verifying ')
            .replace(/正在写入 /g, 'Writing ').replace(/请重启 Codex/g, 'Please restart Codex')
            .replace(/查询额度中…/g, 'Checking usage…').replace(/暂无请求记录。/g, 'No request logs.')
            .replace(/请求记录读取失败：/g, 'Failed to read request logs: ');
        return leading + dynamic + trailing;
    }
    function apply() {
        document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
        for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = translateText(node.dataset.i18n);
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes) { if (node.parentElement?.closest('script,style')) continue; const original = node.nodeValue; const translated = translateText(language === 'en' ? original : (reverse[original] || original)); if (translated !== original) node.nodeValue = translated; }
        for (const node of document.querySelectorAll('[aria-label],[placeholder],[title]')) {
            for (const attribute of ['aria-label', 'placeholder', 'title']) {
                if (node.hasAttribute(attribute)) node.setAttribute(attribute, translateText(node.getAttribute(attribute)));
            }
        }
        const select = document.querySelector('#language-select'); if (select) select.value = language;
    }
    function setLanguage(next) {
        if (!['en', 'zh'].includes(next) || next === language) return;
        language = next;
        localStorage.setItem('codex-auth-switcher-language', language);
        apply();
        window.dispatchEvent(new CustomEvent('languagechange', { detail: { language } }));
    }
    window.i18n = Object.freeze({ get language() { return language; }, t: translateText, apply, setLanguage });
    document.addEventListener('DOMContentLoaded', () => {
        apply(); document.querySelector('#language-select')?.addEventListener('change', event => setLanguage(event.target.value));
    });
})();
