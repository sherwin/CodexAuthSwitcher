import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import net from 'node:net';

// cursor-byok v1.x stores its managed CA/config under v3. Keep the path
// aligned with the released sidecar so its service actually reads our model
// adapter instead of silently starting with the old v2 profile.
const configDir = path.join(os.homedir(), '.cursor-byok-v3');
const configFile = path.join(configDir, 'config.yaml');
const backupFile = `${configFile}.codex-auth-switcher-backup`;
const candidates = [
    process.env.CURSOR_BYOK_EXECUTABLE,
    'C:\\Installs\\cursor-byok\\cursor-byok-windows-amd64.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor-byok', 'cursor-byok.exe'),
    path.join(os.homedir(), '.local', 'bin', 'cursor-byok'),
    '/usr/local/bin/cursor-byok',
    '/Applications/cursor-byok.app/Contents/MacOS/cursor-byok'
].filter(Boolean);
let child;

function waitForPort(port, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const probe = () => {
            const socket = net.createConnection({ host: '127.0.0.1', port });
            socket.once('connect', () => { socket.destroy(); resolve(true); });
            socket.once('error', () => {
                socket.destroy();
                if (Date.now() - started >= timeoutMs) reject(new Error(`cursor-byok 未启动本地端口 ${port}。请先在 cursor-byok 界面完成 CA 初始化。`));
                else setTimeout(probe, 250);
            });
        };
        probe();
    });
}

export function cursorByokExecutable() { return candidates[0]; }

function config(baseUrl, key, model = 'gpt-6.1-sol') {
    return {
        log: false, providerStreamIdleTimeout: 240, backendListenAddr: '127.0.0.1:18090',
        proxyListenAddr: '127.0.0.1:18080', routing: { mode: 'local' },
        modelAdapters: [{ displayName: model, type: 'openai', baseURL: `${baseUrl.replace(/\/$/, '')}/v1`,
            apiKey: key, modelID: model, reasoningEffort: 'medium', openAIEndpoint: '',
            openAIExtraParamsEnabled: false, customHeadersEnabled: false, contextWindowTokens: 0,
            maxCompletionTokens: 0, anthropicMaxTokens: 0 }]
    };
}

export async function prepareCursorByok({ baseUrl, key, model } = {}) {
    await fs.mkdir(configDir, { recursive: true });
    if (!(await fs.stat(backupFile).catch(() => null))) await fs.copyFile(configFile, backupFile).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return fs.writeFile(backupFile, '', 'utf8');
    });
    await fs.writeFile(configFile, JSON.stringify(config(baseUrl, key, model), null, 2) + '\n', 'utf8');
    return { configFile, backupFile };
}

export async function startCursorByok(options) {
    const resolved = await Promise.any(candidates.map(async file => { await fs.access(file); return file; })).catch(() => null);
    if (!resolved) throw new Error('未找到 cursor-byok。请设置 CURSOR_BYOK_EXECUTABLE 或安装 cursor-byok。');
    await prepareCursorByok(options);
    if (child && !child.killed) return { executable: resolved, running: true, pid: child.pid };
    child = spawn(resolved, [], { detached: false, windowsHide: true, stdio: 'ignore' });
    child.once('exit', () => { child = null; });
    try { await waitForPort(18080); await waitForPort(18090); }
    catch (error) {
        if (child && !child.killed) child.kill();
        child = null;
        throw error;
    }
    return { executable: resolved, running: true, pid: child.pid, proxyUrl: 'http://127.0.0.1:18080' };
}

export async function stopCursorByok({ restore = true } = {}) {
    if (child && !child.killed) child.kill();
    child = null;
    if (restore && await fs.stat(backupFile).catch(() => null)) await fs.copyFile(backupFile, configFile);
    return { running: false, restored: restore };
}
