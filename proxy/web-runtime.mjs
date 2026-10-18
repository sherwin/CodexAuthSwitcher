import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { ProxyError } from './storage.mjs';

const execute = promisify(execFile);
const unit = 'cc-connect.service';
export function createWebRuntime({ enabled = process.env.AUTH_SWITCHER_MANAGE_CODEX === '1',
    run = execute, read = file => fs.readFile(file, 'utf8'), call } = {}) {
    let busy = false;
    async function status() {
        if (!enabled) return { available: false, active: false };
        try {
            const { stdout } = await run('/bin/systemctl', ['show', unit, '-p', 'ActiveState',
                '-p', 'SubState', '-p', 'MainPID', '-p', 'KillMode', '-p', 'ExecMainStartTimestamp'],
            { timeout: 15000, maxBuffer: 65536 });
            const fields = Object.fromEntries(stdout.trim().split('\n').map(line => {
                const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
            }));
            const pid = Number(fields.MainPID) || 0;
            let children = null;
            try {
                const pids = (await read('/sys/fs/cgroup/system.slice/cc-connect.service/cgroup.procs'))
                    .trim().split(/\s+/).map(Number).filter(Boolean);
                children = pids.filter(value => value !== pid).length;
            } catch { /* A stopped service may have no cgroup. */ }
            return { available: true, active: fields.ActiveState === 'active', pid,
                state: fields.ActiveState, children, killMode: fields.KillMode,
                startedAt: fields.ExecMainStartTimestamp || null, busy };
        } catch {
            throw new ProxyError('无法读取飞书 Codex 服务状态。', 'runtime_status_failed', 503);
        }
    }
    async function ensureIdle(force, current) {
        const health = await call('/health');
        if (!force && (health.in_flight || current.children === null || current.children > 0))
            throw new ProxyError('可能有 Codex 任务正在执行；请等待完成，或确认中断后重启。', 'runtime_busy', 409);
        if (current.killMode !== 'control-group')
            throw new ProxyError('服务需要使用 KillMode=control-group 才能安全重启 Codex。', 'invalid_kill_mode', 409);
    }
    async function restartLocked(current) {
        try { await run('/bin/systemctl', ['restart', unit], { timeout: 30000, maxBuffer: 65536 }); }
        catch { throw new ProxyError('飞书 Codex 重启失败，请检查服务日志。', 'runtime_restart_failed', 503); }
        const result = await status();
        if (!result.active || !result.pid || (current.active && result.pid === current.pid))
            throw new ProxyError('未确认 Codex 服务完成重启，请检查服务状态。', 'runtime_restart_unverified', 503);
        return { ok: true, restarted: true, runtime: result };
    }
    return {
        get busy() { return busy; },
        status,
        async restart({ force = false, proxy = false } = {}) {
            if (!enabled) throw new ProxyError('此部署未启用 Codex 重启管理。', 'runtime_disabled', 403);
            if (busy) throw new ProxyError('Codex 正在重启，请稍后重试。', 'runtime_busy', 409);
            busy = true;
            try {
                const current = await status(); await ensureIdle(force === true, current);
                if (proxy) {
                    const health = await call('/health');
                    if (!health.selected_file) throw new ProxyError('请先在本地代理页选择出口账号。', 'no_account_selected', 409);
                    await call('/admin/configure', {});
                }
                try { return await restartLocked(current); }
                catch (error) {
                    if (proxy) throw new ProxyError('代理配置已应用，但服务重启未成功；请点击重启重试。', 'proxy_restart_failed', 503);
                    throw error;
                }
            } finally { busy = false; }
        },
    };
}
