const api = window.authSwitcher;
const tr = text => typeof window !== 'undefined' && window.i18n?.t ? window.i18n.t(text) : text;
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
let statisticsPeriod = 'natural-day';
let statisticsCustomRange = null;
const statisticsPeriodConfig = {
    hour: '近 1 小时', 'natural-day': '近 1 自然日', 'ten-minutes': '近 10 分钟',
    week: '近一周', month: '近一个月', year: '过去一年', custom: '自定义'
};
let statisticsRequest = 0;
let notificationTimer;
let lastHealthError;
let codexMode;
let observedCodexMode;
let editingDeepSeek = false;
let savingDeepSeek = false;
let requestLogs = [], requestLogsPage = 1, requestLogsTotalPages = 1, requestLogsTotal = 0, requestLogsFilter = 'all', requestLogsLoading = false;
let priorityData = { priority: { enabled: true }, entries: [] };

function renderCapacityRetrySettings(settings = health?.capacity_retry || { enabled: true, min_seconds: 1, max_seconds: 5, max_retries: 5 }) {
    document.querySelector('#capacity-retry-enabled').checked = settings.enabled !== false;
    document.querySelector('#capacity-retry-min').value = settings.min_seconds;
    document.querySelector('#capacity-retry-max').value = settings.max_seconds;
    document.querySelector('#capacity-retry-max-retries').value = settings.max_retries;
}
async function savePriorityBoard(enabledZone, disabledZone, status) {
    const order = [...enabledZone.querySelectorAll('.account-card'), ...disabledZone.querySelectorAll('.account-card')].map(row => row.dataset.name);
    const disabled = [...disabledZone.querySelectorAll('.account-card')].map(row => row.dataset.name);
    try { status.textContent = tr('保存中…'); const result = await call('priority', { priority: { enabled: order.length > disabled.length, order, disabled } }); priorityData.priority = result.priority; priorityData.entries = order.map(name => ({ name, enabled: !disabled.includes(name) })); status.textContent = tr('已保存'); setTimeout(() => { if (status.textContent === tr('已保存')) status.textContent = ''; }, 1800); }
    catch (error) { status.textContent = tr(`保存失败：${error.message}`); }
}
function renderRequestLogs() {
    const target = document.querySelector('#request-logs-list'); target.replaceChildren();
    document.querySelector('#request-logs-page-label').textContent = tr(`第 ${requestLogsPage} / ${requestLogsTotalPages} 页 · 共 ${requestLogsTotal} 条`);
    document.querySelector('#request-logs-prev').disabled = requestLogsPage <= 1; document.querySelector('#request-logs-next').disabled = requestLogsPage >= requestLogsTotalPages;
    document.querySelector('#request-logs-go').disabled = requestLogsLoading;
    for (const item of requestLogs) { const button = element('button', `request-log-row ${item.success ? 'success' : 'failure'}`); button.type = 'button'; button.append(element('strong', '', `${item.method} ${item.path} · ${item.model || '模型未知'}`), element('span', '', `${requestLogTime(item.startedAt)} · HTTP ${item.status || '—'} · ${requestDuration(item.durationMs)} · 尝试 ${item.attemptCount || 1}${item.errorCode ? ` · ${item.errorCode}` : ''}`)); button.onclick = () => showRequestLog(item.id); target.append(button); }
    if (!requestLogs.length) target.append(element('p', 'muted', '暂无请求记录。'));
}
async function refreshRequestLogs(page = requestLogsPage) {
    if (requestLogsLoading) return;
    const target = document.querySelector('#request-logs-list');
    requestLogsLoading = true;
    target.replaceChildren(...Array.from({ length: 8 }, () => element('div', 'request-log-skeleton')));
    document.querySelector('#request-logs-prev').disabled = true;
    document.querySelector('#request-logs-next').disabled = true;
    document.querySelector('#request-logs-go').disabled = true;
    try {
        const result = await call('requestLogs', { page, filter: requestLogsFilter });
        requestLogs = result.logs || []; requestLogsPage = result.page || 1;
        requestLogsTotalPages = result.totalPages || 1; requestLogsTotal = result.total || 0;
        renderRequestLogs();
    } catch (error) { target.replaceChildren(element('p', 'card-status error', error.message)); }
    finally { requestLogsLoading = false; renderRequestLogs(); }
}
async function showRequestLog(id) { const detail = document.querySelector('#request-log-detail'); detail.setAttribute('aria-busy', 'true'); document.querySelector('#request-log-detail-title').textContent = tr('读取记录…'); document.querySelector('#request-log-request-body').textContent = tr('读取中…'); document.querySelector('#request-log-response-body').textContent = tr('读取中…'); try { const item = await call('requestLog', { id }); let events = item.errorEvents; try { events = JSON.parse(item.errorEvents || '[]'); } catch {} document.querySelector('#request-log-detail-title').textContent = tr(`记录 #${item.id} · ${item.method} ${item.path}`); document.querySelector('#request-log-detail-meta').textContent = tr(`${requestLogTime(item.startedAt)} · 模型 ${item.model || '未知'} · HTTP ${item.status || '—'} · ${requestDuration(item.durationMs)} · 尝试 ${item.attemptCount || 1} · ${item.success ? '成功' : '失败'}${item.errorCode ? ` · ${item.errorCode}` : ''}${item.errorMessage ? ` · ${item.errorMessage}` : ''} · 错误事件 ${events.length}`); document.querySelector('#request-log-request-body').textContent = item.requestBody || '(空)'; document.querySelector('#request-log-response-body').textContent = (events.length ? `尝试错误：\n${JSON.stringify(events, null, 2)}\n\n` : '') + (item.responseBody || '(空)'); } catch (error) { document.querySelector('#request-log-detail-meta').textContent = tr(error.message); } finally { detail.removeAttribute('aria-busy'); } }

function requestLogTime(value) {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return '时间不可用';
    return new Intl.DateTimeFormat(window.i18n?.language === 'zh' ? 'zh-CN' : 'en-US', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).format(parsed);
}
function requestDuration(value) {
    const seconds = Math.max(0, Number(value) || 0) / 1000;
    return `${seconds.toFixed(seconds < 10 ? 3 : 2).replace(/\.?(0+)$/, '')} s`;
}

function openDeepSeek(item) {
    const form = document.querySelector('#deepseek-form');
    form.reset();
    editingDeepSeek = Boolean(item);
    document.querySelector('#deepseek-title').textContent = item ? '编辑自定义 API 账号' : '添加自定义 API 账号';
    document.querySelector('#deepseek-name').value = item?.name || '';
    document.querySelector('#deepseek-name').disabled = Boolean(item);
    document.querySelector('#deepseek-url').value = item?.base_url || 'https://api.deepseek.com';
    document.querySelector('#deepseek-model').value = item?.fixed_model || '';
    document.querySelector('#deepseek-key').required = !item;
    document.querySelector('#deepseek-key').placeholder = item ? '留空保留已有 Key' : '输入 API Key';
    document.querySelector('#deepseek-status').textContent = '';
    document.querySelector('#deepseek-dialog').showModal();
}
async function applyApiAccountToCodex(item) {
    if (!confirm(`将 ${item.name} 的 Base URL 和 Key 应用为 Codex 直连地址？`)) return;
    try { await call('codexApi', { name: item.name }); await updateHealth(); message('已将该 API 账号应用为 Codex 直连地址，请重启 Codex。'); }
    catch (error) { message(error.message, true); }
}

document.querySelector('#add-deepseek').addEventListener('click', () => openDeepSeek());
document.querySelector('#cancel-deepseek').addEventListener('click', () => document.querySelector('#deepseek-dialog').close());
document.querySelector('#deepseek-dialog').addEventListener('cancel', event => { if (savingDeepSeek) event.preventDefault(); });
document.querySelector('#deepseek-dialog').addEventListener('close', () => { document.querySelector('#deepseek-key').value = ''; });
document.querySelector('#deepseek-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (savingDeepSeek) return;
    savingDeepSeek = true;
    document.querySelector('#save-deepseek').disabled = true;
    document.querySelector('#cancel-deepseek').disabled = true;
    const name = document.querySelector('#deepseek-name').value.trim();
    try {
        await call('deepseek', { name: name.endsWith('.json') ? name : name + '.json',
            base_url: document.querySelector('#deepseek-url').value.trim(),
            fixed_model: document.querySelector('#deepseek-model').value.trim(),
            api_key: document.querySelector('#deepseek-key').value, edit: editingDeepSeek });
        document.querySelector('#deepseek-dialog').close();
        await refresh();
        message('自定义 API 账号已保存，可作为代理出口或 Codex 直连地址。');
    } catch (error) { document.querySelector('#deepseek-status').textContent = error.message; }
    finally {
        savingDeepSeek = false;
        document.querySelector('#save-deepseek').disabled = false;
        document.querySelector('#cancel-deepseek').disabled = false;
    }
});

function renderCodexMode() {
    const mode = codexMode === 'custom' ? 'key' : (codexMode || 'unconfigured');
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
    document.querySelector('#cursor-page').hidden = tab !== 'cursor';
    document.querySelector('#open-statistics').hidden = tab !== 'proxy';
}

const number = value => Number(value || 0).toLocaleString(typeof window !== 'undefined' && window.i18n?.language === 'zh' ? 'zh-CN' : 'en-US');
function tokenNumber(value) {
    const count = Number(value || 0);
    if (!Number.isFinite(count) || count < 0) return '0';
    const units = [{ divisor: 1e9, suffix: 'B' }, { divisor: 1e6, suffix: 'M' }, { divisor: 1e3, suffix: 'K' }];
    const unit = units.find(item => count >= item.divisor ||
        (count >= item.divisor / 1000 && Number((count / item.divisor * 1000).toFixed(2)) >= 1000));
    return unit ? Number((count / unit.divisor).toFixed(2)).toLocaleString('en-US') + unit.suffix : number(count);
}
function statisticsColumn(label, count, max, caption) {
    const description = `${label} · ${tokenNumber(count)} Token（${number(count)}）`;
    const column = element('div', 'hour-column');
    column.tabIndex = 0;
    column.setAttribute('aria-label', description);
    const meter = element('meter', 'hour-meter');
    meter.min = 0; meter.max = max; meter.value = count;
    meter.setAttribute('aria-label', description);
    const tooltip = element('span', 'hour-tooltip', `${label}\n${tokenNumber(count)} Token\n${tr('精确用量')} ${number(count)}`);
    tooltip.setAttribute('aria-hidden', 'true');
    column.append(meter, element('span', 'hour-label', caption), tooltip);
    return column;
}
function renderStatistics() {
    if (!statisticsData) return;
    const data = statisticsData;
    const period = data.period;
    for (const button of document.querySelectorAll('#statistics-period button')) button.setAttribute('aria-pressed', String(button.dataset.period === statisticsPeriod));
    if (!data || !Array.isArray(data.accounts) || !data.totals) {
        document.querySelector('#statistics-status').textContent = tr('统计数据格式不完整，请刷新代理后重试。');
        return;
    }
    const files = statisticsData.files || [];
    const historical = new Map(data.accounts.map(item => [item.id, item]));
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
    document.querySelector('#statistics-title').textContent = `${tr(statisticsPeriodConfig[period])} · ${tr('Token 用量')}`;
    document.querySelector('#statistics-day').textContent = `${statisticsTime(data.start)} – ${statisticsTime(data.end)} · ${tr('北京时间 · 数据保存在本机')}`;
    const summary = document.querySelector('#statistics-summary');
    summary.replaceChildren(metric('总 Token', tokenNumber(totals?.total_tokens), '已收到上游用量', 'good'),
        metric('输入 Token', tokenNumber(totals?.input_tokens), `其中缓存 ${tokenNumber(totals?.cached_tokens)}`),
        metric('输出 Token', tokenNumber(totals?.output_tokens), `其中推理 ${tokenNumber(totals?.reasoning_tokens)}`),
        metric('请求次数', number(totals?.requests), `已知用量 ${number(totals?.measured_requests)} 次`));
    [totals?.total_tokens, totals?.input_tokens, totals?.output_tokens].forEach((count, index) => {
        summary.children[index].title = `${number(count)} Token`;
    });
    document.querySelector('#statistics-coverage').textContent = totals?.unknown_requests
        ? tr(`${number(totals.unknown_requests)} 次请求未收到完整用量（中断、失败或上游未提供），总 Token 可能低于实际消耗。`)
        : tr('无未知用量请求。未经过本地代理的调用不在统计范围内。');
    if (data.incomplete_history) document.querySelector('#statistics-coverage').textContent += ' ' + tr('部分旧记录只有整日汇总，无法计入局部时间范围；此范围的历史统计可能不完整。');
    hideStatisticsTooltip();
    const chart = document.querySelector('#statistics-hours');
    const heatmap = document.querySelector('#statistics-heatmap');
    chart.replaceChildren(); heatmap.replaceChildren();
    const values = totals?.buckets || data.buckets.map(() => 0);
    const annual = period === 'year' || (data.granularity === 'day' && values.length > 90);
    chart.hidden = annual; heatmap.hidden = !annual;
    document.querySelector('#statistics-chart-title').textContent = tr({ minute: '每分钟 Token', hour: '每小时 Token', day: '每日 Token' }[data.granularity]);
    const max = Math.max(1, ...values);
    const captions = data.buckets.map(bucket => statisticsTime(bucket, data.granularity === 'day' ? 'day' : 'time'));
    chart.setAttribute('aria-label', values.map((count, index) => `${statisticsTime(data.buckets[index])} · ${tokenNumber(count)} Token`).join(', '));
    values.forEach((count, index) => {
        const label = statisticsTime(data.buckets[index], data.granularity === 'day' ? 'day' : 'full');
        if (annual) {
            const cell = element('span', 'statistics-heatmap-cell');
            cell.dataset.level = count ? Math.min(4, Math.ceil(count / max * 4)) : 0;
            cell.tabIndex = 0;
            cell.setAttribute('aria-label', `${label} · ${tokenNumber(count)} Token（${number(count)}）`);
            cell.append(element('span', 'statistics-heatmap-tooltip', `${label}\n${tokenNumber(count)} Token\n${tr('精确用量')} ${number(count)}`));
            heatmap.append(cell);
        } else {
            // 标签稀疏展示，完整日期时间仍可通过即时提示和键盘聚焦读取。
            const caption = index % Math.max(1, Math.ceil(values.length / 12)) === 0 || index === values.length - 1 ? captions[index] : '';
            chart.append(statisticsColumn(label, count, max, caption));
        }
    });
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

function statisticsTime(value, format = 'full') {
    const locale = window.i18n?.language === 'zh' ? 'zh-CN' : 'en-US';
    return new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Shanghai', hourCycle: 'h23',
        ...(format !== 'time' ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}),
        ...(format !== 'day' ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(new Date(value));
}
async function refreshStatistics() {
    const request = ++statisticsRequest;
    const period = statisticsPeriod;
    statisticsLoading = true;
    hideStatisticsTooltip();
    const button = document.querySelector('#refresh-statistics');
    button.disabled = true;
    document.querySelector('#statistics-page').setAttribute('aria-busy', 'true');
    for (const tab of document.querySelectorAll('#statistics-period button')) tab.setAttribute('aria-pressed', String(tab.dataset.period === period));
    document.querySelector('#statistics-status').textContent = tr('正在加载统计…');
    try {
        const input = { period, ...(period === 'custom' ? statisticsCustomRange : {}) };
        const data = await call('statistics', input);
        // 快速切换时，仅最后一次请求可以更新界面。
        if (request !== statisticsRequest) return;
        if (data.period !== period || !data.granularity || !Array.isArray(data.buckets)) throw Error(tr('统计接口版本过旧，请重启代理服务。'));
        statisticsData = data;
        renderStatistics();
        document.querySelector('#statistics-status').textContent = tr('统计已更新，每 10 秒自动刷新。');
    } catch (error) {
        if (request === statisticsRequest) {
            if (statisticsData) statisticsPeriod = statisticsData.period;
            else statisticsPeriod = 'natural-day';
            for (const tab of document.querySelectorAll('#statistics-period button')) tab.setAttribute('aria-pressed', String(tab.dataset.period === statisticsPeriod));
            document.querySelector('#statistics-status').textContent = tr(`统计读取失败：${error.message}。显示数据可能不是最新。`);
        }
    } finally {
        if (request === statisticsRequest) {
            statisticsLoading = false; button.disabled = false;
            document.querySelector('#statistics-page').setAttribute('aria-busy', 'false');
        }
    }
}

// 提示挂在 body 上并使用固定定位，避免网格滚动容器裁切及滚动尺寸变化。
let statisticsTooltip;
let statisticsTooltipTarget;
function hideStatisticsTooltip() {
    if (statisticsTooltip) statisticsTooltip.hidden = true;
    statisticsTooltipTarget = null;
}
function showStatisticsTooltip(target) {
    const content = target.querySelector('.hour-tooltip,.statistics-heatmap-tooltip');
    if (!content) return;
    statisticsTooltipTarget = target;
    statisticsTooltip ||= document.body.appendChild(element('div', 'statistics-floating-tooltip'));
    statisticsTooltip.textContent = content.textContent;
    statisticsTooltip.hidden = false;
    const rect = target.getBoundingClientRect();
    const tip = statisticsTooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - tip.width / 2, window.innerWidth - tip.width - 8));
    const top = rect.top >= tip.height + 16 ? rect.top - tip.height - 8 : Math.min(rect.bottom + 8, window.innerHeight - tip.height - 8);
    statisticsTooltip.style.left = `${left}px`;
    statisticsTooltip.style.top = `${Math.max(8, top)}px`;
}

async function updateCurl() {
    if (health?.lan_enabled && !health.lan_addresses?.length) {
        document.querySelector('#curl-preview').textContent = tr('未发现局域网 IPv4 地址，请检查网络连接。');
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
    window.i18n?.apply();
}

async function call(action, input) {
    const result = await api.call(action, input);
    if (!result.ok) throw new Error(`${result.error}${result.code ? ` (${result.code})` : ''}`);
    return result.result;
}

function date(value, time = true) {
    if (!value) return '时间不可用';
    const parsed = new Date(typeof value === 'number' ? value * 1000 : value);
    return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString(typeof window !== 'undefined' && window.i18n?.language === 'zh' ? 'zh-CN' : 'en-US', time ?
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
    if (text !== undefined) node.textContent = window.i18n?.t(text) || text;
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
    const { scrollX, scrollY } = window;
    renderAccounts(accounts, false);
    renderAccounts(document.querySelector('#codex-accounts'), true);
    window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
    window.i18n?.apply();
}

function renderAccounts(target, direct) {
    const cards = [];
    if (!items.length) { target.replaceChildren(element('p', 'muted', '此目录没有 JSON 授权文件，请选择授权目录。')); return; }
    for (const item of items) {
        if (direct && item.provider === 'deepseek') continue;
        const cached = usage.get(item.name);
        const data = cached?.data;
        const limits = data?.rate_limit || data?.rateLimitsByLimitId?.codex || data?.rateLimits;
        const active = direct ? health?.codex_mode === 'auth_file' && health.codex_auth_file === item.name : health?.selected_file === item.name;
        const card = element('section', `card account-card ${active ? 'active' : ''}`);
        card.dataset.name = item.name;
        card.draggable = !direct;
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
        const identity = element('div', 'account-header-identity');
        identity.append(label);
        header.append(identity, actions);
        if (item.provider === 'deepseek') {
            label.append(element('span', 'plan', '自定义 API · Key'));
            const edit = element('button', '', '编辑配置');
            edit.disabled = busy;
            edit.addEventListener('click', () => openDeepSeek(item));
            const codex = element('button', '', '设为 Codex 地址');
            codex.disabled = busy;
            codex.addEventListener('click', () => applyApiAccountToCodex(item));
            actions.replaceChildren(edit, codex, select);
            card.append(header, element('p', 'muted path', item.base_url || 'Base URL 配置无效'),
                element('p', 'card-status', 'Responses / Chat Completions · API Key 已保存'),
                element('p', 'card-status', '可作为代理出口，也可设为 Codex 直连地址'));
            cards.push(card);
            continue;
        }
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
        const updateStatus = element('p', `card-status ${cached?.error ? 'error' : ''}`,
            cached?.error || (cached ? `已更新 ${date(cached.fetchedAt)} · ${date(item.modifiedAt)} 保存` : '查询额度中…')); 
        const tokenStatus = element('p', 'card-status');
        tokenStatus.append(element('span', expiryColor(cached?.tokenExpiresAt || item.tokenExpiresAt),
            '授权令牌到期 ' + date(cached?.tokenExpiresAt || item.tokenExpiresAt)),
            element('span', '', ' · 与会员到期无关'));
        card.append(header, metrics, updateStatus, tokenStatus);
        cards.push(card);
    }
    if (!cards.length) { target.replaceChildren(element('p', 'muted', direct ? '没有可用于 Codex 直连的 ChatGPT 授权文件。' : '此目录没有 JSON 授权文件，请选择授权目录。')); return; }
    if (direct) { target.replaceChildren(...cards); return; }
    const priorityEntries = Array.isArray(priorityData.entries) ? priorityData.entries : [];
    const disabledNames = new Set(priorityData.priority?.disabled || priorityEntries.filter(item => item.enabled === false).map(item => item.name));
    const enabledNames = new Set(cards.filter(card => !disabledNames.has(card.dataset.name)).map(card => card.dataset.name));
    const order = new Map(priorityEntries.map((item, index) => [item.name, index]));
    cards.sort((a, b) => (order.get(a.dataset.name) ?? 9999) - (order.get(b.dataset.name) ?? 9999));
    const status = element('span', 'muted');
    const heading = element('div', 'list-heading priority-inline-heading');
    heading.append(element('p', 'muted', '拖动账号头部的小方块调整优先级；松手时会放到预览线位置。上方参与自动切换，下方不参与。'), status);
    const enabledZone = element('div', 'priority-inline-zone');
    const disabledZone = element('div', 'priority-inline-zone');
    enabledZone.append(element('h3', '', '参与自动切换')); disabledZone.append(element('h3', '', '不参与自动切换'));
    const enabledDrop = element('div', 'priority-dropzone'); const disabledDrop = element('div', 'priority-dropzone');
    enabledDrop.dataset.emptyHint = '暂无账号，拖动账号到这里以参与自动切换。';
    disabledDrop.dataset.emptyHint = '暂无账号，拖动账号到这里以退出自动切换。';
    enabledZone.append(enabledDrop); disabledZone.append(disabledDrop);
    for (const card of cards) (enabledNames.has(card.dataset.name) ? enabledDrop : disabledDrop).append(card);
    const dragState = { card: null, preview: null };
    const clearDragPreview = () => {
        dragState.preview?.remove();
        dragState.preview = null;
        target.querySelectorAll('.priority-dropzone').forEach(zone => zone.classList.remove('drag-over'));
    };
    const cardsIn = (zone) => [...zone.querySelectorAll('.account-card')].filter(card => card !== dragState.card);
    const updateDragPreview = (zone, event) => {
        if (!dragState.card) return;
        const preview = dragState.preview || element('div', 'priority-drop-preview');
        preview.setAttribute('aria-hidden', 'true');
        dragState.preview = preview;
        const before = cardsIn(zone).find(card => event.clientY < card.getBoundingClientRect().top + card.offsetHeight / 2);
        zone.insertBefore(preview, before || null);
        zone.classList.add('drag-over');
    };
    const wire = (zone) => {
        zone.addEventListener('dragover', event => {
            if (!dragState.card) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            updateDragPreview(zone, event);
        });
        zone.addEventListener('dragleave', event => {
            if (event.relatedTarget && zone.contains(event.relatedTarget)) return;
            zone.classList.remove('drag-over');
        });
        zone.addEventListener('drop', event => {
            event.preventDefault();
            if (!dragState.card) return;
            updateDragPreview(zone, event);
            const card = dragState.card;
            if (dragState.preview?.parentElement === zone) zone.insertBefore(card, dragState.preview);
            else zone.append(card);
            clearDragPreview();
            savePriorityBoard(enabledDrop, disabledDrop, status);
        });
    };
    for (const card of cards) {
        card.draggable = false;
        const identity = card.querySelector('.account-header-identity');
        const dragHandle = element('button', 'priority-drag-handle', '⋮⋮');
        dragHandle.type = 'button';
        dragHandle.draggable = true;
        dragHandle.title = tr('拖动以调整账号优先级');
        dragHandle.setAttribute('aria-label', dragHandle.title);
        dragHandle.addEventListener('click', event => event.preventDefault());
        dragHandle.addEventListener('dragstart', event => {
            dragState.card = card;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', card.dataset.name);
            card.classList.add('dragging');
        });
        dragHandle.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            dragState.card = null;
            clearDragPreview();
        });
        identity?.prepend(dragHandle);
    }
    wire(enabledDrop, disabledDrop); wire(disabledDrop, enabledDrop);
    target.replaceChildren(heading, enabledZone, disabledZone);
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
        document.querySelector('#gateway-status').textContent = tr('本地代理运行中');
        const displayHost = health.lan_enabled ? health.lan_addresses?.[0] : '127.0.0.1';
        document.querySelector('#gateway-detail').textContent = tr(`${displayHost ? `${displayHost}:${health.port}` : '未发现局域网 IP'} · 出口：${health.selected_file || '未选择'}`);
        const connection = keyConnectionPresentation(health.codex_connection);
        document.querySelector('#configure').disabled = busy;
        document.querySelector('#configure').textContent = tr('应用 Key 模式');
        document.querySelector('#setup-note').className = 'notice' + (health.codex_mode === 'key' ? ' ' + connection.tone : '');
        document.querySelector('#setup-note').textContent = health.codex_mode === 'key'
            ? tr(connection.text)
            : health.codex_mode === 'custom' ? tr(`Codex 当前配置：局域网 Base URL · ${health.custom_base_url || '未记录地址'}。更新地址或 Key 后需重启 Codex。`)
            : health.codex_mode === 'auth_file' ? tr(`Codex 当前配置：授权文件直连 · ${health.codex_auth_file || '未记录账号'}。更新授权后需重启 Codex；代理仍独立运行。`)
                : tr('尚未由工具配置 Codex。可选择 Key 接入代理，或授权文件直连；两者都不会关闭本地代理。配置后需重启 Codex。');
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
            ? addresses.length ? tr('局域网 Base URL：') + addresses.map(ip => `http://${ip}:${health.port}/v1`).join(' · ')
                : tr('局域网已开启，但未发现私有 IPv4 地址，请检查网络连接。')
            : tr(`仅本机访问：http://127.0.0.1:${health.port}/v1`);
        const signature = JSON.stringify([health.port, health.lan_enabled, addresses, health.selected_provider]);
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
        document.querySelector('#gateway-status').title = tr(health.in_flight ? `${health.in_flight} 个请求进行中` : '代理空闲');
        const errorSignature = health.last_error ? JSON.stringify([health.last_error.code, health.last_error.account, health.last_error.at]) : null;
        if (errorSignature && errorSignature !== lastHealthError) message(`代理错误：${health.last_error.code} · ${health.last_error.account || ''}`, true);
        lastHealthError = errorSignature;
    } catch (error) {
        document.querySelector('#dot').classList.remove('running');
        document.querySelector('#gateway-status').textContent = tr('本地代理不可用');
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
        const [result, priority] = await Promise.all([call('accounts'), call('priority')]);
        items = result.accounts;
        priorityData = priority;
        document.querySelector('#directory-path').textContent = result.authDirectory;
        document.querySelector('#codex-directory-path').textContent = result.authDirectory;
        render();
        await Promise.all(items.filter(item => item.provider !== 'deepseek').map(item => refreshAccount(item.name)));
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
    if (button) selectWorkspace(button.id === 'tab-proxy' ? 'proxy' : button.id === 'tab-cursor' ? 'cursor' : 'codex');
});
document.querySelector('#workspace-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tab = event.key === 'Home' ? 'proxy' : event.key === 'End' ? 'cursor' : event.target.id === 'tab-proxy' ? 'codex' : event.target.id === 'tab-codex' ? 'cursor' : 'proxy';
    selectWorkspace(tab);
    document.querySelector('#tab-' + tab).focus();
});
document.querySelector('#codex-modes').addEventListener('click', event => {
    const button = event.target.closest('button[data-mode]');
    if (!button || busy) return;
    codexMode = button.dataset.mode;
    renderCodexMode();
});
async function configureCursor(action) {
    const status = document.querySelector('#cursor-status');
    const enable = document.querySelector('#cursor-enable');
    const disable = document.querySelector('#cursor-disable');
    enable.disabled = disable.disabled = true;
    status.textContent = action === 'enable' ? '正在备份并配置 Cursor…' : '正在恢复 Cursor 官方补全…';
    try {
        const result = await api.cursorConfigure(action);
        status.textContent = action === 'enable'
            ? `已启动内置 Cursor 接管：${result.baseUrl || '本地 MITM'}（CA：${result.ca?.state === 'ready' ? '已信任' : '待系统授权'}）。请重新打开 Cursor 读取代理。`
            : '已停止内置 Cursor 接管并恢复 Cursor 原有设置。';
    } catch (error) { status.textContent = `操作失败：${error.message}`; }
    finally { enable.disabled = disable.disabled = false; }
}
document.querySelector('#cursor-enable').addEventListener('click', () => configureCursor('enable'));
document.querySelector('#cursor-disable').addEventListener('click', () => configureCursor('disable'));
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
document.querySelector('#test-config').addEventListener('click', async () => {
    const button = document.querySelector('#test-config');
    const status = document.querySelector('#config-test-status');
    button.disabled = true; status.textContent = tr('正在检查 config.toml 和 auth.json…');
    try {
        const result = await call('configTest');
        status.textContent = result.ok ? tr('配置文件测试通过。') : tr('配置文件不匹配，请重新应用配置。');
        status.className = result.ok ? 'muted good' : 'muted danger';
    } catch (error) { status.textContent = tr(`配置文件测试失败：${error.message}`); status.className = 'muted danger'; }
    finally { button.disabled = false; }
});
document.querySelector('#open-settings').addEventListener('click', async () => { const result = await call('settings'); renderCapacityRetrySettings(result.capacity_retry); document.querySelector('#settings-dialog').showModal(); });
document.querySelector('#save-settings').addEventListener('click', async event => { event.preventDefault(); const status = document.querySelector('#settings-status'); try { const min = Number(document.querySelector('#capacity-retry-min').value), max = Number(document.querySelector('#capacity-retry-max').value), maxRetries = Number(document.querySelector('#capacity-retry-max-retries').value); const result = await call('settings', { capacity_retry: { enabled: document.querySelector('#capacity-retry-enabled').checked, min_seconds: min, max_seconds: max, max_retries: maxRetries } }); renderCapacityRetrySettings(result.capacity_retry); document.querySelector('#settings-dialog').close(); message('重试设置已保存。'); } catch (error) { status.textContent = error.message; } });
document.querySelector('#open-request-logs').addEventListener('click', () => { document.querySelector('#home-page').hidden = true; document.querySelector('#request-logs-page').hidden = false; refreshRequestLogs(1); });
document.querySelector('#back-from-logs').addEventListener('click', () => { document.querySelector('#request-logs-page').hidden = true; document.querySelector('#home-page').hidden = false; });
document.querySelector('#refresh-request-logs').addEventListener('click', () => refreshRequestLogs());
document.querySelector('#request-log-filter').addEventListener('change', event => { requestLogsFilter = event.target.value; requestLogsPage = 1; refreshRequestLogs(1); });
document.querySelector('#request-logs-prev').addEventListener('click', () => refreshRequestLogs(requestLogsPage - 1)); document.querySelector('#request-logs-next').addEventListener('click', () => refreshRequestLogs(requestLogsPage + 1)); document.querySelector('#request-logs-go').addEventListener('click', () => refreshRequestLogs(Number(document.querySelector('#request-logs-page-input').value) || 1));
document.querySelector('#close-request-log-detail').addEventListener('click', () => { document.querySelector('#request-log-detail-meta').textContent = tr('从左侧选择一条记录。'); document.querySelector('#request-log-request-body').textContent = tr('(未选择记录)'); document.querySelector('#request-log-response-body').textContent = tr('(未选择记录)'); });
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
    catch { status.textContent = tr('复制失败，请确认本地代理运行、所选地址可用。'); }
    finally { button.disabled = false; }
});
for (const id of ['curl-target', 'curl-stream']) document.querySelector('#' + id).addEventListener('change', () => updateCurl().catch(() => {
    document.querySelector('#curl-preview').textContent = tr('地址已变化，请刷新后重试。');
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
        status.textContent = tr(result.canceled ? '已取消。' : result.configChanged
            ? '已应用并更新 Codex Base URL，请重启 Codex。' : '网络设置已应用。');
    } catch (error) { status.textContent = error.message; }
    finally { networkBusy = false; button.disabled = false; await updateHealth(); }
});
document.querySelector('#test-local-service').addEventListener('click', async () => {
    const button = document.querySelector('#test-local-service');
    const status = document.querySelector('#network-status');
    button.disabled = true;
    status.textContent = '正在测试本地服务…';
    try {
        const health = await call('status');
        if (!health?.proxy_running) throw new Error('本地服务未运行。');
        status.textContent = `本地服务正常（${health.port || '未知端口'}）`;
    } catch (error) { status.textContent = `本地服务异常：${error.message}`; }
    finally { button.disabled = false; }
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
    hideStatisticsTooltip();
    document.querySelector('#home-page').hidden = false;
    document.querySelector('#statistics-page').hidden = true;
});
document.querySelector('#refresh-statistics').addEventListener('click', refreshStatistics);
document.querySelector('#statistics-account').addEventListener('change', renderStatistics);
document.querySelector('#statistics-period').addEventListener('click', event => {
    const button = event.target.closest('button[data-period]');
    if (!button) return;
    if (button.dataset.period === 'custom') {
        const end = Math.floor(Date.now() / 60000) * 60000;
        const start = end - 86400000;
        const inputValue = value => new Date(value + 8 * 3600000).toISOString().slice(0, 16);
        document.querySelector('#statistics-custom-start').value = inputValue(statisticsCustomRange?.start || start);
        document.querySelector('#statistics-custom-end').value = inputValue(statisticsCustomRange?.end || end);
        document.querySelector('#statistics-custom-status').textContent = tr('北京时间；最多选择 366 天，结束时间不可晚于当前时间。');
        document.querySelector('#statistics-custom-dialog').showModal();
        return;
    }
    statisticsPeriod = button.dataset.period;
    refreshStatistics();
});
document.querySelector('#statistics-custom-form').addEventListener('submit', event => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    const start = Date.parse(document.querySelector('#statistics-custom-start').value + ':00+08:00');
    const end = Date.parse(document.querySelector('#statistics-custom-end').value + ':00+08:00');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > Date.now() || end - start > 366 * 86400000) {
        document.querySelector('#statistics-custom-status').textContent = tr('请选择有效范围：结束时间晚于开始时间、不晚于当前时间，且跨度不超过 366 天。');
        return;
    }
    statisticsCustomRange = { start, end };
    statisticsPeriod = 'custom';
    document.querySelector('#statistics-custom-dialog').close();
    refreshStatistics();
});
for (const id of ['#statistics-hours', '#statistics-heatmap']) {
    const chart = document.querySelector(id);
    for (const type of ['pointerover', 'focusin']) chart.addEventListener(type, event => {
        const target = event.target.closest('.hour-column,.statistics-heatmap-cell');
        if (target) showStatisticsTooltip(target);
    });
    chart.addEventListener('pointerleave', hideStatisticsTooltip);
    chart.addEventListener('focusout', hideStatisticsTooltip);
}
window.addEventListener('resize', hideStatisticsTooltip);
window.addEventListener('scroll', () => {
    if (statisticsTooltipTarget && document.activeElement === statisticsTooltipTarget) showStatisticsTooltip(statisticsTooltipTarget);
    else hideStatisticsTooltip();
}, true);
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideStatisticsTooltip(); });
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
setInterval(() => { if (statisticsVisible && !statisticsLoading) refreshStatistics(); }, 10000);
window.addEventListener('languagechange', () => {
    // 语言切换后重新渲染动态卡片、状态和当前页面，避免必须重启应用。
    window.i18n?.apply();
    render();
    updateHealth();
    if (statisticsVisible) renderStatistics();
    if (!document.querySelector('#request-logs-page').hidden) renderRequestLogs();
});
refresh();


