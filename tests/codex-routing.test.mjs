import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { configure } from '../proxy/config.mjs';
import { writeJSON } from '../proxy/storage.mjs';

// Opt-in: exercise the installed Codex executable against a fake local Responses endpoint.
// No real account, upstream request, or user conversation is used.
test('installed Codex routes both built-in and historical custom providers to the local key endpoint',
    { skip: !process.env.AUTH_SWITCHER_TEST_CODEX, timeout: 90000 }, async t => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-routing-'));
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        const requests = [];
        const server = http.createServer(async (req, res) => {
            if (!req.url.startsWith('/v1/responses')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ models: [], data: [] }));
            }
            for await (const _chunk of req) { /* Drain the test request. */ }
            requests.push({ url: req.url, authorization: req.headers.authorization, method: req.method });
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const item = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed',
                content: [{ type: 'output_text', text: 'local-test-ok', annotations: [] }] };
            const response = { id: 'resp_test', object: 'response', status: 'completed', output: [item],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
            for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
                { type: 'response.output_item.done', output_index: 0, item },
                { type: 'response.completed', response }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
            res.end();
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(() => new Promise(resolve => server.close(resolve)));
        await writeJSON(path.join(directory, 'proxy.json'), { key: 'isolated-test-key', port: server.address().port });
        await fs.mkdir(path.join(directory, 'archived_sessions'));
        await fs.writeFile(path.join(directory, 'archived_sessions', 'old.jsonl'),
            JSON.stringify({ type: 'session_meta', payload: { model_provider: 'custom' } }) + '\n');
        await fs.writeFile(path.join(directory, 'config.toml'), 'model = "gpt-6.1-sol"\n');
        await configure(directory, path.join(directory, 'config.toml'));
        const env = { ...process.env, CODEX_HOME: directory };
        delete env.OPENAI_API_KEY;
        delete env.OPENAI_BASE_URL;
        const threads = [];
        for (const provider of ['openai', 'custom']) {
            const running = promisify(execFile)(process.env.AUTH_SWITCHER_TEST_CODEX,
                ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--json',
                    '-c', `model_provider="${provider}"`,
                    '-C', directory, 'Reply local-test-ok only.'],
                { env, timeout: 35000, maxBuffer: 1024 * 1024 });
            running.child.stdin.end();
            const result = await running;
            assert.match(result.stdout, /local-test-ok/);
            threads.push(JSON.parse(result.stdout.split('\n').find(line => line.includes('thread.started'))).thread_id);
        }
        // The desktop uses app-server resume. Resume the saved IDs without a provider override.
        const app = spawn(process.env.AUTH_SWITCHER_TEST_CODEX, ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
        t.after(() => app.kill());
        const pending = new Map();
        let sequence = 0;
        let finishTurn;
        const lines = createInterface({ input: app.stdout });
        lines.on('line', line => {
            const message = JSON.parse(line);
            if (message.id !== undefined) {
                const resolve = pending.get(message.id);
                pending.delete(message.id);
                resolve?.(message);
            }
            if (message.method === 'turn/completed') finishTurn?.(message.params);
        });
        async function rpc(method, params) {
            const id = ++sequence;
            const result = new Promise(resolve => pending.set(id, resolve));
            app.stdin.write(JSON.stringify({ id, method, params }) + '\n');
            const response = await result;
            assert.equal(response.error, undefined, JSON.stringify(response.error));
            return response.result;
        }
        await rpc('initialize', { clientInfo: { name: 'codex_auth_switcher_test', version: '1.0' },
            capabilities: { experimentalApi: true } });
        app.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
        await configure(directory, path.join(directory, 'config.toml'));
        for (const threadId of threads) {
            await rpc('thread/resume', { threadId });
            const completed = new Promise(resolve => { finishTurn = resolve; });
            const before = requests.filter(request => request.method === 'POST').length;
            await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Reply local-test-ok only.' }] });
            const result = await completed;
            assert.equal(result.turn.status, 'completed', JSON.stringify(result.turn.error));
            assert.ok(requests.filter(request => request.method === 'POST').length > before);
        }
        assert.ok(requests.filter(request => request.method === 'POST').length >= 2);
        assert.ok(requests.every(request => request.url === '/v1/responses' && request.authorization === 'Bearer isolated-test-key'),
            JSON.stringify(requests));
    });
