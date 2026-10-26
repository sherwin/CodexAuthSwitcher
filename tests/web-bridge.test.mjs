import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('reading priority and settings never submits an empty save', async () => {
    const source = await readFile(new URL('../proxy/web-bridge.js', import.meta.url), 'utf8');
    const requests = [];
    let priority = { disabled: ['主账号.json'], order: ['a.json', '主账号.json'] };
    const context = vm.createContext({ window: {}, fetch: async (url, options) => {
        requests.push({ url, ...options });
        if (url === '/api/priority' && options.method === 'POST') priority = JSON.parse(options.body).priority;
        return { ok: true, status: 200, json: async () => ({ priority }) };
    } });
    vm.runInContext(source.slice(0, source.indexOf('    let directoryOpen')) + '\n})();', context);
    const api = context.window.authSwitcher;
    await api.call('priority', { priority });
    for (let i = 0; i < 3; i++) {
        const result = await api.call('priority');
        assert.deepEqual(Array.from(result.result.priority.disabled), ['主账号.json']);
        await api.call('settings');
    }
    assert.equal(requests[0].method, 'POST');
    assert.ok(requests.slice(1).every(request => request.method === 'GET' && request.body === undefined));
    await api.call('settings', { capacity_retry: { enabled: false } });
    assert.equal(requests.at(-1).method, 'POST');
    await api.call('configure');
    assert.equal(requests.at(-1).method, 'POST');
});
