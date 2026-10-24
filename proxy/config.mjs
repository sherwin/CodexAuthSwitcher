import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import TOML from '@iarna/toml';
import { atomicWrite, locked, readJSON, writeJSON, provider, codexDirectory, ProxyError } from './storage.mjs';
import { randomUUID } from 'node:crypto';

const begin = '# BEGIN CodexAuthSwitcher local proxy';
const end = '# END CodexAuthSwitcher local proxy';
const hash = value => createHash('sha256').update(value).digest('hex');

// Read only rollout metadata, never rewrite conversation history or its SQLite index.
export async function conversationProviders(home) {
    const providers = new Set(['openai', provider]);
    async function visit(directory) {
        const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
            if (error.code === 'ENOENT') return [];
            throw error;
        });
        for (const entry of entries) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(file);
            else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                const handle = await fs.open(file, 'r');
                try {
                    let header = '';
                    const buffer = Buffer.alloc(8192);
                    while (!header.includes('\n') && header.length < 1024 * 1024) {
                        const { bytesRead } = await handle.read(buffer);
                        if (!bytesRead) break;
                        header += buffer.subarray(0, bytesRead).toString('utf8');
                    }
                    const line = header.split('\n', 1)[0];
                    if (!line) continue;
                    let metadata;
                    try { metadata = JSON.parse(line); } catch {
                        throw new ProxyError('会话元数据无法读取，未覆盖配置。', 'invalid_session_metadata', 409);
                    }
                    const id = metadata.type === 'session_meta' && metadata.payload?.model_provider;
                    if (typeof id === 'string' && id) providers.add(id);
                } finally { await handle.close(); }
            }
        }
    }
    await visit(path.join(home, 'sessions'));
    await visit(path.join(home, 'archived_sessions'));
    return [...providers].sort();
}

function extractProviders(config) {
    let clean = '';
    let sections = '';
    for (const section of config.split(/(?=^[ \t]*\[)/m)) {
        const header = section.split('\n', 1)[0];
        let isProvider = false;
        if (/^[ \t]*\[/.test(header)) {
            try { isProvider = !!TOML.parse(header + '\n').model_providers; } catch { /* Validated by caller. */ }
        }
        if (isProvider) sections += section;
        else clean += section;
    }
    if (TOML.parse(clean).model_providers) {
        throw new ProxyError('请将内联 model_providers 改成独立 TOML 表后再应用。', 'invalid_config', 409);
    }
    return { clean, sections };
}

export async function inspectConfiguration(state, config = path.join(codexDirectory, 'config.toml')) {
    try {
        const original = await fs.readFile(config, 'utf8');
        const parsed = TOML.parse(original);
        const auth = await fs.readFile(path.join(path.dirname(config), 'auth.json'), 'utf8');
        const credentials = JSON.parse(auth);
        const local = parsed.model_providers?.[provider];
        const custom = state.mode === 'custom';
        const url = `http://127.0.0.1:${state.port}/v1`;
        const expectedUrl = custom ? state.custom_base_url : url;
        const matches = parsed.model_provider === provider &&
            parsed.openai_base_url === expectedUrl && parsed.forced_login_method === 'api' &&
            parsed.cli_auth_credentials_store === 'file' && credentials.OPENAI_API_KEY === state.key &&
            credentials.auth_mode === 'apikey' && !credentials.tokens &&
            (state.covered_providers || []).every(id => id === 'openai' ||
                (parsed.model_providers?.[id]?.base_url === url &&
                    parsed.model_providers[id].experimental_bearer_token === state.key &&
                    parsed.model_providers[id].requires_openai_auth === false)) &&
            local?.base_url === url &&
            local?.experimental_bearer_token === state.key && local?.wire_api === 'responses' &&
            local?.requires_openai_auth === false && local?.supports_websockets === false;
        const customMatches = custom && parsed.model_provider === 'openai' && parsed.openai_base_url === expectedUrl &&
            parsed.forced_login_method === 'api' && parsed.cli_auth_credentials_store === 'file' &&
            typeof credentials.OPENAI_API_KEY === 'string' && hash(credentials.OPENAI_API_KEY) === state.custom_key_hash;
        return { matches: !!(custom ? customMatches : matches), fingerprint: hash(original + '\0' + auth), provider: parsed.model_provider || 'openai' };
    } catch (error) {
        return { matches: false, error: error.code === 'ENOENT' ? 'config_missing' : 'config_unreadable' };
    }
}

export async function configureCustom(directory, baseUrl, apiKey,
    config = path.join(codexDirectory, 'config.toml'), auth = path.join(codexDirectory, 'auth.json')) {
    let parsedUrl;
    try { parsedUrl = new URL(String(baseUrl)); } catch { throw new ProxyError('Base URL 格式无效。', 'invalid_base_url', 400); }
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
        throw new ProxyError('Base URL 只支持 http/https，且不能包含账号密码。', 'invalid_base_url', 400);
    }
    const normalizedUrl = parsedUrl.toString().replace(/\/$/, '');
    if (!normalizedUrl.endsWith('/v1')) parsedUrl.pathname = `${parsedUrl.pathname.replace(/\/$/, '')}/v1`;
    const url = parsedUrl.toString().replace(/\/$/, '');
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new ProxyError('请输入局域网服务 Key。', 'invalid_api_key', 400);
    return locked(path.join(directory, 'state.mutex'), async () => {
        const statePath = path.join(directory, 'proxy.json');
        const state = await readJSON(statePath);
        const original = await fs.readFile(config, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
        const parsed = TOML.parse(original);
        const start = original.indexOf(begin); const finish = original.indexOf(end);
        if ((start < 0) !== (finish < 0) || (start >= 0 && finish < start))
            throw new ProxyError('代理配置标记不完整，请先检查 config.toml。', 'invalid_config', 409);
        const clean = start < 0 ? original : original.slice(0, start) + original.slice(finish + end.length);
        const firstTable = clean.search(/^\s*\[/m);
        const top = firstTable < 0 ? clean : clean.slice(0, firstTable);
        const rest = firstTable < 0 ? '' : clean.slice(firstTable);
        const updated = 'model_provider = "openai"\nopenai_base_url = ' + JSON.stringify(url) + '\n' +
            'forced_login_method = "api"\ncli_auth_credentials_store = "file"\n' +
            top.replace(/^\s*(?:model_provider|openai_base_url|forced_login_method|cli_auth_credentials_store)\s*=.*(?:\n|$)/gm, '') + rest +
            (state.key_provider_sections || '') + '\n';
        TOML.parse(updated);
        const backup = path.join(directory, `config-before-custom-${randomUUID()}.toml`);
        await atomicWrite(backup, original);
        const oldAuth = await fs.readFile(auth).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (oldAuth) await atomicWrite(backup + '.auth.json', oldAuth);
        try {
            await writeJSON(auth, { auth_mode: 'apikey', OPENAI_API_KEY: apiKey.trim() });
            await atomicWrite(config, updated);
            state.config_backup = backup; state.config_path = config; state.installed_config_hash = hash(updated);
            state.key_auth_backup = oldAuth ? backup + '.auth.json' : null;
            state.custom_base_url = url; state.custom_key_hash = hash(apiKey.trim());
            state.enabled = true; state.mode = 'custom';
            await writeJSON(statePath, state);
        } catch (error) {
            await atomicWrite(config, original);
            if (oldAuth) await atomicWrite(auth, oldAuth); else await fs.unlink(auth).catch(() => {});
            throw error;
        }
    });
}

export async function configure(directory, config = path.join(codexDirectory, 'config.toml')) {
    await locked(path.join(directory, 'state.mutex'), async () => {
        const statePath = path.join(directory, 'proxy.json');
        const state = await readJSON(statePath);
        const original = await fs.readFile(config, 'utf8').catch(error => {
            if (error.code === 'ENOENT') return '';
            throw error;
        });
        const parsed = TOML.parse(original);
        const covered = [...new Set([...(await conversationProviders(path.dirname(config))),
            ...Object.keys(parsed.model_providers || {}), ...(state.covered_providers || []), parsed.model_provider || 'openai'])].sort();
        if (covered.some(id => ['ollama', 'lmstudio', 'amazon-bedrock', 'amazon-bedrock-runtime', 'ollama-chat'].includes(id))) {
            throw new ProxyError('检测到不可直接覆盖的内置第三方 provider，未修改配置。', 'unsupported_session_provider', 409);
        }
        if ((await inspectConfiguration(state, config)).matches && original.includes(begin) &&
            JSON.stringify(covered) === JSON.stringify(state.covered_providers)) {
            state.enabled = true;
            state.mode = 'key';
            await writeJSON(statePath, state);
            return;
        }
        const start = original.indexOf(begin);
        const finish = original.indexOf(end);
        if ((start < 0) !== (finish < 0) || (start >= 0 && finish < start)) {
            throw new ProxyError('代理配置标记不完整，请检查 config.toml。', 'invalid_config', 409);
        }
        if (parsed.model_providers?.[provider] && start < 0) {
            throw new ProxyError('Local provider already exists. Restore the previous settings first.');
        }
        const unmanaged = start < 0 ? original : original.slice(0, start) + original.slice(finish + end.length);
        const { clean, sections } = extractProviders(unmanaged);
        const firstTable = clean.search(/^\s*\[/m);
        const top = firstTable < 0 ? clean : clean.slice(0, firstTable);
        const rest = firstTable < 0 ? '' : clean.slice(firstTable);
        const url = `http://127.0.0.1:${state.port}/v1`;
        const updated = `model_provider = "${provider}"\nopenai_base_url = ${JSON.stringify(url)}\n` +
            'forced_login_method = "api"\ncli_auth_credentials_store = "file"\n' +
            top.replace(/^\s*(?:model_provider|openai_base_url|forced_login_method|cli_auth_credentials_store)\s*=.*(?:\n|$)/gm, '') + rest +
            `\n\n${begin}\n` + covered.filter(id => id !== 'openai').map(id =>
            `[model_providers.${id === provider ? id : JSON.stringify(id)}]\n` +
            `name = "Auth Switcher Local"\nbase_url = "http://127.0.0.1:${state.port}/v1"\n` +
            `experimental_bearer_token = ${JSON.stringify(state.key)}\n` +
            'wire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n' +
            'request_max_retries = 0\nstream_max_retries = 0\n').join('\n') + `${end}\n`;
        TOML.parse(updated);
        const backup = path.join(directory, `config-before-proxy-${randomUUID()}.toml`);
        await atomicWrite(backup, original);
        const auth = path.join(path.dirname(config), 'auth.json');
        const oldAuth = await fs.readFile(auth).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (oldAuth) await atomicWrite(backup + '.auth.json', oldAuth);
        state.key_provider_sections = (state.key_provider_sections || '') + sections;
        state.covered_providers = covered;
        state.key_auth_backup = oldAuth ? backup + '.auth.json' : null;
        state.config_backup = backup;
        state.config_path = config;
        state.installed_config_hash = hash(updated);
        state.enabled = true;
        state.mode = 'key';
        delete state.custom_base_url; delete state.custom_key_hash;
        try {
            await writeJSON(auth, { auth_mode: 'apikey', OPENAI_API_KEY: state.key });
            await atomicWrite(config, updated);
            // Do not report a mode change until both active files were written.
            await writeJSON(statePath, state);
        } catch (error) {
            await atomicWrite(config, original);
            if (oldAuth) await atomicWrite(auth, oldAuth);
            else await fs.unlink(auth).catch(() => {});
            throw error;
        }
    });
}

export async function configureAuthFile(directory, record, config = path.join(codexDirectory, 'config.toml'),
    auth = path.join(codexDirectory, 'auth.json'), selected) {
    if (!record.tokens?.access_token || !record.tokens?.refresh_token || record.OPENAI_API_KEY) {
        throw new ProxyError('请选择有效的 ChatGPT 授权文件。', 'invalid_auth_file', 400);
    }
    return locked(path.join(directory, 'state.mutex'), async () => {
        const statePath = path.join(directory, 'proxy.json');
        const state = await readJSON(statePath);
        const original = await fs.readFile(config, 'utf8').catch(error => {
            if (error.code === 'ENOENT') return '';
            throw error;
        });
        TOML.parse(original);
        const start = original.indexOf(begin);
        const finish = original.indexOf(end);
        if ((start < 0) !== (finish < 0) || (start >= 0 && finish < start)) {
            throw new ProxyError('代理配置标记不完整，请先检查 config.toml。', 'invalid_config', 409);
        }
        const clean = start < 0 ? original : original.slice(0, start) + original.slice(finish + end.length);
        const firstTable = clean.search(/^\s*\[/m);
        const top = firstTable < 0 ? clean : clean.slice(0, firstTable);
        const rest = firstTable < 0 ? '' : clean.slice(firstTable);
        const updated = 'model_provider = "openai"\nforced_login_method = "chatgpt"\ncli_auth_credentials_store = "file"\n' +
            top.replace(/^\s*(?:model_provider|openai_base_url|forced_login_method|cli_auth_credentials_store)\s*=.*(?:\n|$)/gm, '') + rest +
            (state.key_provider_sections || '');
        TOML.parse(updated);
        const oldAuth = await fs.readFile(auth).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        const prefix = path.join(directory, `before-auth-file-${randomUUID()}`);
        await atomicWrite(prefix + '.toml', original);
        if (oldAuth) await atomicWrite(prefix + '.auth.json', oldAuth);
        // Both originals are recoverable before either active file changes.
        try {
            await writeJSON(auth, { ...record, auth_mode: 'chatgpt', OPENAI_API_KEY: null });
            await atomicWrite(config, updated);
            state.enabled = false;
            state.mode = 'auth_file';
            state.auth_file_backup = prefix;
            delete state.key_provider_sections;
            delete state.covered_providers;
            delete state.custom_base_url; delete state.custom_key_hash;
            if (selected) state.codex_auth_file = selected;
            await writeJSON(statePath, state);
        } catch (error) {
            await atomicWrite(config, original);
            if (oldAuth) await atomicWrite(auth, oldAuth);
            else await fs.unlink(auth).catch(() => {});
            throw error;
        }
    });
}

export async function unconfigure(directory) {
    await locked(path.join(directory, 'state.mutex'), async () => {
        const statePath = path.join(directory, 'proxy.json');
        const state = await readJSON(statePath);
        state.enabled = false;
        state.mode = 'unconfigured';
        delete state.custom_base_url; delete state.custom_key_hash;
        await writeJSON(statePath, state);
    });
}

export async function restore(directory) {
    await locked(path.join(directory, 'state.mutex'), async () => {
        const statePath = path.join(directory, 'proxy.json');
        const state = await readJSON(statePath);
        const current = await fs.readFile(state.config_path);
        if (hash(current) !== state.installed_config_hash) {
            throw new ProxyError('Codex settings changed since setup. Restore the saved backup manually to preserve your edits.');
        }
        await atomicWrite(state.config_path, await fs.readFile(state.config_backup));
        if (state.key_auth_backup) await atomicWrite(path.join(path.dirname(state.config_path), 'auth.json'),
            await fs.readFile(state.key_auth_backup));
        else await fs.unlink(path.join(path.dirname(state.config_path), 'auth.json')).catch(error => {
            if (error.code !== 'ENOENT') throw error;
        });
        state.enabled = false;
        delete state.mode;
        delete state.custom_base_url; delete state.custom_key_hash;
        await writeJSON(statePath, state);
    });
}
