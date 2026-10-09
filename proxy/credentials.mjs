import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ProxyError, locked, readJSON, writeJSON } from './storage.mjs';

export const legacyClient = 'app_EMoamEEZ73f0CkXaXp7hrann';

export function claims(token) {
    try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); }
    catch { return {}; }
}

export function identity(record) {
    const tokens = record.tokens || {};
    const payload = claims(tokens.id_token || '');
    return [tokens.account_id, payload.sub || payload['https://api.openai.com/auth']?.chatgpt_user_id];
}

export function sameIdentity(a, b) {
    const left = identity(a);
    const right = identity(b);
    return left.every(Boolean) && left.every((value, index) => value === right[index]);
}

export function upstream(record, route) {
    if (record.OPENAI_API_KEY) return { url: `https://api.openai.com/v1/${route}`, token: record.OPENAI_API_KEY };
    const base = record.client_id && record.client_id !== legacyClient
        ? 'https://api.openai.com/v1/' : 'https://chatgpt.com/backend-api/codex/';
    return { url: base + route + (route === 'models' && base.includes('chatgpt.com') ? '?client_version=0.159.2' : ''),
        token: record.tokens?.access_token };
}

export async function responseError(response) {
    let root;
    try { root = await response.json(); } catch { root = {}; }
    const raw = typeof root.error === 'string' ? root.error : root.error?.code;
    const code = String(raw || root.detail?.code || 'upstream_error').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
    const needsLogin = ['invalid_grant', 'refresh_token_reused', 'refresh_token_expired', 'refresh_token_invalidated'].includes(code);
    return new ProxyError(needsLogin ? 'This account needs to sign in again.' : `Upstream failed (HTTP ${response.status}).`,
        code, needsLogin ? 401 : response.status);
}

export class Credentials {
    constructor(directory, authDirectory, fetchUpstream) {
        this.directory = directory;
        this.authDirectory = authDirectory;
        this.fetch = fetchUpstream;
        this.failures = new Map();
    }

    async get(file, { force = false, failedToken } = {}) {
        const initial = await readJSON(file);
        const session = identity(initial).filter(Boolean).join(':') || file;
        const hash = createHash('sha256').update(session).digest('hex');
        return locked(path.join(this.directory, 'locks', hash + '.mutex'), async () => {
            let record = await readJSON(file);
            if (record.OPENAI_API_KEY) return record;
            let tokens = record.tokens || {};
            const expiry = claims(tokens.access_token || '').exp || 0;
            if (failedToken && tokens.access_token !== failedToken) return record;
            if (!force && expiry > Date.now() / 1000 + 300) return record;
            // Reuse a newer copy of the same session before rotating an old duplicate.
            for (const name of await fs.readdir(this.authDirectory)) {
                if (!name.endsWith('.json')) continue;
                const candidate = await readJSON(path.join(this.authDirectory, name)).catch(() => null);
                if (candidate && sameIdentity(record, candidate) &&
                    (claims(candidate.tokens?.access_token || '').exp || 0) > expiry &&
                    (claims(candidate.tokens?.access_token || '').exp || 0) > Date.now() / 1000 + 300) {
                    await writeJSON(file, candidate);
                    return candidate;
                }
            }
            const audience = claims(tokens.id_token || '').aud;
            const client = record.client_id || tokens.client_id ||
                (audience === legacyClient || (Array.isArray(audience) && audience.length === 1 && audience[0] === legacyClient)
                    ? legacyClient : undefined);
            if (!tokens.refresh_token || !client) throw new ProxyError('Missing renewable credentials. Sign in again.', 'login_required', 401);
            const fingerprint = createHash('sha256').update(tokens.refresh_token).digest('hex');
            const previousFailure = this.failures.get(fingerprint);
            if (previousFailure) throw previousFailure;
            const fields = new URLSearchParams({ grant_type: 'refresh_token', client_id: client,
                refresh_token: tokens.refresh_token });
            const legacy = client === legacyClient;
            if (!legacy) fields.set('resource', 'https://api.openai.com/v1');
            const response = await this.fetch(legacy ? 'https://auth.openai.com/oauth/token'
                : 'https://auth.openai.com/api/accounts/oauth/token', { method: 'POST', redirect: 'manual',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: fields, signal: AbortSignal.timeout(30000) });
            if (!response.ok) {
                const error = await responseError(response);
                if (error.status === 401) this.failures.set(fingerprint, error);
                throw error;
            }
            const replacement = await response.json();
            if (typeof replacement.access_token !== 'string' || !replacement.access_token) {
                throw new ProxyError('Invalid renewal response.', 'invalid_token_response', 502);
            }
            const original = record;
            record = structuredClone(record);
            for (const key of ['access_token', 'refresh_token', 'id_token']) {
                if (typeof replacement[key] === 'string' && replacement[key]) record.tokens[key] = replacement[key];
            }
            if (replacement.id_token && identity(original).every(Boolean) && !sameIdentity(original, record)) {
                throw new ProxyError('Renewal returned a different identity.', 'identity_mismatch', 502);
            }
            record.client_id = client;
            record.last_refresh = new Date().toISOString();
            // Save the canonical file first. A failed duplicate write cannot discard the new token.
            await writeJSON(file, record);
            for (const name of await fs.readdir(this.authDirectory)) {
                const other = path.join(this.authDirectory, name);
                if (!name.endsWith('.json') || other === file) continue;
                const candidate = await readJSON(other).catch(() => null);
                if (candidate && candidate.tokens?.refresh_token === tokens.refresh_token && sameIdentity(original, candidate)) {
                    await writeJSON(other, record);
                }
            }
            return record;
        });
    }
}

export async function syncActive(authDirectory, codexDirectory) {
    const active = await readJSON(path.join(codexDirectory, 'auth.json')).catch(() => null);
    if (!active || !identity(active).every(Boolean)) return;
    for (const name of await fs.readdir(authDirectory)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(authDirectory, name);
        const backup = await readJSON(file).catch(() => null);
        if (backup && sameIdentity(active, backup) &&
            (claims(active.tokens?.access_token || '').exp || 0) > (claims(backup.tokens?.access_token || '').exp || 0)) {
            await writeJSON(file, active);
        }
    }
}
