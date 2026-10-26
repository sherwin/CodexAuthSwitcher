import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultDirectory, initialize, readJSON, accountPath } from '../proxy/storage.mjs';
import { Credentials, claims, isDeepSeek } from '../proxy/credentials.mjs';
import { upstreamFetch } from '../proxy/server.mjs';

export const refreshIntervalMs = 6 * 60 * 60 * 1000;
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
    return results;
}

export async function runService(options = {}) {
    const interval = options.intervalMs || refreshIntervalMs;
    let stopped = false;
    const stop = () => { stopped = true; };
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, stop);
    while (!stopped) {
        try { await refreshAll(options); }
        catch (error) { (options.log || console.error)(JSON.stringify({ event: 'refresh_all_failed', error: error.message })); }
        if (stopped) break;
        await new Promise(resolve => setTimeout(resolve, interval));
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) runService();
