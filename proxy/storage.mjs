import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import lockfile from 'proper-lockfile';

export const provider = 'auth_switcher_local';
export const defaultDirectory = process.env.AUTH_SWITCHER_HOME || path.join(os.homedir(),
    process.platform === 'darwin' ? 'Library/Application Support/CodexAuthSwitcher' : '.codex-auth-switcher');
export const defaultAuthDirectory = process.env.AUTH_SWITCHER_AUTH_DIR ||
    path.join(os.homedir(), process.platform === 'darwin' ? 'Code/Codex-auth' : 'Codex-auth');
export const codexDirectory = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const defaultCapacityRetrySettings = Object.freeze({ enabled: true, min_seconds: 1, max_seconds: 5, max_retries: 5 });
export function normalizeCapacityRetrySettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    const min = Math.min(60, Math.max(0.1, Number(source.min_seconds) || 1));
    const max = Math.min(60, Math.max(min, Number(source.max_seconds) || 5));
    const maxRetries = Math.min(20, Math.max(0, Number.isFinite(Number(source.max_retries)) ? Math.floor(Number(source.max_retries)) : 5));
    return { enabled: source.enabled !== false, min_seconds: min, max_seconds: max, max_retries: maxRetries };
}
export function normalizePrioritySettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    return { enabled: source.enabled !== false, max_errors: 10,
        order: Array.isArray(source.order) ? [...new Set(source.order.filter(item => typeof item === 'string'))] : [],
        disabled: Array.isArray(source.disabled) ? [...new Set(source.disabled.filter(item => typeof item === 'string'))] : [],
        include_custom: source.include_custom === true };
}

export class ProxyError extends Error {
    constructor(message, code = 'proxy_error', status = 503) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

export async function atomicWrite(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(12).toString('hex')}`);
    let handle;
    try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(data);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporary, file);
    } finally {
        await handle?.close();
        await fs.unlink(temporary).catch(() => {});
    }
}

export async function readJSON(file) {
    return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function writeJSON(file, value) {
    await atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}

export async function locked(file, action) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const handle = await fs.open(file, 'a', 0o600);
    await handle.close();
    const release = await lockfile.lock(file, { stale: 120000, update: 10000,
        retries: { retries: 80, minTimeout: 100, maxTimeout: 1000 } });
    try { return await action(); } finally { await release(); }
}

export function accountPath(state, name) {
    if (typeof name !== 'string' || !name.endsWith('.json') || path.basename(name) !== name || name.includes('\\')) {
        throw new ProxyError('Select a valid account file.', 'invalid_account', 400);
    }
    return path.join(state.auth_directory, name);
}

export async function initialize(directory, selected) {
    return locked(path.join(directory, 'state.mutex'), async () => {
        const file = path.join(directory, 'proxy.json');
        let state;
        try { state = await readJSON(file); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            state = { key: randomBytes(32).toString('base64url'), port: 18888, lan_enabled: false, enabled: false,
                auth_directory: defaultAuthDirectory, capacity_retry: { ...defaultCapacityRetrySettings }, priority: normalizePrioritySettings() };
        }
        state.capacity_retry = normalizeCapacityRetrySettings(state.capacity_retry);
        state.priority = normalizePrioritySettings(state.priority);
        await fs.mkdir(state.auth_directory, { recursive: true, mode: 0o700 });
        if (selected) {
            accountPath(state, path.basename(selected));
            state.selected_file = path.basename(selected);
        }
        await writeJSON(file, state);
        return state;
    });
}
