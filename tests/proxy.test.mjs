import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';
import { createGateway } from '../proxy/server.mjs';
import { Credentials, legacyClient } from '../proxy/credentials.mjs';
import { writeJSON, readJSON } from '../proxy/storage.mjs';
import { configure, configureAuthFile, unconfigure, restore, inspectConfiguration } from '../proxy/config.mjs';
import { curlCommand } from '../proxy/curl.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { changeNetwork, isPrivateAddress, lanAddresses, validateNetwork, shareHost } from '../proxy/network.mjs';
import http from 'node:http';
import { collectResponse } from '../proxy/responses.mjs';
import { TokenStatistics, beijingTime, usageAccount, normalizedUsage } from '../proxy/statistics.mjs';

const jwt = payload => 'header.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.signature';
const record = (account, expires = Date.now() / 1000 + 3600) => ({ auth_mode: 'chatgpt', tokens: {
    access_token: jwt({ exp: expires, account }), refresh_token: 'refresh-' + account, account_id: account,
    id_token: jwt({ sub: 'user-' + account, aud: [legacyClient] }) } });

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-proxy-test-'));
    const auth = path.join(directory, 'auth');
    await fs.mkdir(auth);
    await writeJSON(path.join(auth, 'a.json'), record('a'));
    await writeJSON(path.join(auth, 'b.json'), record('b'));
    const state = { key: 'local-test-key', port: 0, enabled: false, selected_file: 'a.json', auth_directory: auth };
    await writeJSON(path.join(directory, 'proxy.json'), state);
    const gateways = [];
    t.after(async () => {
        for (const gateway of gateways) await gateway.close();
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { directory, auth, state, gateways };
}

async function gatewayFixture(t, fetchUpstream, options = {}) {
    const data = await fixture(t);
    const gateway = await createGateway(data.directory, { fetchUpstream, codexHome: data.directory, ...options });
    data.gateways.push(gateway);
    t.after(() => gateway.close());
    const base = 'http://127.0.0.1:' + gateway.server.address().port;
    const call = (route, body, headers = {}) => fetch(base + route, {
        method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer local-test-key', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body) });
    return { ...data, gateway, call, base };
}

test('loopback binding, local authentication, browser origin rejection, and route allowlist', async t => {
    let calls = 0;
    const f = await gatewayFixture(t, async () => { calls++; throw new Error('unexpected upstream'); });
    assert.equal(f.gateway.server.address().address, '127.0.0.1');
    assert.equal((await fetch(f.base + '/health')).status, 401);
    assert.equal((await f.call('/health', undefined, { Origin: 'http://attacker.example' })).status, 401);
    assert.equal((await f.call('/health')).status, 200);
    assert.equal((await f.call('/v1/arbitrary')).status, 404);
    assert.equal((await f.call('/v1/models?url=https://example.com')).status, 404);
    assert.equal((await f.call('/admin/select', { name: '../a.json' })).status, 400);
    assert.equal(calls, 0);
});

test('switch during a live stream pins the existing request and routes the next request to B', async t => {
    const targets = [];
    let finishFirst;
    let first = true;
    const f = await gatewayFixture(t, async (url, options) => {
        if (url.includes('/wham/usage')) return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
        if (url.includes('/accounts/check')) return Response.json({ accounts: {} });
        const account = options.headers['ChatGPT-Account-Id'];
        targets.push({ account, authorization: options.headers.Authorization, url, body: JSON.parse(options.body) });
        if (first) {
            first = false;
            return new Response(new ReadableStream({ start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"account":"a","partial":true}\n\n'));
                finishFirst = () => { controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","account":"a"}\n\n')); controller.close(); };
            } }), { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'upstream-test' } });
        }
        return new Response('data: {"type":"response.completed","account":"b"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const old = await f.call('/v1/responses', { model: 'test', input: [], store: true, stream: true });
    assert.equal(old.headers.get('x-request-id'), 'upstream-test');
    const reader = old.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /partial/);
    assert.equal((await f.call('/health')).status, 200);
    assert.equal((await f.call('/admin/select', { name: 'b.json' })).status, 200);
    const next = await f.call('/v1/responses', { model: 'test', input: [], stream: true });
    assert.match(await next.text(), /"account":"b"/);
    finishFirst();
    assert.match(new TextDecoder().decode((await reader.read()).value), /"account":"a"/);
    assert.equal(targets[0].account, 'a');
    assert.equal(targets[1].account, 'b');
    assert.notEqual(targets[0].authorization, 'Bearer local-test-key');
    assert.equal(targets[0].body.store, false);
    assert.equal(targets[0].body.stream, true);
    assert.match(targets[0].url, /^https:\/\/chatgpt.com\/backend-api\/codex\/responses$/);
});

test('failed account validation preserves the existing selection', async t => {
    const f = await gatewayFixture(t, async () => Response.json({ error: { code: 'account_deactivated' } }, { status: 403 }));
    const response = await f.call('/admin/select', { name: 'b.json' });
    assert.equal(response.status, 403);
    assert.equal((await readJSON(path.join(f.directory, 'proxy.json'))).selected_file, 'a.json');
});

test('concurrent renewals rotate once and persist all replacement tokens', async t => {
    const f = await fixture(t);
    const file = path.join(f.auth, 'a.json');
    await writeJSON(file, record('a', 0));
    let count = 0;
    const credentials = new Credentials(f.directory, f.auth, async (url, options) => {
        count++;
        assert.equal(url, 'https://auth.openai.com/oauth/token');
        assert.equal(options.body.get('resource'), null);
        assert.equal(options.body.get('client_id'), legacyClient);
        await new Promise(resolve => setTimeout(resolve, 50));
        return Response.json({ access_token: jwt({ exp: Date.now() / 1000 + 3600 }),
            refresh_token: 'rotated', id_token: record('a').tokens.id_token });
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => credentials.get(file)));
    assert.equal(count, 1);
    assert.ok(results.every(result => result.tokens.refresh_token === 'rotated'));
    const saved = await readJSON(file);
    assert.equal(saved.client_id, legacyClient);
    assert.equal(saved.tokens.account_id, 'a');
    assert.equal(saved.tokens.refresh_token, 'rotated');
    if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('terminal renewal error is not retried and is sanitized', async t => {
    const f = await fixture(t);
    const file = path.join(f.auth, 'a.json');
    await writeJSON(file, record('a', 0));
    let attempts = 0;
    const credentials = new Credentials(f.directory, f.auth, async () => {
        attempts++;
        return Response.json({ error: 'invalid_grant', error_description: 'secret-token-do-not-leak' }, { status: 400 });
    });
    for (let i = 0; i < 2; i++) await assert.rejects(credentials.get(file), error =>
        error.code === 'invalid_grant' && !error.message.includes('secret-token'));
    assert.equal(attempts, 1);
    assert.equal((await readJSON(file)).tokens.refresh_token, 'refresh-a');
});

test('config preserves comments and settings, is idempotent, and rollback protects later edits', async t => {
    const f = await fixture(t);
    const config = path.join(f.directory, 'config.toml');
    const original = '# user comment\nmodel = "gpt-test"\nmodel_provider = "other"\n\n[projects."/work"]\ntrust_level = "trusted"\n';
    await fs.writeFile(config, original);
    await configure(f.directory, config);
    const installed = await fs.readFile(config, 'utf8');
    const parsed = TOML.parse(installed);
    assert.equal(parsed.model, 'gpt-test');
    assert.equal(parsed.projects['/work'].trust_level, 'trusted');
    assert.equal(parsed.model_provider, 'auth_switcher_local');
    assert.match(installed, /# user comment/);
    await configure(f.directory, config);
    assert.equal(await fs.readFile(config, 'utf8'), installed);
    await fs.appendFile(config, '\n# later edit\n');
    await assert.rejects(restore(f.directory), /settings changed/);
    await fs.writeFile(config, installed);
    await restore(f.directory);
    assert.equal(await fs.readFile(config, 'utf8'), original);
});

test('key setup repairs its managed provider and preserves unrelated configuration', async t => {
    const f = await fixture(t);
    const config = path.join(f.directory, 'config.toml');
    await fs.writeFile(config, 'model = "gpt-test"\n# personal setting\n');
    await configure(f.directory, config);
    const changed = (await fs.readFile(config, 'utf8')).replace('requires_openai_auth = false', 'requires_openai_auth = true')
        .replace('model_provider = "auth_switcher_local"', 'model_provider = "openai"')
        .replace('forced_login_method = "api"', 'forced_login_method = "chatgpt"');
    await fs.writeFile(config, changed);
    assert.equal((await inspectConfiguration(f.state, config)).matches, false);
    await configure(f.directory, config);
    assert.equal((await inspectConfiguration(f.state, config)).matches, true);
    const text = await fs.readFile(config, 'utf8');
    assert.match(text, /# personal setting/);
    assert.equal(TOML.parse(text).model, 'gpt-test');
    assert.equal(text.split('[model_providers.auth_switcher_local]').length, 2);
    const state = await readJSON(path.join(f.directory, 'proxy.json'));
    assert.equal(await fs.readFile(state.config_backup, 'utf8'), changed);
});

test('connection verification requires local Codex inference, invalidates on config changes and resets on apply', async t => {
    let fail = false;
    const f = await gatewayFixture(t, async () => fail ? Response.json({ error: 'failed' }, { status: 500 }) :
        Response.json({ id: 'response-test', usage: { input_tokens: 1, output_tokens: 2 } }));
    await writeJSON(path.join(f.auth, 'a.json'), { OPENAI_API_KEY: 'upstream-test-key' });
    const status = async () => (await (await f.call('/health')).json()).codex_connection;
    await f.call('/admin/configure', {});
    assert.equal((await status()).status, 'pending');
    await f.call('/v1/responses', { input: 'test' });
    assert.equal((await status()).status, 'pending');
    const headers = { 'User-Agent': 'codex_cli_rs/1.0' };
    fail = true;
    await f.call('/v1/responses', { input: 'test' }, headers);
    assert.equal((await status()).status, 'pending');
    fail = false;
    await f.call('/v1/responses', { input: 'test' }, headers);
    assert.equal((await status()).status, 'verified');
    assert.ok((await status()).verified_at);
    const config = path.join(f.directory, 'config.toml');
    await fs.appendFile(config, '\n# external edit\n');
    assert.equal((await status()).status, 'pending');
    await fs.writeFile(config, (await fs.readFile(config, 'utf8')).replace('requires_openai_auth = false', 'requires_openai_auth = true'));
    assert.equal((await status()).status, 'config_mismatch');
    await f.call('/admin/configure', {});
    assert.equal((await status()).status, 'pending');
    const health = JSON.stringify(await (await f.call('/health')).json());
    assert.ok(!health.includes('local-test-key'));
    assert.ok(!health.includes('upstream-test-key'));
});

test('usage includes membership dates and preserves quotas when subscription lookup fails', async t => {
    let fail = false;
    const f = await gatewayFixture(t, async url => url.includes('/wham/usage') ?
        Response.json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 10 } } }) :
        fail ? Response.json({}, { status: 403 }) : Response.json({ accounts: { a: { entitlement: {
            expires_at: '2026-10-17T00:00:00Z', renews_at: '2026-10-16T18:00:00Z', has_active_subscription: true } } } }));
    const first = await (await f.call('/admin/usage', { name: 'a.json' })).json();
    assert.equal(first.subscriptionExpiry, '2026-10-17T00:00:00.000Z');
    assert.equal(first.subscription.renewsAt, '2026-10-16T18:00:00.000Z');
    fail = true;
    const second = await (await f.call('/admin/usage', { name: 'a.json' })).json();
    assert.equal(second.data.rate_limit.primary_window.used_percent, 10);
    assert.equal(second.subscription.status, 'failed');
    assert.equal(second.subscriptionExpiry, null);
});

test('desktop membership transport is independent from Node inference and quota transport', async t => {
    let lookups = 0;
    const f = await gatewayFixture(t, async url => {
        assert.ok(!url.includes('/accounts/check'));
        return Response.json({ plan_type: 'plus' });
    }, { fetchSubscription: async (url, options) => {
        lookups++;
        assert.ok(url.startsWith('https://chatgpt.com/backend-api/accounts/check/'));
        assert.equal(options.redirect, 'manual');
        assert.equal(options.headers['ChatGPT-Account-Id'], 'a');
        return Response.json({ accounts: { a: { entitlement: { expires_at: '2026-10-17T00:00:00Z' } } } });
    } });
    const result = await (await f.call('/admin/usage', { name: 'a.json' })).json();
    assert.equal(lookups, 1);
    assert.equal(result.subscription.status, 'available');
});

test('ordinary permission 401 does not rotate a valid OAuth token', async t => {
    let count = 0;
    const f = await gatewayFixture(t, async () => {
        count++;
        return Response.json({ error: { code: null, message: 'Missing scopes' } }, { status: 401 });
    });
    assert.equal((await f.call('/v1/responses', { model: 'test', input: [] })).status, 401);
    assert.equal(count, 1);
});

test('auth file mode preserves unrelated edits, backs up credentials, and returns to key mode', async t => {
    const f = await fixture(t);
    const config = path.join(f.directory, 'config.toml');
    const auth = path.join(f.directory, 'auth.json');
    await fs.writeFile(config, '# keep\nmodel = "gpt-test"\n\n[projects."/work"]\ntrust_level = "trusted"\n');
    await writeJSON(auth, record('old'));
    await configure(f.directory, config);
    await fs.appendFile(config, '\n# later user edit\n');
    await configureAuthFile(f.directory, record('b'), config, auth, 'b.json');
    let text = await fs.readFile(config, 'utf8');
    const parsed = TOML.parse(text);
    assert.equal(parsed.model_provider, 'openai');
    assert.equal(parsed.forced_login_method, 'chatgpt');
    assert.equal(parsed.cli_auth_credentials_store, 'file');
    assert.equal(parsed.projects['/work'].trust_level, 'trusted');
    assert.match(text, /# later user edit/);
    assert.ok(!text.includes('experimental_bearer_token'));
    assert.equal((await readJSON(auth)).tokens.account_id, 'b');
    const state = await readJSON(path.join(f.directory, 'proxy.json'));
    assert.equal(state.mode, 'auth_file');
    assert.equal(state.selected_file, 'a.json');
    assert.equal(state.codex_auth_file, 'b.json');
    assert.equal((await readJSON(state.auth_file_backup + '.auth.json')).OPENAI_API_KEY, f.state.key);
    await configure(f.directory, config);
    text = await fs.readFile(config, 'utf8');
    assert.equal(TOML.parse(text).model_provider, 'auth_switcher_local');
    assert.equal(TOML.parse(text).forced_login_method, 'api');
    assert.equal((await readJSON(auth)).OPENAI_API_KEY, f.state.key);
});

test('Codex connection settings and proxy exit remain independent, including live requests', async t => {
    let finishStream;
    const f = await gatewayFixture(t, async url => !String(url).endsWith('/responses')
        ? Response.json({ rate_limit: {} }) : new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
            finishStream = () => { controller.enqueue(new TextEncoder().encode(completedSSE(finalResponse))); controller.close(); };
        } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    await fs.writeFile(path.join(f.directory, 'config.toml'), 'model = "test"\n');
    const stream = await f.call('/v1/responses', { model: 'test', input: 'hello', stream: true });
    assert.equal((await f.call('/admin/auth-file', { name: 'b.json' })).status, 200);
    let health = await (await f.call('/health')).json();
    assert.equal(health.proxy_running, true);
    assert.equal(health.codex_mode, 'auth_file');
    assert.equal(health.codex_auth_file, 'b.json');
    assert.equal(health.selected_file, 'a.json');
    assert.equal(health.in_flight, 1);
    const auth = await fs.readFile(path.join(f.directory, 'auth.json'), 'utf8');
    assert.equal((await f.call('/admin/select', { name: 'b.json' })).status, 200);
    assert.equal((await f.call('/admin/select', { name: 'a.json' })).status, 200);
    assert.equal(await fs.readFile(path.join(f.directory, 'auth.json'), 'utf8'), auth);
    assert.equal((await f.call('/admin/configure', {})).status, 200);
    health = await (await f.call('/health')).json();
    assert.equal(health.codex_mode, 'key');
    assert.equal(health.proxy_running, true);
    assert.equal(health.selected_file, 'a.json');
    finishStream();
    await stream.text();
});

test('curl generation does not require any Codex configuration or authentication mode', () => {
    const state = { port: 18888, key: 'private-key', mode: 'auth_file', enabled: false };
    const command = curlCommand(state, 'not valid TOML [');
    assert.match(command, /127\.0\.0\.1:18888\/v1\/responses/);
    assert.match(command, /Bearer private-key/);
    assert.match(curlCommand({ ...state, mode: undefined }), /gpt-6\.1-sol/);
    assert.ok(!curlCommand(state, '', { masked: true }).includes('private-key'));
});

test('empty mode preserves Codex files and proxy route, persists, and can reconnect to the existing Key config', async t => {
    const f = await fixture(t);
    const config = path.join(f.directory, 'config.toml');
    const auth = path.join(f.directory, 'auth.json');
    const original = '# existing settings\nmodel = "test"\n';
    await fs.writeFile(config, original);
    await writeJSON(auth, record('existing'));
    const authBefore = await fs.readFile(auth, 'utf8');
    await unconfigure(f.directory);
    assert.equal(await fs.readFile(config, 'utf8'), original);
    assert.equal(await fs.readFile(auth, 'utf8'), authBefore);
    await configure(f.directory, config);
    const installed = await fs.readFile(config, 'utf8');
    const installedAuth = await fs.readFile(auth, 'utf8');
    await unconfigure(f.directory);
    assert.equal(await fs.readFile(config, 'utf8'), installed);
    assert.equal(await fs.readFile(auth, 'utf8'), installedAuth);
    const state = await readJSON(path.join(f.directory, 'proxy.json'));
    assert.equal(state.mode, 'unconfigured');
    assert.equal(state.selected_file, 'a.json');
    await configure(f.directory, config);
    assert.equal((await readJSON(path.join(f.directory, 'proxy.json'))).mode, 'key');
    assert.equal(await fs.readFile(config, 'utf8'), installed);
    await restore(f.directory);
    assert.equal(await fs.readFile(config, 'utf8'), original);
});

test('empty mode remains available with a live independent proxy', async t => {
    const f = await gatewayFixture(t, async () => Response.json({ rate_limit: {} }));
    assert.equal((await (await f.call('/health')).json()).codex_mode, 'unconfigured');
    assert.equal((await f.call('/admin/unconfigure', {})).status, 200);
    const health = await (await f.call('/health')).json();
    assert.equal(health.proxy_running, true);
    assert.equal(health.codex_mode, 'unconfigured');
    assert.equal(health.selected_file, 'a.json');
    assert.equal((await f.call('/admin/select', { name: 'b.json' })).status, 200);
    assert.equal((await (await f.call('/health')).json()).selected_file, 'b.json');
    await assert.rejects(fs.stat(path.join(f.directory, 'config.toml')), error => error.code === 'ENOENT');
    await assert.rejects(fs.stat(path.join(f.directory, 'auth.json')), error => error.code === 'ENOENT');
});

test('direct authorization switch copies expired credentials despite prior renewal errors and makes no upstream calls', async t => {
    let calls = 0;
    const f = await gatewayFixture(t, async () => {
        calls++;
        return Response.json({ error: { code: 'refresh_token_reused' } }, { status: 401 });
    });
    const expired = record('b', Date.now() / 1000 - 3600);
    await writeJSON(path.join(f.auth, 'b.json'), expired);
    await fs.writeFile(path.join(f.directory, 'config.toml'), '# keep settings\nmodel = "test"\n');
    await writeJSON(path.join(f.directory, 'auth.json'), record('old'));
    assert.notEqual((await f.call('/admin/usage', { name: 'b.json' })).status, 200);
    assert.ok((await (await f.call('/health')).json()).last_error);
    const before = calls;
    assert.equal((await f.call('/admin/auth-file', { name: 'b.json' })).status, 200);
    assert.equal(calls, before);
    assert.deepEqual((await readJSON(path.join(f.directory, 'auth.json'))).tokens, expired.tokens);
    const health = await (await f.call('/health')).json();
    assert.equal(health.last_error, null);
    assert.equal(health.codex_auth_file, 'b.json');
    assert.equal(health.selected_file, 'a.json');
    assert.equal(health.proxy_running, true);
    assert.deepEqual(await readJSON(path.join(f.auth, 'b.json')), expired);
});

test('auth file mode rejects API key records without changing active settings', async t => {
    const f = await fixture(t);
    const config = path.join(f.directory, 'config.toml');
    await fs.writeFile(config, 'model = "unchanged"\n');
    await assert.rejects(configureAuthFile(f.directory, { OPENAI_API_KEY: 'test' }, config),
        error => error.code === 'invalid_auth_file');
    assert.equal(await fs.readFile(config, 'utf8'), 'model = "unchanged"\n');
});

test('generated curl calls the streaming gateway with the local key and current model', async t => {
    if (process.platform === 'win32') { t.skip('POSIX shell integration'); return; }
    let payload;
    const f = await gatewayFixture(t, async (_url, options) => {
        payload = JSON.parse(options.body);
        return new Response('data: {"type":"response.completed","text":"PROXY_OK"}\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const command = curlCommand({ ...f.state, port: f.gateway.server.address().port }, 'model = "test-model"', { stream: true });
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', command], { timeout: 10000 });
    assert.match(stdout, /PROXY_OK/);
    assert.equal(payload.model, 'gpt-6.1-sol');
    assert.equal(payload.stream, true);
    assert.equal(payload.store, false);
    assert.ok(payload.instructions);
});

test('curl previews mask credentials and use safe platform-specific quoting', async t => {
    const state = { port: 18347, key: "local'key$(false)" };
    const config = TOML.stringify({ model: "model'$(false)" });
    const preview = curlCommand(state, config, { masked: true, platform: 'darwin' });
    assert.ok(!preview.includes(state.key));
    assert.match(preview, /<LOCAL_PROXY_KEY>/);
    const windows = curlCommand(state, config, { platform: 'win32' });
    assert.match(windows, /^curl\.exe /);
    assert.match(windows, /local''key/);
    if (process.platform !== 'win32') {
        const command = curlCommand(state, config, { platform: 'darwin', model: "model'$(false)" });
        const { stdout } = await promisify(execFile)('/bin/sh', ['-c',
            'curl() { printf "%s\\000" "$@"; }; ' + command]);
        const args = stdout.split('\0');
        assert.ok(args.includes('Authorization: Bearer ' + state.key));
        assert.equal(JSON.parse(args[args.indexOf('--data-raw') + 1]).model, "model'$(false)");
    }
    assert.throws(() => curlCommand({ port: 18347, key: 'bad\r\nheader' }, config));
    assert.throws(() => curlCommand({ port: 0, key: 'test' }, config));
});

test('network validation and discovery exclude public, internal, and IPv6 addresses', () => {
    assert.deepEqual(validateNetwork({ port: 18888, lan_enabled: true }), { port: 18888, lan_enabled: true });
    for (const port of [0, 80, 65536, 18888.5, '18888']) {
        assert.throws(() => validateNetwork({ port, lan_enabled: false }));
    }
    assert.throws(() => validateNetwork({ port: 18888, lan_enabled: 'true' }));
    assert.ok(isPrivateAddress('::ffff:192.168.1.20'));
    assert.ok(!isPrivateAddress('8.8.8.8'));
    assert.ok(!isPrivateAddress('172.32.1.1'));
    assert.deepEqual(lanAddresses({ test: [
        { address: '192.168.1.20', family: 'IPv4', internal: false },
        { address: '192.168.1.20', family: 'IPv4', internal: false },
        { address: '127.0.0.1', family: 'IPv4', internal: true },
        { address: '8.8.8.8', family: 'IPv4', internal: false }
    ] }), ['192.168.1.20']);
});

test('LAN clients can infer but cannot access management or health even with the key', async t => {
    const ip = lanAddresses()[0];
    if (!ip) { t.skip('No private IPv4 interface on this host'); return; }
    const f = await fixture(t);
    await writeJSON(path.join(f.directory, 'proxy.json'), { ...f.state, lan_enabled: true });
    const gateway = await createGateway(f.directory, { fetchUpstream: async () =>
        new Response('data: {"type":"response.completed"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) });
    f.gateways.push(gateway);
    t.after(() => gateway.close());
    assert.equal(gateway.server.address().address, '0.0.0.0');
    const base = `http://${ip}:${gateway.server.address().port}`;
    const headers = { Authorization: 'Bearer local-test-key' };
    assert.equal((await fetch(base + '/health', { headers })).status, 403);
    assert.equal((await fetch(base + '/admin/accounts', { headers: { ...headers, 'X-Forwarded-For': '127.0.0.1' } })).status, 403);
    assert.equal((await fetch(base + '/admin/select', { method: 'POST', headers, body: '{}' })).status, 403);
    assert.equal((await fetch(base + '/v1/responses', { method: 'POST', body: '{}' })).status, 401);
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers, body: '{"model":"test","input":[],"stream":true}' });
    assert.equal(response.status, 200);
    await response.text();
});

test('port changes update Codex configuration and occupied ports roll back service and settings', async t => {
    const f = await fixture(t);
    const blocker = http.createServer();
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => blocker.close(resolve)));
    const port = blocker.address().port;
    const config = path.join(f.directory, 'config.toml');
    await fs.writeFile(config, 'model = "test"\n');
    await writeJSON(path.join(f.directory, 'proxy.json'), { ...f.state, port });
    await configure(f.directory, config);
    const original = await fs.readFile(config, 'utf8');
    let pauses = 0;
    const stub = { pause: () => { pauses++; }, close: async () => {} };
    let starts = 0;
    await assert.rejects(changeNetwork(f.directory, { port: port === 18888 ? 18889 : 18888, lan_enabled: false }, {
        config, gateway: stub, startGateway: async () => { starts++; if (starts === 1) throw Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }); return stub; }
    }), error => error.code === 'EADDRINUSE' && error.restoredGateway === stub);
    assert.equal((await readJSON(path.join(f.directory, 'proxy.json'))).port, port);
    assert.equal(await fs.readFile(config, 'utf8'), original);
    assert.equal(pauses, 1);
    const target = port === 18888 ? 18889 : 18888;
    await changeNetwork(f.directory, { port: target, lan_enabled: false }, { config, gateway: stub, startGateway: async () => stub });
    const updated = TOML.parse(await fs.readFile(config, 'utf8'));
    assert.equal(updated.model_providers.auth_switcher_local.base_url, `http://127.0.0.1:${target}/v1`);
    assert.equal(updated.openai_base_url, `http://127.0.0.1:${target}/v1`);
    assert.equal((await readJSON(path.join(f.directory, 'proxy.json'))).port, target);
});

test('live requests block network reconfiguration without changing persisted state', async t => {
    const f = await fixture(t);
    const original = await fs.readFile(path.join(f.directory, 'proxy.json'), 'utf8');
    await assert.rejects(changeNetwork(f.directory, { port: 18888, lan_enabled: false }, {
        gateway: { pause: () => { throw new Error('running request'); } }, startGateway: async () => assert.fail('must not restart')
    }), /running request/);
    assert.equal(await fs.readFile(path.join(f.directory, 'proxy.json'), 'utf8'), original);
});

test('an actual occupied TCP port restores the original live listener', async t => {
    const f = await fixture(t);
    let gateway = await createGateway(f.directory, { fetchUpstream: async () => { throw new Error('not used'); } });
    const oldPort = gateway.server.address().port;
    await writeJSON(path.join(f.directory, 'proxy.json'), { ...f.state, port: oldPort });
    const blocker = http.createServer();
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => blocker.close(resolve)));
    try {
        await changeNetwork(f.directory, { port: blocker.address().port, lan_enabled: false }, {
            gateway, startGateway: createGateway
        });
        assert.fail('Port collision must fail');
    } catch (error) {
        assert.equal(error.code, 'EADDRINUSE');
        gateway = error.restoredGateway;
        assert.ok(gateway);
    }
    t.after(() => gateway.close());
    const response = await fetch(`http://127.0.0.1:${oldPort}/health`, { headers: { Authorization: 'Bearer local-test-key' } });
    assert.equal(response.status, 200);
    assert.equal((await readJSON(path.join(f.directory, 'proxy.json'))).port, oldPort);
});

const finalResponse = { id: 'resp-test', object: 'response', status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PROXY_OK 中文' }] }],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } };
const completedSSE = value => 'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: value }) + '\n\n';

test('false and omitted stream return a single JSON preserving full output and usage', async t => {
    let upstreamBody;
    const f = await gatewayFixture(t, async (_url, options) => {
        upstreamBody = JSON.parse(options.body);
        return new Response('event: response.created\ndata: {"type":"response.created"}\n\n' + completedSSE(finalResponse),
            { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'test-id' } });
    });
    for (const input of [{ model: 'test', input: 'Hello', stream: false }, { model: 'test', input: 'Hello' }]) {
        const response = await f.call('/v1/responses', input);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /application\/json/);
        assert.equal(response.headers.get('x-request-id'), 'test-id');
        assert.deepEqual(await response.json(), finalResponse);
        assert.equal(upstreamBody.stream, true); // Legacy Codex backend still requires streaming.
        assert.equal(upstreamBody.input[0].content[0].text, 'Hello');
        assert.equal(upstreamBody.instructions, '');
    }
});

test('SSE aggregation supports byte splits, Unicode, CRLF, multiline data, and no trailing blank', async () => {
    const payload = 'event: response.completed\r\ndata: ' + JSON.stringify({ type: 'response.completed',
        response: finalResponse }, null, 2).split('\n').join('\r\ndata: ') + '\r\n';
    const bytes = new TextEncoder().encode(payload);
    const body = new ReadableStream({ start(controller) {
        for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.slice(index, index + 1));
        controller.close();
    } });
    assert.deepEqual(await collectResponse(body), finalResponse);
});

test('stream failure, truncation, and oversize are errors rather than partial success', async t => {
    for (const [data, code] of [
        ['data: {"type":"response.output_text.delta","delta":"partial"}\n\n', 'upstream_stream_incomplete'],
        ['data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"secret"}}}\n\n', 'server_error'],
        ['data: not-json\n\n', 'invalid_upstream_event']
    ]) {
        const f = await gatewayFixture(t, async () => new Response(data, { headers: { 'Content-Type': 'text/event-stream' } }));
        const response = await f.call('/v1/responses', { model: 'test', input: 'hello', stream: false });
        assert.equal(response.status, 502);
        const result = await response.json();
        assert.equal(result.error.code, code);
        assert.ok(!JSON.stringify(result).includes('secret'));
    }
    await assert.rejects(collectResponse(new Response(completedSSE(finalResponse)).body, 10),
        error => error.code === 'response_too_large');
});

test('incomplete response remains explicit and invalid stream parameters are rejected', async t => {
    let requests = 0;
    const incomplete = { ...finalResponse, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
    const f = await gatewayFixture(t, async () => { requests++; return new Response(
        'data: ' + JSON.stringify({ type: 'response.incomplete', response: incomplete }) + '\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } }); });
    const response = await f.call('/v1/responses', { model: 'test', input: 'hello' });
    assert.deepEqual(await response.json(), incomplete);
    assert.equal((await f.call('/v1/responses', { stream: 'false', input: 'hello' })).status, 400);
    assert.equal(requests, 1);
});

test('API key upstream receives stream false and its JSON is passed through', async t => {
    let stream;
    const f = await gatewayFixture(t, async (_url, options) => {
        stream = JSON.parse(options.body).stream;
        return Response.json(finalResponse);
    });
    await writeJSON(path.join(f.auth, 'a.json'), { OPENAI_API_KEY: 'test-upstream-key' });
    const response = await f.call('/v1/responses', { model: 'test', input: 'hello', stream: false });
    assert.equal(stream, false);
    assert.deepEqual(await response.json(), finalResponse);
});

test('generated default curl is non-streaming and returns JSON through the gateway', async t => {
    if (process.platform === 'win32') { t.skip('POSIX shell integration'); return; }
    const f = await gatewayFixture(t, async () => new Response(completedSSE(finalResponse),
        { headers: { 'Content-Type': 'text/event-stream' } }));
    const command = curlCommand({ ...f.state, port: f.gateway.server.address().port }, 'model = "test-model"');
    assert.ok(!command.includes('--no-buffer'));
    assert.match(command, /"stream":false/);
    assert.match(command, /"model":"gpt-6\.1-sol"/);
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', command], { timeout: 10000 });
    assert.deepEqual(JSON.parse(stdout), finalResponse);
});

test('LAN sharing chooses a LAN IP instead of loopback and follows network changes', () => {
    const health = { lan_enabled: true, lan_addresses: ['192.168.1.10', '10.0.0.2'] };
    assert.equal(shareHost(health), '192.168.1.10');
    assert.equal(shareHost(health, '127.0.0.1'), '192.168.1.10');
    assert.equal(shareHost(health, '10.0.0.2'), '10.0.0.2');
    assert.throws(() => shareHost(health, '192.168.1.99'));
    assert.throws(() => shareHost({ lan_enabled: true, lan_addresses: [] }));
    assert.equal(shareHost({ lan_enabled: false }), '127.0.0.1');
    assert.throws(() => shareHost({ lan_enabled: false }, '192.168.1.10'));
    const command = curlCommand({ key: 'test-key', port: 18888 }, '', { host: shareHost(health) });
    assert.match(command, /http:\/\/192\.168\.1\.10:18888\/v1\/responses/);
    assert.ok(!command.includes('127.0.0.1'));
});

test('statistics filters read live directory files even without usage and preserve identity across aliases', async t => {
    const f = await gatewayFixture(t, async () => Response.json({}));
    let data = await (await f.call('/admin/statistics')).json();
    assert.deepEqual(data.files.map(file => file.name), ['a.json', 'b.json']);
    assert.equal(data.totals.total_tokens, 0);
    await writeJSON(path.join(f.auth, 'new.json'), record('new'));
    await writeJSON(path.join(f.auth, 'copy-a.json'), record('a'));
    data = await (await f.call('/admin/statistics')).json();
    assert.equal(data.files.length, 4);
    assert.equal(data.files.find(file => file.name === 'copy-a.json').id, data.files.find(file => file.name === 'a.json').id);
    await fs.rename(path.join(f.auth, 'new.json'), path.join(f.auth, 'renamed.json'));
    data = await (await f.call('/admin/statistics')).json();
    assert.ok(data.files.some(file => file.name === 'renamed.json'));
    assert.ok(!data.files.some(file => file.name === 'new.json'));
    assert.ok(!JSON.stringify(data).includes('refresh-a'));
});

test('statistics persist per account, sum totals once, and use Beijing midnight boundaries', async t => {
    const f = await fixture(t);
    const stats = new TokenStatistics(f.directory);
    const now = Date.parse('2026-10-08T15:59:59Z');
    const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120,
        input_tokens_details: { cached_tokens: 70 }, output_tokens_details: { reasoning_tokens: 8 } };
    const a = usageAccount('a.json', record('a'));
    const b = usageAccount('b.json', record('b'));
    await Promise.all(Array.from({ length: 8 }, (_, index) => stats.record(index % 2 ? a : b, usage, now)));
    await stats.record(a, undefined, now);
    await stats.record(usageAccount('renamed-a.json', record('a')), usage, now);
    const today = await new TokenStatistics(f.directory).today(now);
    assert.equal(today.accounts.length, 2);
    assert.equal(today.totals.requests, 10);
    assert.equal(today.totals.measured_requests, 9);
    assert.equal(today.totals.unknown_requests, 1);
    assert.equal(today.totals.total_tokens, 1080);
    assert.equal(today.totals.cached_tokens, 630);
    assert.equal(today.totals.reasoning_tokens, 72);
    assert.equal(today.totals.hours[23], 1080);
    assert.equal(today.accounts.find(item => item.id === a.id).aliases.length, 2);
    assert.equal((await stats.today(now + 1000)).totals.total_tokens, 0);
    assert.deepEqual(beijingTime(now + 1000), { day: '2026-10-09', hour: 0 });
    assert.ok(!JSON.stringify(today).includes('refresh-a'));
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.directory, 'statistics', '2026-10-08.json'))).mode & 0o777, 0o600);
    assert.equal(normalizedUsage({ input_tokens: -1, output_tokens: 2 }), null);
});

test('statistics aggregate calendar weeks and months across boundaries without losing account identity', async t => {
    const f = await fixture(t);
    const stats = new TokenStatistics(f.directory);
    const a = usageAccount('a.json', record('a'));
    const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
    const at = day => Date.parse(day + 'T04:00:00Z');
    await stats.record(a, usage, at('2026-09-30'));
    await stats.record(a, usage, at('2026-10-01'));
    await stats.record(usageAccount('renamed.json', record('a')), usage, at('2026-10-02'));
    await stats.record(usageAccount('renamed.json', record('a')), undefined, at('2026-10-02'));
    const result = await stats.periods(at('2026-10-02'));
    assert.equal(result.totals.total_tokens, 12);
    assert.equal(result.periods.week.start, '2026-09-28');
    assert.equal(result.periods.week.end, '2026-10-04');
    assert.equal(result.periods.week.totals.total_tokens, 36);
    assert.deepEqual(result.periods.week.totals.buckets, [0, 0, 12, 12, 12, 0, 0]);
    assert.equal(result.periods.month.totals.total_tokens, 24);
    assert.equal(result.periods.month.totals.requests, 3);
    assert.equal(result.periods.month.totals.unknown_requests, 1);
    assert.equal(result.periods.month.buckets.length, 31);
    assert.equal(result.periods.week.accounts.length, 1);
    assert.deepEqual(result.periods.week.accounts[0].aliases, ['a.json', 'renamed.json']);
    assert.equal(result.periods.week.accounts[0].name, 'renamed.json');
    assert.equal((await stats.periods(at('2024-02-29'))).periods.month.end, '2024-02-29');
    const year = await stats.periods(at('2027-01-01'));
    assert.equal(year.periods.week.start, '2026-12-28');
    assert.equal(year.periods.week.end, '2027-01-03');
    assert.equal(year.periods.month.start, '2027-01-01');
    assert.equal(year.periods.month.totals.total_tokens, 0);
});

test('gateway counts JSON and SSE once, leaves streaming bytes intact, and keeps statistics local', async t => {
    const sse = completedSSE(finalResponse) + completedSSE(finalResponse);
    const f = await gatewayFixture(t, async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }));
    const first = await f.call('/v1/responses', { model: 'test', input: 'hi', stream: true });
    assert.equal(await first.text(), sse);
    const second = await f.call('/v1/responses', { model: 'test', input: 'hi', stream: false });
    assert.deepEqual(await second.json(), finalResponse);
    await f.gateway.close(); // Shutdown waits for accounting writes.
    const stats = await new TokenStatistics(f.directory).today();
    assert.equal(stats.accounts.length, 1);
    assert.equal(stats.totals.requests, 2);
    assert.equal(stats.totals.total_tokens, 16);
    assert.equal(stats.totals.input_tokens, 10);
    assert.equal(stats.totals.output_tokens, 6);
    assert.equal(stats.totals.unknown_requests, 0);
});

test('statistics attribute an existing stream to its original account after switching', async t => {
    let finish;
    const f = await gatewayFixture(t, async (url, options) => {
        if (url.includes('/wham/usage')) return Response.json({});
        if (url.includes('/accounts/check')) return Response.json({});
        if (options.headers['ChatGPT-Account-Id'] === 'a') return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
            finish = () => { controller.enqueue(new TextEncoder().encode(completedSSE(finalResponse))); controller.close(); };
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
        return new Response(completedSSE({ ...finalResponse, usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } }),
            { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const a = await f.call('/v1/responses', { stream: true, input: 'hi' });
    assert.equal((await f.call('/admin/select', { name: 'b.json' })).status, 200);
    const b = await f.call('/v1/responses', { input: 'hi', stream: false });
    await b.json();
    finish();
    await a.text();
    await f.gateway.close();
    const stats = await new TokenStatistics(f.directory).today();
    assert.equal(stats.accounts.find(item => item.name === 'a.json').total_tokens, 8);
    assert.equal(stats.accounts.find(item => item.name === 'b.json').total_tokens, 30);
    assert.equal(stats.totals.total_tokens, 38);
});

test('missing upstream usage is marked unknown rather than inventing token counts', async t => {
    const f = await gatewayFixture(t, async () => new Response(completedSSE({ ...finalResponse, usage: null }),
        { headers: { 'Content-Type': 'text/event-stream' } }));
    const response = await f.call('/v1/responses', { input: 'hi', stream: false });
    await response.json();
    await f.gateway.close();
    const stats = await new TokenStatistics(f.directory).today();
    assert.equal(stats.totals.unknown_requests, 1);
    assert.equal(stats.totals.measured_requests, 0);
    assert.equal(stats.totals.total_tokens, 0);
});
