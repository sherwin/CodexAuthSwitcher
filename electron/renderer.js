const api = window.authSwitcher;
const accounts = document.querySelector('#accounts');
const usage = new Map();
const accountRefreshes = new Map();
let items = [];
let health;
let busy = false;
let curlMode;
let networkDirty = false;
let networkBusy = false;
let addressSignature;
let statisticsData;
let statisticsVisible = false;
let statisticsLoading = false;
let statisticsPeriod = 'day';
let notificationTimer;
let lastHealthError;
let codexMode;
let observedCodexMode;

function renderCodexMode() {
    const mode = codexMode || 'unconfigured';
    for (const button of document.querySelectorAll('#codex-modes button')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    document.querySelector('#mode-empty').hidden = mode !== 'unconfigured';
    document.querySelector('#mode-key').hidden = mode !== 'key';
    document.querySelector('#mode-auth-file').hidden = mode !== 'auth_file';
    document.querySelector('#unconfigure').disabled = busy || health?.codex_mode === 'unconfigured';
}

function selectWorkspace(tab) {
    for (const button of document.querySelectorAll('#workspace-tabs button')) {
        const active = button.id === 'tab-' + tab;
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
    }
    document.querySelector('#proxy-page').hidden = tab !== 'proxy';
    document.querySelector('#codex-page').hidden = tab !== 'codex';
    document.querySelector('#open-statistics').hidden = tab !== 'proxy';
}

const number = value => Number(value || 0).toLocaleString('zh-CN');
function tokenNumber(value) {
    const count = Number(value || 0);
    if (!Number.isFinite(count) || count < 0) return '0';
    const units = [{ divisor: 1e9, suffix: 'B' }, { divisor: 1e6, suffix: 'M' }, { divisor: 1e3, suffix: 'K' }];
    const unit = units.find(item => count >= item.divisor ||
        (count >= item.divisor / 1000 && Number((count / item.divisor * 1000).toFixed(2)) >= 1000));
    return unit ? Number((count / unit.divisor).toFixed(2)).toLocaleString('en-US') + unit.suffix : number(count);
}
function renderStatistics() {
    if (!statisticsData) return;
    const period = statisticsPeriod;
    for (const button of document.querySelectorAll('#statistics-period button')) button.setAttribute('aria-pressed', String(button.dataset.period === period));
    const data = statisticsData.periods[period];
    const files = statisticsData.files || [];
    const historical = new Map(Object.values(statisticsData.periods).flatMap(item => item.accounts).map(item => [item.id, item]));
    const available = new Map(files.map(file => ['file:' + file.name, file]));
    for (const account of historical.values()) {
        if (!files.some(file => file.id === account.id)) available.set('history:' + account.id, { ...account, name: account.name + '（历史）' });
    }
    const select = document.querySelector('#statistics-account');
    const previous = select.value;
    select.replaceChildren();
    const all = element('option', '', '全部账号'); all.value = 'all'; select.append(all);
    for (const [value, account] of available) { const option = element('option', '', account.name); option.value = value; select.append(option); }
    select.value = available.has(previous) ? previous : 'all';
    const selected = document.querySelector('#statistics-account').value;
    const current = new Map(data.accounts.map(account => [account.id, account]));
    for (const file of files) {
        if (!current.has(file.id)) current.set(file.id, { ...file, buckets: data.buckets.map(() => 0) });
    }
    const filter = available.get(selected);
    const rows = selected === 'all' ? [...current.values()] : [{ ...(current.get(filter.id) || filter), name: filter.name }];
    const totals = selected === 'all' ? data.totals : rows[0];
    document.querySelector('#statistics-title').textContent = `${{ day: '今日', week: '本周', month: '本月' }[period]} Token 用量`;
    document.querySelector('#statistics-day').textContent = `${data.start === data.end ? data.start : data.start + ' 至 ' + data.end} · 北京时间 · 周一开始 / 自然月 · 数据保存在本机`;
    const summary = document.querySelector('#statistics-summary');
    summary.replaceChildren(metric('总 Token', tokenNumber(totals?.total_tokens), '已收到上游用量', 'good'),
        metric('输入 Token', tokenNumber(totals?.input_tokens), `其中缓存 ${tokenNumber(totals?.cached_tokens)}`),
        metric('输出 Token', tokenNumber(totals?.output_tokens), `其中推理 ${tokenNumber(totals?.reasoning_tokens)}`),
        metric('请求次数', number(totals?.requests), `已知用量 ${number(totals?.measured_requests)} 次`));
    [totals?.total_tokens, totals?.input_tokens, totals?.output_tokens].forEach((count, index) => {
        summary.children[index].title = `${number(count)} Token`;
    });
    document.querySelector('#statistics-coverage').textContent = totals?.unknown_requests
        ? `${number(totals.unknown_requests)} 次请求未收到完整用量（中断、失败或上游未提供），总 Token 可能低于实际消耗。`
        : '无未知用量请求。未经过本地代理的调用不在统计范围内。';
    const chart = document.querySelector('#statistics-hours');
    chart.replaceChildren();
    document.querySelector('#statistics-chart-title').textContent = period === 'day' ? '每小时 Token' : '每日 Token';
    const hours = totals?.buckets || data.buckets.map(() => 0);
    const max = Math.max(1, ...hours);
    chart.setAttribute('aria-label', hours.map((count, index) => `${data.buckets[index]} ${period === 'day' ? '点' : ''} ${number(count)} Token`).join('，'));
    for (let hour = 0; hour < hours.length; hour++) {
        const column = element('div', 'hour-column');
        column.title = `${period === 'day' ? hour + ':00–' + hour + ':59' : data.buckets[hour]} · ${tokenNumber(hours[hour])} Token（${number(hours[hour])}）`;
        const meter = element('meter', 'hour-meter');
        meter.min = 0; meter.max = max; meter.value = hours[hour];
        meter.setAttribute('aria-label', column.title);
        column.append(meter, element('span', 'hour-label', period === 'day' ? data.buckets[hour] : data.buckets[hour].slice(-2)));
        chart.append(column);
    }
    const table = document.querySelector('#statistics-rows');
    table.replaceChildren();
    for (const account of rows) {
        const row = element('tr');
        for (const text of [account.name, tokenNumber(account.input_tokens), tokenNumber(account.output_tokens),
            tokenNumber(account.total_tokens), number(account.requests), number(account.unknown_requests)]) row.append(element('td', '', text));
        [account.input_tokens, account.output_tokens, account.total_tokens].forEach((count, index) => {
            row.children[index + 1].title = `${number(count)} Token`;
        });
        row.title = account.aliases?.join(' · ') || account.name;
        table.append(row);
    }
    if (!rows.length) { const row = element('tr'); const cell = element('td', 'muted', '所选周期和账号没有经过代理的请求。'); cell.colSpan = 6; row.append(cell); table.append(row); }
}

async function refreshStatistics() {
    if (statisticsLoading) return;
    statisticsLoading = true;
    const button = document.querySelector('#refresh-statistics');
    button.disabled = true;
    try {
        statisticsData = await call('statistics');
        renderStatistics();
        document.querySelector('#statistics-status').textContent = '统计已更新，每 10 秒自动刷新。';
    } catch (error) { document.querySelector('#statistics-status').textContent = `统计读取失败：${error.message}。显示数据可能不是最新。`; }
    finally { statisticsLoading = false; button.disabled = false; }
}

async function updateCurl() {
    if (health?.lan_enabled && !health.lan_addresses?.length) {
        document.querySelector('#curl-preview').textContent = '未发现局域网 IPv4 地址，请检查网络连接。';
        document.querySelector('#copy-curl').disabled = true;
        return;
    }
    document.querySelector('#copy-curl').disabled = false;
    document.querySelector('#curl-preview').textContent = await api.curlCommand('preview', document.querySelector('#curl-target').value,
        document.querySelector('#curl-stream').value === 'true');
}

function message(text, error = false) {
    const element = document.querySelector('#message');
    element.textContent = text;
    element.classList.toggle('error', error);
    const notification = document.querySelector('#notification');
    notification.classList.toggle('error', error);
    notification.hidden = false;
    clearTimeout(notificationTimer);
    notificationTimer = setTimeout(() => { notification.hidden = true; }, error ? 10000 : 5000);
}

async function call(action, input) {
    const result = await api.call(action, input);
    if (!result.ok) throw new Error(`${result.error}${result.code ? ` (${result.code})` : ''}`);
    return result.result;
}

function date(value, time = true) {
    if (!value) return '时间不可用';
    const parsed = new Date(typeof value === 'number' ? value * 1000 : value);
    return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN', time ?
        { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } :
        { year: 'numeric', month: '2-digit', day: '2-digit' }) : '时间不可用';
}

function expiryColor(value) {
    if (!value) return '';
    const days = (new Date(typeof value === 'number' ? value * 1000 : value) - Date.now()) / 86400000;
    return days < 7 ? 'danger' : days < 30 ? 'warning' : 'good';
}

function resetColor(value) {
    if (!value) return '';
    const hours = (value * 1000 - Date.now()) / 3600000;
    return hours <= 0 ? '' : hours <= 24 ? 'good' : hours <= 168 ? 'warning' : 'danger';
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function metric(title, value, detail, valueColor = '', detailColor = '') {
    const node = element('div', 'metric');
    node.append(element('div', 'metric-label', title), element('div', `metric-value ${valueColor}`, value),
        element('div', `metric-detail ${detailColor}`, detail));
    return node;
}

function windowMetric(title, window) {
    const raw = window?.used_percent ?? window?.usedPercent;
    const remaining = Number.isFinite(raw) ? Math.round(Math.max(0, Math.min(100, 100 - raw))) : null;
    const reset = window?.reset_at ?? window?.resetsAt;
    return metric(title, remaining === null ? '—' : `${remaining}% 剩余`,
        reset ? `刷新 ${date(reset)}` : '刷新时间不可用', remaining === null ? '' : remaining <= 20 ? 'danger' : remaining <= 50 ? 'warning' : 'good', resetColor(reset));
}

function render() {
    renderAccounts(accounts, false);
    renderAccounts(document.querySelector('#codex-accounts'), true);
}

function renderAccounts(target, direct) {
    target.replaceChildren();
    if (!items.length) { target.append(element('p', 'muted', '此目录没有 JSON 授权文件，请选择授权目录。')); return; }
    for (const item of items) {
        const cached = usage.get(item.name);
        const data = cached?.data;
        const limits = data?.rate_limit || data?.rateLimitsByLimitId?.codex || data?.rateLimits;
        const active = direct ? health?.codex_mode === 'auth_file' && health.codex_auth_file === item.name : health?.selected_file === item.name;
        const card = element('section', `card ${active ? 'active' : ''}`);
        const header = element('div', 'card-header');
        const label = element('div');
        label.append(element('span', 'account-name', item.name));
        if (active) label.append(element('span', 'badge', direct ? 'Codex 直连' : '代理出口'));
        if (data?.plan_type) label.append(element('span', 'plan', data.plan_type));
        const select = element('button', active ? '' : 'primary', active ? '当前账号' : '切换到此账号');
        select.disabled = active || busy;
        select.addEventListener('click', () => direct ? switchCodexAccount(item.name) : switchAccount(item.name));
        const refreshButton = element('button', '', accountRefreshes.has(item.name) ? '刷新中…' : '刷新');
        refreshButton.disabled = accountRefreshes.has(item.name) || networkBusy;
        refreshButton.title = `刷新 ${item.name} 的额度和状态`;
        refreshButton.addEventListener('click', () => refreshAccount(item.name));
        const actions = element('div', 'actions');
        actions.append(refreshButton, select);
        header.append(label, actions);
        const metrics = element('div', 'metrics');
        const credits = data?.rate_limit_reset_credits || data?.rateLimitResetCredits;
        const available = Array.isArray(credits?.credits) ? credits.credits.filter(item => item?.status === 'available') : [];
        const expiration = nearestResetCreditExpiry(available);
        const creditCount = credits?.available_count ?? credits?.availableCount ?? available.length;
        const membership = subscriptionPresentation(cached);
        metrics.append(windowMetric('5 小时额度', limits?.primary_window || limits?.primary),
            windowMetric('周额度', limits?.secondary_window || limits?.secondary),
            metric('重置卡', data ? String(creditCount) : '—',
                expiration ? `最近过期时间 ${date(expiration)}` : !data ? '最近过期时间：查询中…'
                    : creditCount === 0 ? '暂无可用重置卡' : '最近过期时间：未提供', '', expiryColor(expiration)),
            metric('会员到期', membership.value, membership.detail, membership.tone));
        card.append(header, metrics, element('p', `card-status ${cached?.error ? 'error' : ''}`,
            cached?.error || (cached ? `已更新 ${date(cached.fetchedAt)} · ${date(item.modifiedAt)} 保存` : '查询额度中…')));
        const tokenStatus = element('p', 'card-status');
        tokenStatus.append(element('span', expiryColor(cached?.tokenExpiresAt || item.tokenExpiresAt),
            '授权令牌到期 ' + date(cached?.tokenExpiresAt || item.tokenExpiresAt)),
            element('span', '', ' · 与会员到期无关'));
        card.append(tokenStatus);
        target.append(card);
    }
}

function nearestResetCreditExpiry(available) {
    let nearest = Infinity;
    for (const credit of available) {
        let value = credit.expires_at ?? credit.expiresAt;
        if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) value = Number(value);
        if (typeof value !== 'number' && typeof value !== 'string') continue;
        const time = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
        if (time > 0 && Number.isFinite(new Date(time).getTime())) nearest = Math.min(nearest, time);
    }
    return nearest < Infinity ? new Date(nearest).toISOString() : null;
}

function subscriptionPresentation(cached) {
    if (!cached) return { value: '查询中…', detail: '随额度一起刷新', tone: '' };
    const subscription = cached.subscription;
    const expiry = subscription?.expiresAt || subscription?.cancelsAt || cached.subscriptionExpiry;
    if (subscription?.status === 'failed') return { value: '查询失败',
        detail: `点击「刷新额度」重试（${subscription.error || 'subscription_query_failed'}）`, tone: 'warning' };
    if (!expiry && !subscription?.renewsAt) return { value: cached.error ? '查询失败' : '未提供',
        detail: cached.error ? '授权或额度查询失败，请刷新重试' : '上游未返回此账号的会员日期', tone: cached.error ? 'warning' : '' };
    const details = [];
    if (subscription?.gracePeriodEndsAt) details.push('宽限至 ' + date(subscription.gracePeriodEndsAt));
    else if (subscription?.active === false) details.push('订阅未激活');
    else if (expiry && new Date(expiry).getTime() < Date.now() && subscription?.active === true)
        details.push('账期已到，会员仍有效（以上游为准）');
    if (subscription?.renewsAt) details.push('续费 ' + date(subscription.renewsAt));
    if (!expiry) details.unshift('未提供到期时间');
    return { value: expiry ? date(expiry, false) : '未提供', detail: details.join(' · ') || '会员有效期 · 随额度刷新',
        tone: expiryColor(expiry) };
}

function keyConnectionPresentation(connection) {
    if (connection?.status === 'config_mismatch') return { tone: 'danger', label: '修复 Key 配置',
        text: 'Key 配置未匹配：Codex 配置被改动或无法读取。点击「修复 Key 配置」，保留其他设置并重新写入代理地址和 Key。' };
    if (connection?.status === 'verified') return { tone: 'good', label: 'Key 连接已验证',
        text: 'Key 已接入：本次代理启动后已收到本机 Codex 客户端请求。用量按代理出口账号统计；之后切换出口无需重启 Codex。' };
    return { tone: 'warning', label: '重新应用 Key 配置',
        text: 'Key 配置已覆盖新旧会话的连接标识 · 等待 Codex 请求验证。请完全退出并重开 Codex，然后在原会话发送消息验证；无需新建会话。之后切换代理出口无需重启。' };
}

async function updateHealth() {
    try {
        health = await call('status');
        document.querySelector('#dot').classList.add('running');
        document.querySelector('#gateway-status').textContent = '本地代理运行中';
        const displayHost = health.lan_enabled ? health.lan_addresses?.[0] : '127.0.0.1';
        document.querySelector('#gateway-detail').textContent = `${displayHost ? `${displayHost}:${health.port}` : '未发现局域网 IP'} · 出口：${health.selected_file || '未选择'}`;
        const connection = keyConnectionPresentation(health.codex_connection);
        document.querySelector('#configure').disabled = busy;
        document.querySelector('#configure').textContent = '应用 Key 模式';
        document.querySelector('#setup-note').className = 'notice' + (health.codex_mode === 'key' ? ' ' + connection.tone : '');
        document.querySelector('#setup-note').textContent = health.codex_mode === 'key'
            ? connection.text
            : health.codex_mode === 'auth_file' ? `Codex 当前配置：授权文件直连 · ${health.codex_auth_file || '未记录账号'}。更新授权后需重启 Codex；代理仍独立运行。`
                : '尚未由工具配置 Codex。可选择 Key 接入代理，或授权文件直连；两者都不会关闭本地代理。配置后需重启 Codex。';
        if (observedCodexMode !== health.codex_mode) {
            observedCodexMode = health.codex_mode;
            codexMode = health.codex_mode;
        }
        renderCodexMode();
        if (!networkDirty && !networkBusy) {
            document.querySelector('#lan-enabled').checked = health.lan_enabled;
            document.querySelector('#proxy-port').value = health.port;
        }
        const addresses = health.lan_enabled ? health.lan_addresses : [];
        document.querySelector('#network-addresses').textContent = health.lan_enabled
            ? addresses.length ? '局域网 Base URL：' + addresses.map(ip => `http://${ip}:${health.port}/v1`).join(' · ')
                : '局域网已开启，但未发现私有 IPv4 地址，请检查网络连接。'
            : `仅本机访问：http://127.0.0.1:${health.port}/v1`;
        const signature = JSON.stringify([health.port, health.lan_enabled, addresses]);
        if (addressSignature !== signature) {
            const target = document.querySelector('#curl-target');
            const previous = target.value;
            target.replaceChildren();
            if (health.lan_enabled) {
                for (const ip of addresses) { const option = element('option', '', `局域网 ${ip}`); option.value = ip; target.append(option); }
                target.disabled = !addresses.length;
                target.value = addresses.includes(previous) ? previous : addresses[0] || '';
            } else {
                const option = element('option', '', '本机'); option.value = '127.0.0.1'; target.append(option);
                target.value = '127.0.0.1';
                target.disabled = false;
            }
            addressSignature = signature;
        }
        if (curlMode !== signature) {
            await updateCurl();
            curlMode = signature;
        }
        document.querySelector('#gateway-status').title = health.in_flight ? `${health.in_flight} 个请求进行中` : '代理空闲';
        const errorSignature = health.last_error ? JSON.stringify([health.last_error.code, health.last_error.account, health.last_error.at]) : null;
        if (errorSignature && errorSignature !== lastHealthError) message(`代理错误：${health.last_error.code} · ${health.last_error.account || ''}`, true);
        lastHealthError = errorSignature;
    } catch (error) {
        document.querySelector('#dot').classList.remove('running');
        document.querySelector('#gateway-status').textContent = '本地代理不可用';
        const errorSignature = `connection:${error.message}`;
        if (lastHealthError !== errorSignature) message(error.message, true);
        lastHealthError = errorSignature;
    }
}

function refreshAccount(name) {
    if (accountRefreshes.has(name)) return accountRefreshes.get(name);
    const directory = document.querySelector('#directory-path').textContent;
    const pending = Promise.resolve().then(async () => {
        try {
            const result = await call('usage', { name });
            if (document.querySelector('#directory-path').textContent === directory) usage.set(name, result);
        } catch (error) {
            if (document.querySelector('#directory-path').textContent === directory)
                usage.set(name, { ...usage.get(name), error: error.message });
        } finally {
            accountRefreshes.delete(name);
            render();
        }
    });
    accountRefreshes.set(name, pending);
    render();
    return pending;
}

async function refresh() {
    document.querySelector('#refresh').disabled = true;
    try {
        await updateHealth();
        const result = await call('accounts');
        items = result.accounts;
        document.querySelector('#directory-path').textContent = result.authDirectory;
        document.querySelector('#codex-directory-path').textContent = result.authDirectory;
        render();
        await Promise.all(items.map(item => refreshAccount(item.name)));
    } catch (error) { message(error.message, true); }
    finally { document.querySelector('#refresh').disabled = false; }
}

async function switchAccount(name) {
    busy = true;
    render();
    message(`正在验证 ${name}…`);
    try {
        await call('select', { name });
        await updateHealth();
        message(`代理出口已切换到 ${name}，新请求立即生效；Codex 直连授权未改变。`);
    } catch (error) { message(error.message, true); }
    finally { busy = false; render(); }
}

document.querySelector('#refresh').addEventListener('click', refresh);
document.querySelector('#workspace-tabs').addEventListener('click', event => {
    const button = event.target.closest('button[role=tab]');
    if (button) selectWorkspace(button.id === 'tab-proxy' ? 'proxy' : 'codex');
});
document.querySelector('#workspace-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tab = event.key === 'Home' ? 'proxy' : event.key === 'End' ? 'codex' : event.target.id === 'tab-proxy' ? 'codex' : 'proxy';
    selectWorkspace(tab);
    document.querySelector('#tab-' + tab).focus();
});
document.querySelector('#codex-modes').addEventListener('click', event => {
    const button = event.target.closest('button[data-mode]');
    if (!button || busy) return;
    codexMode = button.dataset.mode;
    renderCodexMode();
});
document.querySelector('#unconfigure').addEventListener('click', async () => {
    busy = true;
    renderCodexMode();
    try {
        await call('unconfigure');
        await updateHealth();
        message('已设为空；Codex 现有配置和授权未改写，本地代理继续运行。');
    } catch (error) { message(error.message, true); }
    finally { busy = false; renderCodexMode(); render(); }
});
document.querySelector('#configure').addEventListener('click', async () => {
    busy = true;
    render();
    document.querySelector('#configure').disabled = true;
    try {
        await call('configure');
        await updateHealth();
        message('Key 配置已覆盖新旧会话。请完全退出并重开 Codex，在原会话发送消息验证；聊天记录不变。');
    } catch (error) { message(error.message, true); }
    finally { busy = false; await updateHealth(); render(); }
});
async function switchCodexAccount(name) {
    busy = true;
    render();
    message(`正在写入 ${name} 的 Codex 授权文件…`);
    try {
        await call('authFile', { name });
        await updateHealth();
        message(`Codex 已切换到 ${name}，请重启 Codex；代理出口未改变。`);
    } catch (error) { message(error.message, true); }
    finally { busy = false; await updateHealth(); render(); }
}
async function chooseDirectory() {
    try { if (await api.chooseDirectory()) { usage.clear(); await refresh(); } }
    catch (error) { message(error.message, true); }
}
document.querySelector('#directory').addEventListener('click', chooseDirectory);
document.querySelector('#codex-directory').addEventListener('click', chooseDirectory);
document.querySelector('#copy-curl').addEventListener('click', async () => {
    const button = document.querySelector('#copy-curl');
    const status = document.querySelector('#curl-copy-status');
    button.disabled = true;
    try { status.textContent = await api.curlCommand('copy', document.querySelector('#curl-target').value,
        document.querySelector('#curl-stream').value === 'true') ? '已复制，可粘贴到对应电脑终端。' : '已取消复制。'; }
    catch { status.textContent = '复制失败，请确认本地代理运行、所选地址可用。'; }
    finally { button.disabled = false; }
});
for (const id of ['curl-target', 'curl-stream']) document.querySelector('#' + id).addEventListener('change', () => updateCurl().catch(() => {
    document.querySelector('#curl-preview').textContent = '地址已变化，请刷新后重试。';
}));
for (const id of ['lan-enabled', 'proxy-port']) document.querySelector('#' + id).addEventListener('input', () => { networkDirty = true; });
document.querySelector('#apply-network').addEventListener('click', async () => {
    networkBusy = true;
    const button = document.querySelector('#apply-network');
    const status = document.querySelector('#network-status');
    button.disabled = true;
    try {
        const result = await api.networkSettings({ lan_enabled: document.querySelector('#lan-enabled').checked,
            port: Number(document.querySelector('#proxy-port').value) });
        networkDirty = false;
        status.textContent = result.canceled ? '已取消。' : result.configChanged
            ? '已应用并更新 Codex Base URL，请重启 Codex。' : '网络设置已应用。';
    } catch (error) { status.textContent = error.message; }
    finally { networkBusy = false; button.disabled = false; await updateHealth(); }
});
setInterval(updateHealth, 3000);
document.querySelector('#open-statistics').addEventListener('click', () => {
    statisticsVisible = true;
    document.querySelector('#home-page').hidden = true;
    document.querySelector('#statistics-page').hidden = false;
    refreshStatistics();
});
document.querySelector('#back-home').addEventListener('click', () => {
    statisticsVisible = false;
    document.querySelector('#home-page').hidden = false;
    document.querySelector('#statistics-page').hidden = true;
});
document.querySelector('#refresh-statistics').addEventListener('click', refreshStatistics);
document.querySelector('#statistics-account').addEventListener('change', renderStatistics);
document.querySelector('#statistics-period').addEventListener('click', event => {
    const button = event.target.closest('button[data-period]');
    if (!button) return;
    statisticsPeriod = button.dataset.period;
    renderStatistics();
});
document.querySelector('#statistics-period').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...document.querySelectorAll('#statistics-period button')];
    const index = buttons.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
    buttons[next].click();
});
document.querySelector('#dismiss-notification').addEventListener('click', () => {
    clearTimeout(notificationTimer);
    document.querySelector('#notification').hidden = true;
});
setInterval(() => { if (statisticsVisible) refreshStatistics(); }, 10000);
refresh();
