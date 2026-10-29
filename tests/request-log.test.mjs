import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequestLog } from '../proxy/request-log.mjs';

test('request logger persists request and response bodies in SQLite', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'auth-switcher-log-'));
    const logger = await createRequestLog(directory);
    await logger.record({ startedAt: '2026-10-24T00:00:00.000Z', finishedAt: '2026-10-24T00:00:01.000Z',
        method: 'POST', path: '/v1/responses', account: 'one.json', status: 200, success: true,
        durationMs: 1000, requestBody: { input: 'hello' }, responseBody: '{"ok":true}' });
    const list = logger.list();
    assert.equal(list.length, 1);
    const detail = logger.get(list[0].id);
    assert.equal(detail.requestBody, '{"input":"hello"}');
    assert.equal(detail.responseBody, '{"ok":true}');
    assert.equal(logger.count(), 1);
    assert.equal(logger.list(1, 1).length, 0);
    await logger.close();
    const files = await readdir(directory);
    assert.deepEqual(files.filter(file => /^requests-\d{4}-\d{2}-\d{2}\.sqlite3$/.test(file)).length, 1);
    assert.ok((await readFile(path.join(directory, files.find(file => file.startsWith('requests-')))).then(value => value.length)) > 0);
    await rm(directory, { recursive: true, force: true });
});

test('request logger bounds retained records and body size', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'auth-switcher-log-limit-'));
    const logger = await createRequestLog(directory);
    for (let index = 0; index < 2002; index++) {
        await logger.record({ startedAt: `2026-10-24T00:00:${String(index % 60).padStart(2, '0')}.000Z`, finishedAt: '2026-10-24T00:00:01.000Z',
            method: 'POST', path: '/v1/responses', status: 200, success: true, durationMs: 1,
            requestBody: { index }, responseBody: 'ok' });
    }
    assert.equal(logger.count(), 2000);
    const large = 'x'.repeat(300 * 1024);
    await logger.record({ startedAt: '2026-10-24T00:00:00.000Z', finishedAt: '2026-10-24T00:00:01.000Z',
        method: 'POST', path: '/v1/responses', status: 200, success: true, durationMs: 1,
        requestBody: { large }, responseBody: large });
    const detail = logger.get(logger.list(1)[0].id);
    assert.ok(detail.requestBody.length < 300 * 1024);
    assert.ok(detail.responseBody.length < 300 * 1024);
    await logger.close();
    await rm(directory, { recursive: true, force: true });
});
