import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('window close quits without confirmation and repeated quit events wait for one proxy shutdown', async () => {
    const source = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
    const handlers = new Map();
    let quitCalls = 0;
    let closeCalls = 0;
    let release;
    let prevented = 0;
    const closing = new Promise(resolve => { release = resolve; });
    const context = vm.createContext({ window: { isDestroyed: () => true },
        app: { on: (name, handler) => handlers.set(name, handler), quit: () => { quitCalls++; } },
        gateway: { close: () => { closeCalls++; return closing; } } });
    vm.runInContext('let quitting = false; let shutdownPromise;\n' + source.slice(source.indexOf("app.on('activate'")), context);
    assert.ok(!source.includes("window.on('close'"));
    assert.ok(!source.includes('showMessageBoxSync'));
    handlers.get('window-all-closed')();
    assert.equal(quitCalls, 1);
    const event = { preventDefault: () => { prevented++; } };
    handlers.get('before-quit')(event);
    handlers.get('before-quit')(event);
    await Promise.resolve();
    assert.equal(closeCalls, 1);
    assert.equal(prevented, 2);
    assert.equal(quitCalls, 1);
    release();
    await vm.runInContext('shutdownPromise', context);
    assert.equal(quitCalls, 2);
    handlers.get('before-quit')(event);
    assert.equal(prevented, 2);
});
