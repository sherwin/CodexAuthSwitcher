import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import net from 'node:net';
import { injectCursorAuthState, restoreCursorAuthState } from './cursor-local.mjs';

//吧 
// cursor-byok v1.x stores its managed CA/config under v3. Keep the path
// aligned with the released sidecar so its service actually reads our model
// adapter instead of silently starting with the old v2 profile.
const configDir = path.join(os.homedir(), '.cursor-byok-v3');
const configFile = path.join(configDir, 'config.yaml');
const backupFile = `${configFile}.codex-auth-switcher-backup`;
function cursorSettingsFile() {
    if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'settings.json');
    if (process.platform === 'linux') return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Cursor', 'User', 'settings.json');
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'User', 'settings.json');
}
const settingsFile = cursorSettingsFile();
const settingsBackupFile = `${settingsFile}.codex-auth-switcher-backup`;
const caCertFile = path.join(configDir, 'ca', 'ca.crt');
const caKeyFile = path.join(configDir, 'ca', 'ca.key');
const candidates = [
    process.env.CURSOR_BYOK_EXECUTABLE,
    'C:\\Installs\\cursor-byok\\cursor-byok-windows-amd64.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor-byok', 'cursor-byok.exe'),
    path.join(os.homedir(), '.local', 'bin', 'cursor-byok'),
    '/usr/local/bin/cursor-byok',
    '/Applications/cursor-byok.app/Contents/MacOS/cursor-byok'
].filter(Boolean);
let child;

function execFileAsync(file, args, options = {}) {
    return new Promise((resolve, reject) => execFile(file, args, options, (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
}

async function backupCursorSettings() {
    await fs.mkdir(path.dirname(settingsFile), { recursive: true });
    if (!(await fs.stat(settingsBackupFile).catch(() => null))) {
        await fs.copyFile(settingsFile, settingsBackupFile).catch(error => {
            if (error.code !== 'ENOENT') throw error;
            return fs.writeFile(settingsBackupFile, '', 'utf8');
        });
    }
}

async function restoreCursorSettings() {
    if (!(await fs.stat(settingsBackupFile).catch(() => null))) return false;
    const stat = await fs.stat(settingsBackupFile);
    if (stat.size === 0) await fs.rm(settingsFile, { force: true });
    else await fs.copyFile(settingsBackupFile, settingsFile);
    await fs.rm(settingsBackupFile, { force: true });
    return true;
}

async function caTrusted() {
    if (!(await fs.stat(caCertFile).catch(() => null)) || !(await fs.stat(caKeyFile).catch(() => null))) {
        return { state: 'missing', certFile: caCertFile };
    }
    if (process.platform === 'win32') {
        const result = await execFileAsync('certutil.exe', ['-store', 'Root']).catch(() => null);
        const text = result ? `${result.stdout}\n${result.stderr}` : '';
        return { state: /Cursor BYOK Local CA/i.test(text) ? 'ready' : 'untrusted', certFile: caCertFile };
    }
    if (process.platform === 'darwin') {
        const result = await execFileAsync('security', ['find-certificate', '-a', '-Z', '/Library/Keychains/System.keychain']).catch(() => null);
        return { state: result && /Cursor BYOK Local CA/i.test(result.stdout) ? 'ready' : 'untrusted', certFile: caCertFile };
    }
    const certificate = await fs.readFile(caCertFile, 'utf8');
    const anchors = ['/etc/ssl/certs/cursor-byok-local-ca.crt', '/usr/local/share/ca-certificates/cursor-byok-local-ca.crt', '/etc/pki/ca-trust/source/anchors/cursor-byok-local-ca.crt'];
    for (const anchor of anchors) if (await fs.readFile(anchor, 'utf8').then(value => value.trim() === certificate.trim()).catch(() => false)) {
        return { state: 'ready', certFile: caCertFile };
    }
    return { state: 'untrusted', certFile: caCertFile };
}

async function installCa() {
    if (process.platform === 'win32') {
        const escaped = caCertFile.replace(/'/g, "''");
        await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
            `$p=Start-Process -FilePath certutil.exe -ArgumentList @('-addstore','-f','Root','${escaped}') -Verb RunAs -Wait -PassThru; exit $p.ExitCode`]);
    } else if (process.platform === 'darwin') {
        await execFileAsync('osascript', ['-e', `do shell script "security add-trusted-cert -d -r trustRoot -p ssl -k /Library/Keychains/System.keychain '${caCertFile.replace(/'/g, "'\\''")}'" with administrator privileges`]);
    } else {
        const target = '/usr/local/share/ca-certificates/cursor-byok-local-ca.crt';
        await execFileAsync('pkexec', ['sh', '-c', `cp '${caCertFile.replace(/'/g, "'\\''")}' '${target}' && update-ca-certificates`]);
    }
    const result = await caTrusted();
    if (result.state !== 'ready') throw new Error('本地 CA 已生成，但系统信任安装未完成。请按系统提示授权后重试。');
    return result;
}

async function ensureCaTrust() {
    let result = await caTrusted();
    if (result.state === 'missing') return result;
    if (result.state === 'untrusted') result = await installCa();
    return result;
}

function controlUrlFromPort(port) { return `http://127.0.0.1:${port}/__byok-api__`; }

async function cursorByokControl(controlUrl, pathName, options = {}) {
    const response = await fetch(`${controlUrl.replace(/\/+$/, '')}${pathName}`, {
        ...options,
        headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`cursor-byok 控制请求失败：${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
    }
    return response.json().catch(() => ({}));
}

export async function initializeCursorByokCa(controlUrl) {
    return cursorByokControl(controlUrl, '/api/harness/cursor/ca/initialize', { method: 'POST' });
}

export async function setCursorByokEnabled(controlUrl, enabled) {
    return cursorByokControl(controlUrl, '/api/harness/cursor/enabled', {
        method: 'PUT', body: JSON.stringify({ enabled: Boolean(enabled) })
    });
}

export async function configureTabMode(controlUrl, { mode = 'custom', address = '' } = {}) {
    return cursorByokControl(controlUrl, '/api/settings/tab', {
        method: 'PUT', body: JSON.stringify({ mode, address })
    });
}

async function discoverControlUrl(timeoutMs = 20000) {
    const configured = process.env.CURSOR_BYOK_CONTROL_URL?.trim();
    if (configured) return configured.replace(/\/+$/, '');
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const files = await fs.readdir(path.join(configDir, 'logs')).catch(() => []);
        for (const name of files.filter(name => name.endsWith('.log')).sort().reverse()) {
            const text = await fs.readFile(path.join(configDir, 'logs', name), 'utf8').catch(() => '');
            const matches = [...text.matchAll(/cursor server listening address=127\.0\.0\.1:(\d+)/gi)];
            const port = Number(matches.at(-1)?.[1]);
            if (port && await waitForPort(port, 1000).catch(() => false)) return controlUrlFromPort(port);
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('未发现 cursor-byok 控制端口。请确认本地后端已启动。');
}

async function configureModel(controlUrl, { baseUrl, key, model = 'gpt-6.1-sol' } = {}) {
    const endpoint = `${controlUrl.replace(/\/+$/, '')}/api/models`;
    const existing = await fetch(endpoint).then(response => response.ok ? response.json() : null).catch(() => null);
    const models = Array.isArray(existing) ? existing : existing?.data ? existing.data : existing ? [existing] : [];
    if (models.some(item => item?.model_id === model && item?.base_url === baseUrl)) return existing;
    const body = { sort_order: 0, display_name: 'Codex Auth Switcher', group_name: 'Codex Auth Switcher', type: 'openai',
        base_url: baseUrl, use_full_url: false, api_key: key, tooltip_data: 'Local Codex Auth Switcher', model_id: model,
        reasoning_effort: 'medium', openai_endpoint: '/v1/responses', openai_extra_params_enabled: false, openai_extra_params: {},
        custom_headers_enabled: false, custom_headers: {}, anthropic_extra_params_enabled: false, anthropic_extra_params: {},
        context_window_tokens: 128000, max_completion_tokens: 8192, anthropic_max_tokens: 8192, thinking_budget_tokens: 8192 };
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`cursor-byok 模型配置失败：HTTP ${response.status}`);
    return response.json().catch(() => body);
}

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

async function cursorSettingsPath() { return cursorSettingsFile(); }

async function waitForCursorProxy(timeoutMs = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const file = await cursorSettingsPath();
        const text = await fs.readFile(file, 'utf8').catch(() => '');
        const match = text.match(/"http\.proxy"\s*:\s*"http:\/\/127\.0\.0\.1:(\d+)"/);
        if (match) {
            await waitForPort(Number(match[1]), Math.max(1000, timeoutMs - (Date.now() - started)));
            return `http://127.0.0.1:${match[1]}`;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('cursor-byok 未完成 CA/MITM 接管。请先在 cursor-byok 页面启用 Cursor takeover。');
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
    // cursor-byok supplies the local HTTPS/protocol adapter, while Cursor's
    // workbench still reads its signed-in state from state.vscdb. Keep that
    // state deterministic so takeover works without a real Cursor account.
    await injectCursorAuthState();
    await backupCursorSettings();
    let ownedChild = false;
    const existingControl = await discoverControlUrl(1000).catch(() => null);
    if (!existingControl && (!child || child.killed)) {
        child = spawn(resolved, [], { detached: false, windowsHide: true, stdio: 'ignore' });
        ownedChild = true;
        child.once('exit', () => { child = null; });
    }
    let controlUrl;
    let ca;
    try {
        controlUrl = await discoverControlUrl();
        // Use cursor-byok's supported takeover lifecycle instead of guessing
        // proxy settings. The CA is initialized first, then trusted locally,
        // and only then does the sidecar enable the HTTPS MITM.
        await initializeCursorByokCa(controlUrl);
        ca = await ensureCaTrust();
        await setCursorByokEnabled(controlUrl, true);
        const proxyUrl = await waitForCursorProxy();
        const model = await configureModel(controlUrl, options);
        const tab = await configureTabMode(controlUrl, { mode: 'custom', address: options.baseUrl });
        return { executable: resolved, running: true, pid: child?.pid ?? null, proxyUrl, controlUrl,
            modelHash: model?.model_hash, tabMode: tab?.mode || 'custom', tabAddress: options.baseUrl, ca };
    } catch (error) {
        if (controlUrl) await setCursorByokEnabled(controlUrl, false).catch(() => {});
        if (ownedChild && child && !child.killed) child.kill();
        child = null;
        throw error;
    }
}

export async function stopCursorByok({ restore = true } = {}) {
    const controlUrl = await discoverControlUrl(1000).catch(() => null);
    if (controlUrl) await setCursorByokEnabled(controlUrl, false).catch(() => {});
    if (child && !child.killed) child.kill();
    child = null;
    if (restore && await fs.stat(backupFile).catch(() => null)) await fs.copyFile(backupFile, configFile);
    if (restore) await restoreCursorAuthState();
    if (restore) await restoreCursorSettings();
    return { running: false, restored: restore };
}

export { caTrusted, discoverControlUrl, configureModel };
