import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cursorByokExecutable, prepareCursorByok } from '../scripts/cursor-byok-sidecar.mjs';

function server(handler) {
    const instance = http.createServer(handler);
    return new Promise(resolve => instance.listen(0, '127.0.0.1', () => resolve(instance)));
}

test('native takeover does not resolve or spawn an external cursor-byok artifact', async () => {
    assert.equal(cursorByokExecutable(), null);
    const result = await prepareCursorByok();
    assert.match(result.root, /\.codex-auth-switcher[\\/]cursor$/);
});
