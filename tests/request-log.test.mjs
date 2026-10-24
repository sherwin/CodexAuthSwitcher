import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    assert.ok((await readFile(path.join(directory, 'requests.sqlite3')).then(value => value.length)) > 0);
    await rm(directory, { recursive: true, force: true });
});
