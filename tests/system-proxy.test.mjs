import test from 'node:test';
import assert from 'node:assert/strict';
import { proxyAddress, systemProxyFetch } from '../proxy/system-proxy.mjs';

test('system proxy rules retain priority and reject unsupported proxies instead of leaking direct traffic', () => {
    assert.equal(proxyAddress('PROXY 127.0.0.1:7890; DIRECT'), 'http://127.0.0.1:7890');
    assert.equal(proxyAddress('HTTPS proxy.example:8443'), 'https://proxy.example:8443');
    assert.equal(proxyAddress('PROXY proxy.example:80'), 'http://proxy.example');
    assert.equal(proxyAddress('DIRECT; PROXY ignored.example:8080'), null);
    assert.throws(() => proxyAddress('SOCKS5 127.0.0.1:1080; DIRECT'), /HTTP\/HTTPS/);
    assert.throws(() => proxyAddress('PROXY user:password@proxy.example:8080'), /无效/);
    assert.throws(() => proxyAddress(''), /无法解析/);
});
test('proxy selection runs per URL, reuses agents and preserves headers and streaming request bodies', async () => {
    const calls = [], agents = [];
    const fetch = systemProxyFetch(async url => url.includes('localhost') ? 'DIRECT' : 'PROXY 127.0.0.1:7890', {
        createAgent: address => { const agent = { address }; agents.push(agent); return agent; },
        request: async (url, options) => { calls.push([url, options]); return { ok: true }; },
    });
    const options = { headers: { Authorization: 'fixture-token' }, body: 'fixture-body', redirect: 'manual' };
    await fetch('https://api.example/responses', options); await fetch('https://api.example/usage', options);
    await fetch('http://localhost/test', options);
    assert.equal(agents.length, 2);
    assert.equal(calls[0][1].dispatcher, calls[1][1].dispatcher);
    assert.equal(calls[2][1].dispatcher.address, null);
    assert.equal(calls[0][1].headers, options.headers); assert.equal(calls[0][1].body, options.body);
});
