import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createGateway, localCall } from '../../proxy/server.mjs';
import { readJSON, writeJSON } from '../../proxy/storage.mjs';
import { createWeb } from '../../proxy/web.mjs';
import { createWebOperations } from '../../proxy/web-operations.mjs';
import { createWebRuntime } from '../../proxy/web-runtime.mjs';

// All credentials, configuration changes and upstream responses are test fixtures.
export async function webFixture({ port = 0 } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'switcher-full-web-'));
    const authDirectory = path.join(directory, 'accounts'), codexHome = path.join(directory, 'codex');
    await fs.mkdir(authDirectory); await fs.mkdir(codexHome);
    const jwt = data => 'header.' + Buffer.from(JSON.stringify(data)).toString('base64url') + '.signature';
    const record = name => ({ tokens: { access_token: jwt({ exp: Date.now() / 1000 + 3600 }),
        refresh_token: 'test-refresh-' + name, account_id: name } });
    for (const name of ['alpha', 'beta']) await writeJSON(path.join(authDirectory, name + '.json'), record(name));
    const stateFile = path.join(directory, 'proxy.json');
    await writeJSON(stateFile, { key: 'fixture-proxy-key', port: 0, enabled: false,
        selected_file: 'alpha.json', auth_directory: authDirectory });
    await fs.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-6.1-sol"\n');
    await writeJSON(path.join(codexHome, 'auth.json'), record('alpha'));
    const upstream = async url => {
        if (url.includes('/wham/usage')) return Response.json({ plan_type: 'plus', rate_limit: {
            primary_window: { used_percent: 20, reset_at: Date.now() / 1000 + 3600 },
            secondary_window: { used_percent: 35, reset_at: Date.now() / 1000 + 86400 } } });
        if (url.includes('/accounts/check')) return Response.json({ accounts: {} });
        throw Error('Fixture must never use external services');
    };
    const startGateway = async () => {
        const gateway = await createGateway(directory, { codexHome, fetchUpstream: upstream });
        const state = await readJSON(stateFile);
        state.port = gateway.server.address().port;
        await writeJSON(stateFile, state); return gateway;
    };
    const gateway = await startGateway();
    const call = (route, data) => localCall(directory, route, data);
    const operations = createWebOperations(directory, { call, gateway, startGateway,
        config: path.join(codexHome, 'config.toml') });
    let fixturePID = 101;
    const runtime = createWebRuntime({ enabled: true, platform: 'linux', call,
        run: async (_file, args) => {
            if (args[0] === 'restart') { fixturePID++; return { stdout: '' }; }
            return { stdout: `ActiveState=active\nMainPID=${fixturePID}\nKillMode=control-group\n` };
        }, read: async () => String(fixturePID) });
    const server = await createWeb({ directory, password: 'fixture-only-password', host: '127.0.0.1', port, call, operations, runtime });
    const base = 'http://127.0.0.1:' + server.address().port;
    const headers = { Authorization: 'Basic ' + Buffer.from('admin:fixture-only-password').toString('base64'), 'X-Switcher-Web': '1' };
    const request = (route, data) => fetch(base + route, { headers,
        method: data === undefined ? 'GET' : 'POST', body: data === undefined ? undefined : JSON.stringify(data) });
    return { directory, authDirectory, codexHome, operations, base, request, headers,
        async close() {
            server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
            await operations.close(); await fs.rm(directory, { recursive: true, force: true });
        } };
}
