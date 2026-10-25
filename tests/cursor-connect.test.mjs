import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeConnectEnvelopes, decodeStreamCppRequest, encodeStreamCppResponse,
    connectEnvelope } from '../proxy/cursor-connect.mjs';
import { candidateRoots, patchCursorSource } from '../scripts/cursor-local.mjs';

const bytes = (...values) => Buffer.from(values);
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
