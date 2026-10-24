import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGateway } from '../proxy/server.mjs';

test('capacity responses are retried internally before reaching the client', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'auth-switcher-test-'));
    const auth = path.join(root, 'auth');
    await mkdir(auth);
    await writeFile(path.join(auth, 'test.json'), JSON.stringify({ OPENAI_API_KEY: 'test-key' }));
    await writeFile(path.join(root, 'proxy.json'), JSON.stringify({ key: 'local-key', port: 0,
        lan_enabled: false, enabled: true, auth_directory: auth, selected_file: 'test.json',
        capacity_retry: { enabled: true, min_seconds: 0.1, max_seconds: 0.1 } }));
    let attempts = 0;
    const fetchUpstream = async () => {
        attempts++;
        if (attempts < 3) return new Response(JSON.stringify({ error: { message: 'Selected model is at capacity. Please try a different model.' } }),
            { status: 503, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ id: 'ok', output: [], usage: {} }),
            { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const gateway = await createGateway(root, { fetchUpstream });
    try {
        const response = await fetch(`http://127.0.0.1:${gateway.server.address().port}/v1/responses`, {
            method: 'POST', headers: { authorization: 'Bearer local-key', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'x', input: 'hi', stream: false }) });
        assert.equal(response.status, 200);
        assert.equal(attempts, 3);
    } finally { await gateway.close(); await rm(root, { recursive: true, force: true }); }
});

test('502 unknown errors use the same internal retry policy', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'auth-switcher-test-'));
    const auth = path.join(root, 'auth');
    await mkdir(auth);
    await writeFile(path.join(auth, 'test.json'), JSON.stringify({ OPENAI_API_KEY: 'test-key' }));
    await writeFile(path.join(root, 'proxy.json'), JSON.stringify({ key: 'local-key', port: 0,
        lan_enabled: false, enabled: true, auth_directory: auth, selected_file: 'test.json',
        capacity_retry: { enabled: true, min_seconds: 0.1, max_seconds: 0.1 } }));
    let attempts = 0;
    const fetchUpstream = async () => {
        attempts++;
        if (attempts === 1) return new Response('Bad Gateway: Unknown error', { status: 502 });
        return new Response(JSON.stringify({ id: 'ok', output: [], usage: {} }),
            { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const gateway = await createGateway(root, { fetchUpstream });
    try {
        const response = await fetch(`http://127.0.0.1:${gateway.server.address().port}/v1/responses`, {
            method: 'POST', headers: { authorization: 'Bearer local-key', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'x', input: 'hi', stream: false }) });
        assert.equal(response.status, 200);
        assert.equal(attempts, 2);
    } finally { await gateway.close(); await rm(root, { recursive: true, force: true }); }
});

test('incomplete streaming bodies are retried before delivery', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'auth-switcher-test-'));
    const auth = path.join(root, 'auth');
    await mkdir(auth);
    await writeFile(path.join(auth, 'test.json'), JSON.stringify({ OPENAI_API_KEY: 'test-key' }));
    await writeFile(path.join(root, 'proxy.json'), JSON.stringify({ key: 'local-key', port: 0,
        lan_enabled: false, enabled: true, auth_directory: auth, selected_file: 'test.json',
        capacity_retry: { enabled: true, min_seconds: 0.1, max_seconds: 0.1 } }));
    let attempts = 0;
    const fetchUpstream = async () => {
        attempts++;
        if (attempts === 1) {
            const body = new ReadableStream({ start(controller) {
                controller.enqueue(new TextEncoder().encode('event: response.output_text.delta\\ndata: {"delta":"partial"}\\n\\n'));
                controller.error(new Error('network error while reading response body'));
            } });
            return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        return new Response('event: response.completed\\ndata: {"response":{"status":"completed"}}\\n\\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const gateway = await createGateway(root, { fetchUpstream });
    try {
        const response = await fetch(`http://127.0.0.1:${gateway.server.address().port}/v1/responses`, {
            method: 'POST', headers: { authorization: 'Bearer local-key', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'x', input: 'hi', stream: true }) });
        assert.equal(response.status, 200);
        assert.match(await response.text(), /response\.completed/);
        assert.equal(attempts, 2);
    } finally { await gateway.close(); await rm(root, { recursive: true, force: true }); }
});
