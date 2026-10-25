import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { decodeConnectEnvelopes, decodeStreamCppRequest, encodeStreamCppResponse,
    connectEnvelope } from '../proxy/cursor-connect.mjs';
import { candidateRoots, cursorStateDatabase, injectCursorAuthState, localCursorAuthValues,
    patchCursorSource, restoreCursorAuthState } from '../scripts/cursor-local.mjs';

const bytes = (...values) => Buffer.from(values);
const require = createRequire(import.meta.url);
const stringField = (field, value) => {
    const data = Buffer.from(value);
    return Buffer.concat([bytes((field << 3) | 2, data.length), data]);
};
const messageField = (field, value) => Buffer.concat([bytes((field << 3) | 2, value.length), value]);

test('decodes Cursor StreamCpp request fields used by the adapter', () => {
    const position = Buffer.concat([bytes(8, 3), bytes(16, 7)]);
    const file = Buffer.concat([stringField(1, 'src/app.ts'), stringField(2, 'const answer = 42;'), messageField(3, position)]);
    const request = Buffer.concat([messageField(1, file), stringField(3, 'main')]);
    assert.deepEqual(decodeStreamCppRequest(request), {
        model: 'main', path: 'src/app.ts', contents: 'const answer = 42;', line: 3, column: 7
    });
});

test('round trips Connect envelopes and emits a StreamCpp response', () => {
    const response = encodeStreamCppResponse({ text: ' + 1', doneStream: true, startLine: 4, endLine: 4 });
    const envelopes = decodeConnectEnvelopes(connectEnvelope(response));
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].flags, 0);
    assert.ok(envelopes[0].message.length > 0);
});

test('Cursor patch locations and replacements work on Windows and macOS', () => {
    assert.match(candidateRoots('win32', { LOCALAPPDATA: 'C:\\Users\\demo' })[0], /Programs[\\/]cursor/);
    assert.match(candidateRoots('darwin', { HOME: '/Users/demo' })[0], /Cursor\.app/);
    const source = 'ykt="https://api4.cursor.sh";SWe="https://api4.cursor.sh"';
    const patched = patchCursorSource(source, 'http://127.0.0.1:18888');
    assert.equal(patched, 'ykt="http://127.0.0.1:18888";SWe="http://127.0.0.1:18888"');
});

test('Cursor newer minified backend constants are patched without login changes', () => {
    const source = 'auth="https://api.cursor.com";prr="https://api4.cursor.sh";j6n="https://api4.cursor.sh"';
    const patched = patchCursorSource(source, 'http://127.0.0.1:18888');
    assert.equal(patched, 'auth="https://api.cursor.com";prr="http://127.0.0.1:18888";j6n="http://127.0.0.1:18888"');
});

test('Cursor local auth state is injected with a recoverable backup', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cursor-auth-test-'));
    const file = path.join(directory, 'state.vscdb');
    try {
        const SQL = (await import('sql.js')).default;
        const sql = await SQL({ locateFile: name => path.join(path.dirname(require.resolve('sql.js')), name) });
        const original = new sql.Database();
        original.run('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
        original.run("INSERT INTO ItemTable(key, value) VALUES ('original', 'preserved')");
        await (await import('node:fs/promises')).writeFile(file, Buffer.from(original.export()));
        original.close();
        const result = await injectCursorAuthState(file);
        assert.equal(result.email, 'cursor@ai.com');
        const db = new sql.Database(await readFile(file));
        const rows = db.exec("SELECT key, value FROM ItemTable WHERE key LIKE 'cursorAuth/%' ORDER BY key")[0].values;
        db.close();
        assert.equal(rows.length, Object.keys(localCursorAuthValues()).length);
        assert.ok(rows.some(([key, value]) => key === 'cursorAuth/cachedEmail' && value === 'cursor@ai.com'));
        assert.ok((await readFile(`${file}.codex-auth-switcher-cursor-auth-backup`)).length > 0);
        assert.equal((await restoreCursorAuthState(file)).restored, true);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
