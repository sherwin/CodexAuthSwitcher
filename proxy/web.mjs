import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createWebAuth } from './web-auth.mjs';
import { fileURLToPath } from 'node:url';
import { start, localCall } from './server.mjs';
import { defaultDirectory, readJSON, writeJSON, accountPath, ProxyError } from './storage.mjs';
import { isLoopback, isPrivateAddress } from './network.mjs';
import { desktopHTML, webAsset } from './web-assets.mjs';
import { createWebOperations } from './web-operations.mjs';
import { createWebRuntime } from './web-runtime.mjs';
import { isDeepSeek, deepSeekSettings } from './credentials.mjs';

const loginFile = new URL('./web-login.html', import.meta.url);
const routes = new Map([
    ['GET /api/accounts', '/admin/accounts'], ['GET /api/status', '/health'],
    ['POST /api/usage', '/admin/usage'], ['POST /api/select', '/admin/select'],
    ['POST /api/deepseek', '/admin/deepseek'],
    ['POST /api/auth-file', '/admin/auth-file'], ['POST /api/configure', '/admin/configure'],
    ['GET /api/statistics', '/admin/statistics'], ['POST /api/unconfigure', '/admin/unconfigure'],
    ['GET /api/requestLogs', '/admin/request-logs'], ['POST /api/requestLogs', '/admin/request-logs'],
    ['GET /api/settings', '/admin/settings'], ['POST /api/settings', '/admin/settings'],
    ['GET /api/priority', '/admin/priority'], ['POST /api/priority', '/admin/priority'],
    ['POST /api/custom', '/admin/custom'],
]);
async function body(req) {
    const parts = []; let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error('body_too_large');
        parts.push(chunk);
    }
    return JSON.parse(Buffer.concat(parts).toString());
}
export async function createWeb({ directory = defaultDirectory, password, host = '0.0.0.0', port = 18889,
    call = (route, data) => localCall(directory, route, data), operations = createWebOperations(directory, { call }),
    runtime = createWebRuntime({ call }) } = {}) {
    if (!password || password.length < 10) throw new Error('Web password must have at least 10 characters');
    const auth = createWebAuth(password);
    const server = http.createServer(async (req, res) => {
        const send = (status, data) => {
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(data));
        };
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
        if (!isLoopback(req.socket.remoteAddress) && !isPrivateAddress(req.socket.remoteAddress)) return send(403, { error: 'LAN only' });
        if (!/^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '') &&
            !isPrivateAddress((req.headers.host || '').split(':')[0])) return send(403, { error: 'Invalid host' });
        if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) return send(403, { error: 'Invalid origin' });
        if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Invalid site' });
        try {
            if (req.method === 'POST' && req.headers['x-switcher-web'] !== '1') return send(403, { error: 'Missing request guard' });
            if (req.method === 'POST' && req.url === '/api/login') {
                const data = await body(req);
                const result = auth.login(req.socket.remoteAddress, data.username, data.password);
                if (result.cookie) res.setHeader('Set-Cookie', result.cookie);
                if (result.status === 429) res.setHeader('Retry-After', '60');
                return send(result.status, result.status === 200 ? { ok: true } : { error: 'Login failed' });
            }
            const authenticated = auth.authenticated(req);
            if (req.method === 'GET' && req.url === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end(authenticated ? await desktopHTML() : await fs.readFile(loginFile)); return;
            }
            if (req.method === 'GET') {
                const asset = await webAsset(req.url, { publicOnly: !authenticated });
                if (asset) {
                    res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' });
                    res.end(asset.content); return;
                }
            }
            if (!authenticated) return send(401, { error: 'Login required' });
            if (req.method === 'POST' && req.url === '/api/logout') {
                res.setHeader('Set-Cookie', auth.logoutCookie()); return send(200, { ok: true });
            }
            if (operations.busy) return send(409, { error: '服务设置正在更新，请稍后重试。' });
            if (runtime.busy && req.method === 'POST') return send(409, { error: 'Codex 正在重启，请稍后重试。' });
            if (req.method === 'GET' && req.url === '/api/runtime') return send(200, await runtime.status());
            if (req.method === 'POST' && ['/api/runtime/restart', '/api/runtime/proxy'].includes(req.url)) {
                const input = await body(req);
                return send(200, await runtime.restart({ force: input.force === true, proxy: req.url === '/api/runtime/proxy' }));
            }
            if (req.method === 'GET' && req.url.startsWith('/api/directories?'))
                return send(200, await operations.directories(new URL(req.url, 'http://localhost').searchParams.get('path')));
            const special = { '/api/network': 'network', '/api/directory': 'directory', '/api/curl': 'curl' };
            if (req.method === 'POST' && Object.hasOwn(special, req.url))
                return send(200, await operations[special[req.url]](await body(req)));
            if (req.method === 'POST' && req.url === '/api/import') {
                const data = await body(req);
                const record = typeof data.auth === 'string' ? JSON.parse(data.auth) : data.auth;
                const deepseek = isDeepSeek(record);
                if (deepseek) deepSeekSettings(record);
                if ((!record?.tokens?.access_token || !record?.tokens?.refresh_token || record.OPENAI_API_KEY) && !deepseek)
                    return send(400, { error: '需要有效的 ChatGPT 或 DeepSeek 授权 JSON 文件' });
                const state = await readJSON(path.join(directory, 'proxy.json'));
                const file = accountPath(state, data.name);
                try { await fs.access(file); return send(409, { error: '同名文件已存在，请重命名后导入' }); }
                catch (e) { if (e.code !== 'ENOENT') throw e; }
                await writeJSON(file, record); send(200, { ok: true }); return;
            }
            const route = routes.get(req.method + ' ' + req.url);
            if (!route) return send(404, { error: 'Not found' });
            const data = req.method === 'POST' ? await body(req) : undefined;
            send(200, await call(route, data));
        } catch (error) {
            send(error.status || 400, { error: error instanceof ProxyError ? error.message : error.code || 'operation_failed' });
        }
    });
    server.requestTimeout = 65000; server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const password = (await fs.readFile(process.env.AUTH_SWITCHER_WEB_PASSWORD_FILE || path.join(defaultDirectory, 'web-password'), 'utf8')).trim();
    const gateway = await start();
    const operations = createWebOperations(defaultDirectory, { gateway,
        call: route => localCall(defaultDirectory, route) });
    const web = await createWeb({ password, operations, port: Number(process.env.AUTH_SWITCHER_WEB_PORT || 18889) });
    console.log('Codex Auth Switcher web ready on port ' + web.address().port);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
        web.closeAllConnections(); web.close(); await operations.close(); process.exit(0);
    });
}
