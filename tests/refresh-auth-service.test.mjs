import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountFiles, createRefreshService, directoryCheckIntervalMs, refreshIntervalMs, runService, tokenRefreshWindowSeconds } from '../scripts/refresh-auth-service.mjs';

test('scheduled refresh scans every JSON account in stable order and uses a one-day window', async () => {
    const names = await accountFiles('/ignored', { readdir: async () => ['z.json', 'note.txt', 'a.json'] });
    assert.deepEqual(names, ['a.json', 'z.json']);
    assert.equal(tokenRefreshWindowSeconds, 86400);
    assert.equal(refreshIntervalMs, 21600000);
    assert.equal(directoryCheckIntervalMs, 60000);
});

test('embedded refresh service starts with the application and stops cleanly', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-auth-refresh-'));
    await fs.writeFile(path.join(directory, 'proxy.json'), JSON.stringify({ auth_directory: directory }));
    const controller = new AbortController();
    let runs = 0;
    const task = runService({ directory, intervalMs: 1000, signal: controller.signal,
        refreshAll: async () => { runs += 1; return { authDirectory: directory }; }, log: () => {} });
    await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort();
    await task;
    assert.equal(runs, 1);

    const service = createRefreshService({ directory, refreshAll: async () => ({ authDirectory: directory }), log: () => {} });
    service.start();
    await service.stop();
    await fs.rm(directory, { recursive: true, force: true });
});
