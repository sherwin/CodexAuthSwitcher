import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGateway } from '../proxy/server.mjs';

const quota = { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached',
    plan_type: 'plus', resets_at: 1792871546, resets_in_seconds: 6463 } };

async function scenario(options, run) {
    const root = await mkdtemp(path.join(tmpdir(), 'quota-switch-'));
    const auth = path.join(root, 'accounts');
    await mkdir(auth);
    const names = ['a.json', 'b.json', 'custom.json'];
    for (const name of names) await writeFile(path.join(auth, name), JSON.stringify(name === 'custom.json'
        ? { provider: 'deepseek', base_url: 'https://example.com/v1', DEEPSEEK_API_KEY: name }
        : { OPENAI_API_KEY: name }));
    await writeFile(path.join(root, 'proxy.json'), JSON.stringify({ key: 'local', port: 0,
        enabled: true, auth_directory: auth, selected_file: options.selected || 'a.json',
        capacity_retry: { enabled: false },
        priority: { enabled: options.enabled !== false, order: names, disabled: options.disabled || [] } }));
    const attempts = [];
    const gateway = await createGateway(root, { fetchUpstream: async (_url, input) => {
        const name = input.headers.Authorization.slice(7);
        attempts.push(name);
        if (name === options.success) return new Response(JSON.stringify({ id: 'ok', output: [] }),
            { headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify(quota), { status: 429, headers: { 'content-type': 'application/json' } });
    } });
    try {
        const response = await fetch(`http://127.0.0.1:${gateway.server.address().port}/v1/responses`, {
            method: 'POST', headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'test', input: 'hi' }), signal: AbortSignal.timeout(5000) });
        await run({ response, attempts, root });
    } finally { await gateway.close(); await rm(root, { recursive: true, force: true }); }
}

test('usage_limit_reached switches internally to the next enabled account, including custom API', async () => {
    await scenario({ success: 'custom.json', disabled: ['b.json'] }, async ({ response, attempts, root }) => {
        assert.equal(response.status, 200);
        assert.equal((await response.json()).id, 'ok');
        assert.deepEqual(attempts, ['a.json', 'custom.json']);
        assert.equal(JSON.parse(await readFile(path.join(root, 'proxy.json'))).selected_file, 'custom.json');
    });
});

test('a full exhausted round returns quota only after trying each enabled account once', async () => {
    await scenario({ selected: 'b.json' }, async ({ response, attempts }) => {
        assert.equal(response.status, 429);
        assert.deepEqual(await response.json(), quota);
        assert.deepEqual(attempts, ['b.json', 'custom.json', 'a.json']);
    });
});

test('a manually selected excluded account can fall back to the single enabled account', async () => {
    await scenario({ success: 'b.json', disabled: ['a.json', 'custom.json'] }, async ({ response, attempts }) => {
        assert.equal(response.status, 200);
        assert.deepEqual(attempts, ['a.json', 'b.json']);
    });
});

test('switching remains disabled when explicitly turned off', async () => {
    await scenario({ enabled: false, success: 'b.json' }, async ({ response, attempts }) => {
        assert.equal(response.status, 429);
        assert.deepEqual(attempts, ['a.json']);
    });
});
