import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebRuntime } from '../proxy/web-runtime.mjs';

function fixture(options = {}) {
    let pid = 101;
    const commands = [], calls = [];
    const runtime = createWebRuntime({ enabled: true, platform: 'linux',
        run: async (file, args) => {
            commands.push([file, args]);
            if (args[0] === 'restart') { pid++; return { stdout: '' }; }
            return { stdout: `ActiveState=active\nMainPID=${pid}\nKillMode=control-group\n` };
        }, read: async () => String(pid),
        call: async (route, body) => { calls.push([route, body]); return { selected_file: 'test.json', in_flight: 0 }; },
        ...options });
    return { runtime, commands, calls };
}
test('runtime is opt-in and restarts only the fixed cc-connect unit', async () => {
    const disabled = createWebRuntime({ enabled: false, platform: 'linux', run: () => { throw Error('must not execute'); } });
    assert.equal((await disabled.status()).available, false);
    await assert.rejects(disabled.restart(), /未启用/);
    const f = fixture();
    const result = await f.runtime.restart({ unit: 'other.service', force: true });
    assert.equal(result.runtime.pid, 102); assert.equal(result.restarted, true);
    assert.deepEqual(f.commands.filter(([, args]) => args[0] === 'restart'),
        [['/bin/systemctl', ['restart', 'cc-connect.service']]]);
});
test('macOS and Windows never execute systemd commands or configure Codex through Linux runtime controls', async () => {
    for (const platform of ['darwin', 'win32']) {
        const runtime = createWebRuntime({ enabled: true, platform,
            run: () => { throw Error('must not execute'); },
            read: () => { throw Error('must not read Linux cgroups'); },
            call: () => { throw Error('must not configure Codex'); } });
        assert.deepEqual(await runtime.status(), { available: false, active: false });
        await assert.rejects(runtime.restart({ proxy: true, force: true }), error => error.code === 'runtime_unsupported');
    }
});
test('proxy activation configures the local Codex before restart and requires a selected account', async () => {
    const f = fixture(); await f.runtime.restart({ proxy: true });
    assert.equal(f.calls.at(-1)[0], '/admin/configure');
    const noAccount = fixture({ call: async () => ({ in_flight: 0 }) });
    await assert.rejects(noAccount.runtime.restart({ proxy: true }), /选择出口账号/);
    assert.equal(noAccount.commands.some(([, args]) => args[0] === 'restart'), false);
});
test('active Codex children require explicit interruption and service failures do not report success', async () => {
    const f = fixture({ read: async () => '101\n202\n' });
    await assert.rejects(f.runtime.restart(), /任务正在执行/);
    assert.equal(f.runtime.busy, false);
    await f.runtime.restart({ force: true });
    const failed = fixture({ run: async (_file, args) => {
        if (args[0] === 'restart') throw Error('private details');
        return { stdout: 'ActiveState=active\nMainPID=101\nKillMode=control-group\n' };
    } });
    await assert.rejects(failed.runtime.restart({ proxy: true }), /代理配置已应用，但服务重启未成功/);
    assert.equal(failed.runtime.busy, false);
    const unchanged = fixture({ run: async () => ({ stdout: 'ActiveState=active\nMainPID=101\nKillMode=control-group\n' }) });
    await assert.rejects(unchanged.runtime.restart(), /未确认/);
});
test('runtime serializes restart requests', async () => {
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const f = fixture({ call: async () => { await wait; return { in_flight: 0 }; } });
    const first = f.runtime.restart();
    await assert.rejects(f.runtime.restart(), /正在重启/);
    release(); await first; assert.equal(f.runtime.busy, false);
});
