(() => {
    const translations = {
        '本地代理与 Codex 连接配置，独立管理。': 'Manage the local proxy and Codex connection independently.',
        '用量统计': 'Usage', '请求记录': 'Request logs', '设置': 'Settings', '刷新额度': 'Refresh usage',
        '导入授权文件': 'Import auth files', '退出登录': 'Log out', '配置管理': 'Configuration',
        '本地代理': 'Local proxy', 'Codex 配置': 'Codex config', '连接本地代理…': 'Connecting to local proxy…',
        '本地代理运行中': 'Local proxy running', '本地代理不可用': 'Local proxy unavailable',
        '独立运行 · 不受 Codex 认证模式影响': 'Runs independently · unaffected by Codex auth mode',
        '允许局域网访问': 'Allow LAN access', '端口': 'Port', '应用网络设置': 'Apply network settings',
        '选择授权目录': 'Choose auth directory', '更改授权目录': 'Change auth directory',
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
        '代理设置': 'Proxy settings', '开启自动重试': 'Enable automatic retry', '最短秒': 'Min seconds', '最长秒': 'Max seconds',
        '暂无请求记录。': 'No request logs.', '正在读取请求记录…': 'Loading request logs…', '从左侧选择一条记录。': 'Select a log from the left.',
        '未选择记录': '(No record selected)', '未发现局域网 IPv4 地址，请检查网络连接。': 'No LAN IPv4 address found. Check the network connection.',
        '局域网已开启，但未发现私有 IPv4 地址，请检查网络连接。': 'LAN is enabled, but no private IPv4 address was found.',
        '仅本机访问': 'Local access only', '局域网 Base URL': 'LAN base URL', '本机': 'Local machine',
        '普通 JSON（默认）': 'Standard JSON (default)', '流式 SSE（Codex）': 'Streaming SSE (Codex)',
        '默认 18888 · 管理接口仅限本机 · 局域网 HTTP 不加密，请勿公网转发。Key 模式改端口会同步 Codex 地址，需重启 Codex；远程客户端须自行更新。': 'Default 18888 · management APIs stay local · LAN HTTP is unencrypted; do not expose it publicly. Changing the key-mode port updates the Codex URL; restart Codex and update remote clients.',
        '此目录没有 JSON 授权文件，请选择授权目录。': 'This directory has no JSON auth files. Choose an auth directory.',
        '复制': 'Copy', '一键复制完整 curl': 'Copy full curl command', 'curl 调用示例 · 当前代理出口': 'curl example · current proxy account',
        '时间不可用': 'Time unavailable', '管理账号继续。': 'Continue with the administrator account.', '登录已过期，请重新登录。': 'Session expired. Please sign in again.',
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
    };
    const reverse = Object.fromEntries(Object.entries(translations).map(([zh, en]) => [en, zh]));
    let language = localStorage.getItem('codex-auth-switcher-language') || 'en';
    function translateText(value) {
        if (typeof value !== 'string' || language === 'zh') return value;
        const leading = value.match(/^\s*/)?.[0] || '', trailing = value.match(/\s*$/)?.[0] || '', core = value.trim();
        if (translations[core]) return leading + translations[core] + trailing;
        return leading + core.replace(/刷新 (\S+)/g, 'Refresh $1').replace(/(\d+)% 剩余/g, '$1% remaining')
            .replace(/已更新 /g, 'Updated ').replace(/保存/g, 'saved').replace(/账号/g, 'account')
            .replace(/出口：/g, 'Account: ').replace(/局域网 Base URL：/g, 'LAN base URL: ')
            .replace(/仅本机访问：/g, 'Local access only: ').replace(/局域网访问：/g, 'LAN access: ')
            .replace(/代理错误：/g, 'Proxy error: ').replace(/正在验证 /g, 'Verifying ')
            .replace(/正在写入 /g, 'Writing ').replace(/请重启 Codex/g, 'Please restart Codex')
            .replace(/查询额度中…/g, 'Checking usage…').replace(/暂无请求记录。/g, 'No request logs.')
            .replace(/请求记录读取失败：/g, 'Failed to read request logs: ') + trailing;
    }
    function apply() {
        document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
        for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = translateText(node.dataset.i18n);
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes) { if (node.parentElement?.closest('script,style')) continue; const original = node.nodeValue; const translated = translateText(language === 'en' ? original : (reverse[original] || original)); if (translated !== original) node.nodeValue = translated; }
        const button = document.querySelector('#language-toggle'); if (button) button.textContent = language === 'en' ? '中文' : 'English';
    }
    function toggle() { language = language === 'en' ? 'zh' : 'en'; localStorage.setItem('codex-auth-switcher-language', language); location.reload(); }
    window.i18n = Object.freeze({ get language() { return language; }, t: translateText, apply, toggle });
    document.addEventListener('DOMContentLoaded', () => {
        apply(); document.querySelector('#language-toggle')?.addEventListener('click', toggle);
    });
})();
