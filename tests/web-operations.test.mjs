import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createWebOperations } from '../proxy/web-operations.mjs';
import { readJSON, writeJSON } from '../proxy/storage.mjs';

test('directory failures preserve the original state and reject concurrent settings writes', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'switcher-directory-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const next = path.join(directory, 'next'); await fs.mkdir(next);
    const stateFile = path.join(directory, 'proxy.json');
    const original = { port: 18888, key: 'fixture-key', auth_directory: directory, selected_file: 'a.json' };
    await writeJSON(stateFile, original);
    let closed = 0, starts = 0, release;
    const stopped = new Promise(resolve => { release = resolve; });
    const gateway = { pause() {}, async close() { closed++; await stopped; } };
    const operations = createWebOperations(directory, { gateway, startGateway: async () => {
        if (++starts === 1) throw Error('fixture startup failed');
        return { close: async () => { closed++; } };
    } });
    const changing = operations.directory({ path: next });
    while (!closed) await new Promise(resolve => setImmediate(resolve));
    assert.equal(operations.busy, true);
    await assert.rejects(operations.network({ port: 18888, lan_enabled: false }), /正在更新/);
    release(); await assert.rejects(changing, /fixture startup failed/);
    assert.equal(operations.busy, false); assert.equal(starts, 2);
    assert.deepEqual(await readJSON(stateFile), original);
    await operations.close(); assert.equal(closed, 2);
});

test('an active inference request prevents directory shutdown or state changes', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'switcher-directory-busy-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const original = { auth_directory: directory, selected_file: 'a.json' };
    await writeJSON(path.join(directory, 'proxy.json'), original);
    const operations = createWebOperations(directory, { gateway: {
        pause() { throw Error('requests in flight'); }, close() { throw Error('must not close'); },
    } });
    await assert.rejects(operations.directory({ path: directory }), /requests in flight/);
    assert.deepEqual(await readJSON(path.join(directory, 'proxy.json')), original);
    assert.equal(operations.busy, false);
});
