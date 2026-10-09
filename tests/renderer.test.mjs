import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('reset cards show only the nearest valid expiry across ISO, seconds and milliseconds', async () => {
    const source = await readFile(new URL('../electron/renderer.js', import.meta.url), 'utf8');
    const context = vm.createContext({});
    vm.runInContext(source.slice(source.indexOf('function nearestResetCreditExpiry('), source.indexOf('function subscriptionPresentation(')), context);
    const nearest = context.nearestResetCreditExpiry;
    const first = Date.parse('2026-10-10T00:00:00Z');
    assert.equal(nearest([{ expires_at: '2026-10-12T00:00:00Z' }, { expiresAt: first / 1000 },
        { expires_at: Date.parse('2026-10-11T00:00:00Z') }, { expires_at: 'invalid' }]), '2026-10-10T00:00:00.000Z');
    assert.equal(nearest([{ expires_at: String(first / 1000) }]), '2026-10-10T00:00:00.000Z');
    assert.equal(nearest([{ expires_at: {} }, { expires_at: -1 }, {}]), null);
    assert.equal(nearest([]), null);
    assert.ok(!source.includes('过期时间不可用'));
});

test('membership displays dates and failure explicitly without using renewal or token expiry as membership expiry', async () => {
    const source = await readFile(new URL('../electron/renderer.js', import.meta.url), 'utf8');
    const context = vm.createContext({ date: value => String(value), expiryColor: () => 'danger' });
    vm.runInContext(source.slice(source.indexOf('function subscriptionPresentation('), source.indexOf('function keyConnectionPresentation(')), context);
    const show = context.subscriptionPresentation;
    assert.equal(show().value, '查询中…');
    assert.equal(show({ subscription: { status: 'failed', error: 'subscription_http_403' } }).value, '查询失败');
    assert.equal(show({ subscription: { status: 'unavailable' }, tokenExpiresAt: 123 }).value, '未提供');
    const renewal = show({ subscription: { status: 'available', renewsAt: '2026-10-17' } });
    assert.equal(renewal.value, '未提供');
    assert.match(renewal.detail, /续费 2026-10-17/);
    const membership = show({ subscription: { status: 'available', expiresAt: '2026-10-06',
        gracePeriodEndsAt: '2026-10-09' } });
    assert.equal(membership.value, '2026-10-06');
    assert.match(membership.detail, /宽限至 2026-10-09/);
});

test('key connection distinguishes written settings, verified traffic and repair without claiming early success', async () => {
    const source = await readFile(new URL('../electron/renderer.js', import.meta.url), 'utf8');
    const context = vm.createContext({});
    vm.runInContext(source.slice(source.indexOf('function keyConnectionPresentation('), source.indexOf('async function updateHealth(')), context);
    assert.equal(context.keyConnectionPresentation({ status: 'pending' }).tone, 'warning');
    assert.match(context.keyConnectionPresentation({ status: 'pending' }).text, /等待 Codex 请求验证/);
    assert.equal(context.keyConnectionPresentation({ status: 'verified' }).tone, 'good');
    assert.equal(context.keyConnectionPresentation({ status: 'config_mismatch' }).label, '修复 Key 配置');
    assert.equal(context.keyConnectionPresentation(undefined).tone, 'warning');
});

test('proxy and Codex cards share status rendering and use independent switch actions', async () => {
    const source = await readFile(new URL('../electron/renderer.js', import.meta.url), 'utf8');
    const renderer = source.slice(source.indexOf('function renderAccounts('), source.indexOf('async function updateHealth('));
    const element = (tag, className = '', text = '') => ({ tag, className, text, children: [],
        append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; },
        addEventListener(_name, handler) { this.click = handler; } });
    const actions = [];
    const context = vm.createContext({ element, items: [{ name: 'a.json', modifiedAt: 'saved', tokenExpiresAt: 123 }],
        usage: new Map([['a.json', { data: { plan_type: 'plus', rate_limit: {}, rate_limit_reset_credits: {} }, error: 'expired' }]]),
        health: { selected_file: 'a.json', codex_mode: 'auth_file', codex_auth_file: 'b.json' }, busy: false,
        windowMetric: (...args) => element('metric', '', JSON.stringify(args)), metric: (...args) => element('metric', '', JSON.stringify(args)),
        date: value => String(value), expiryColor: () => '',
        switchAccount: name => actions.push(['proxy', name]), switchCodexAccount: name => actions.push(['codex', name]) });
    vm.runInContext(renderer, context);
    const proxy = element('main');
    const direct = element('main');
    context.renderAccounts(proxy, false);
    context.renderAccounts(direct, true);
    assert.equal(JSON.stringify(proxy.children[0].children[1]), JSON.stringify(direct.children[0].children[1]));
    assert.equal(direct.children[0].children[2].text, 'expired');
    assert.equal(proxy.children[0].children[0].children[1].disabled, true);
    assert.equal(direct.children[0].children[0].children[1].disabled, false);
    direct.children[0].children[0].children[1].click();
    assert.deepEqual(actions, [['codex', 'a.json']]);
    context.health.selected_file = 'b.json';
    context.renderAccounts(proxy, false);
    proxy.children[0].children[0].children[1].click();
    assert.deepEqual(actions.at(-1), ['proxy', 'a.json']);
    context.usage.set('a.json', { data: { rate_limit_reset_credits: { available_count: 3, credits: [
        { status: 'available', expires_at: '2026-10-12T00:00:00Z' },
        { status: 'available', expires_at: '2026-10-10T00:00:00Z' },
        { status: 'used', expires_at: '2026-10-09T00:00:00Z' }
    ] } } });
    context.renderAccounts(proxy, false);
    const resetMetric = JSON.parse(proxy.children[0].children[1].children[2].text);
    assert.equal(resetMetric[1], '3');
    assert.equal(resetMetric[2], '最近过期时间 2026-10-10T00:00:00.000Z');
    context.usage.set('a.json', { data: { rate_limit_reset_credits: { available_count: 3 } } });
    context.renderAccounts(proxy, false);
    assert.equal(JSON.parse(proxy.children[0].children[1].children[2].text)[2], '最近过期时间：未提供');
    const html = await readFile(new URL('../electron/index.html', import.meta.url), 'utf8');
    assert.ok(!html.includes('id="codex-account"'));
    assert.ok(!html.includes('恢复 Codex 原配置'));
});
