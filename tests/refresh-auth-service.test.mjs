import test from 'node:test';
import assert from 'node:assert/strict';
import { accountFiles, directoryCheckIntervalMs, refreshIntervalMs, tokenRefreshWindowSeconds } from '../scripts/refresh-auth-service.mjs';

test('scheduled refresh scans every JSON account in stable order and uses a one-day window', async () => {
    const names = await accountFiles('/ignored', { readdir: async () => ['z.json', 'note.txt', 'a.json'] });
    assert.deepEqual(names, ['a.json', 'z.json']);
    assert.equal(tokenRefreshWindowSeconds, 86400);
    assert.equal(refreshIntervalMs, 21600000);
    assert.equal(directoryCheckIntervalMs, 60000);
});
