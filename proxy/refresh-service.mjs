import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultDirectory, initialize, readJSON, accountPath } from './storage.mjs';
import { Credentials, claims, isDeepSeek } from './credentials.mjs';
import { upstreamFetch } from './server.mjs';

export const refreshIntervalMs = 6 * 60 * 60 * 1000;
export const directoryCheckIntervalMs = 60 * 1000;
export const tokenRefreshWindowSeconds = 86400;

export async function accountFiles(authDirectory, fsApi = fs) {
    const names = await fsApi.readdir(authDirectory);
    return names.filter(name => name.endsWith('.json')).sort();
}

function expiry(record) { return claims(record?.tokens?.access_token || '').exp || 0; }

export async function refreshAll({ directory = defaultDirectory, fsApi = fs,
    fetchUpstream = upstreamFetch(), log = console.log } = {}) {
    await initialize(directory);
    const state = await readJSON(path.join(directory, 'proxy.json'));
    const authDirectory = state.auth_directory;
    const credentials = new Credentials(directory, authDirectory, fetchUpstream);
    const results = [];
    for (const name of await accountFiles(authDirectory, fsApi)) {
        const file = accountPath({ auth_directory: authDirectory }, name);
        const before = await readJSON(file).catch(() => null);
        if (!before || before.OPENAI_API_KEY || isDeepSeek(before)) {
            results.push({ name, status: 'skipped', reason: 'non-renewable' }); continue;
        }
        try {
            const after = await credentials.get(file);
            const changed = expiry(after) !== expiry(before);
            results.push({ name, status: changed ? 'refreshed' : 'valid', expiresAt: expiry(after) });
        } catch (error) {
            results.push({ name, status: 'error', code: error.code || 'refresh_failed', error: error.message });
        }
    }
    log(JSON.stringify({ event: 'refresh_all', results: results.map(({ name, status, code, reason }) => ({ name, status, code, reason })) }));
    return { authDirectory, results };
}

async function waitFor(ms, signal) {
    if (signal?.aborted) return false;
    await new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
    });
    return !signal?.aborted;
}

export async function runService(options = {}) {
    const interval = options.intervalMs || refreshIntervalMs;
    const signal = options.signal;
    const refresh = options.refreshAll || refreshAll;
    let activeDirectory;
    let nextRefreshAt = 0;
    while (!signal?.aborted) {
        try {
            const state = await readJSON(path.join(options.directory || defaultDirectory, 'proxy.json'));
            if (state.auth_directory !== activeDirectory) {
                activeDirectory = state.auth_directory;
                nextRefreshAt = 0;
                (options.log || console.log)(JSON.stringify({ event: 'refresh_directory_changed', authDirectory: activeDirectory }));
            }
            if (Date.now() >= nextRefreshAt) {
                const refreshed = await refresh(options);
                activeDirectory = refreshed.authDirectory;
                nextRefreshAt = Date.now() + interval;
            }
        } catch (error) {
            (options.log || console.error)(JSON.stringify({ event: 'refresh_all_failed', error: error.message }));
        }
        if (!(await waitFor(Math.max(1000, Math.min(directoryCheckIntervalMs, nextRefreshAt - Date.now())), signal))) break;
    }
}

export function createRefreshService(options = {}) {
    let controller;
    let task;
    return {
        start() {
            if (task) return;
            controller = new AbortController();
            task = runService({ ...options, signal: controller.signal });
            task.catch(error => (options.log || console.error)(JSON.stringify({ event: 'refresh_service_failed', error: error.message })));
        },
        async stop() {
            if (!task) return;
            controller.abort();
            await task;
            task = undefined;
            controller = undefined;
        },
    };
}
