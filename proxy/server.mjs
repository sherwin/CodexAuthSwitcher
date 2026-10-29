import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetch as undiciFetch, ProxyAgent, Agent } from 'undici';
import { defaultDirectory, initialize, readJSON, writeJSON, locked, accountPath, provider,
    codexDirectory, ProxyError, normalizeCapacityRetrySettings, normalizePrioritySettings } from './storage.mjs';
import { Credentials, upstream, isDeepSeek, deepSeekSettings, claims, responseError, syncActive } from './credentials.mjs';
import { configure, configureCustom, configureAuthFile, unconfigure, restore, inspectConfiguration } from './config.mjs';
import { isLoopback, isPrivateAddress, lanAddresses } from './network.mjs';
import { collectResponse } from './responses.mjs';
import { eventObserver } from './sse.mjs';
import { TokenStatistics, usageAccount, normalizedUsage } from './statistics.mjs';
import { querySubscription } from './subscription.mjs';
import { createRequestLog } from './request-log.mjs';
import { decodeConnectEnvelopes, decodeStreamCppRequest, encodeStreamCppResponse,
    encodeAvailableModelsResponse, connectEnvelope, cursorPrompt, extractCursorChatPrompt, extractCursorChatModel,
    encodeStreamChatResponse, encodeCursorGetEmailResponse, encodeCursorSessionTokenResponse,
    encodeCursorBoolResponse, decodeCursorBidiAppend, decodeCursorRunSseRequest,
    encodeCursorAgentText, encodeCursorAgentTurnEnded } from './cursor-connect.mjs';

const maxBody = 32 * 1024 * 1024;
const retryableAuthCodes = new Set(['token_expired', 'invalid_token', 'token_invalidated',
    'invalid_grant', 'refresh_token_reused', 'refresh_token_expired', 'refresh_token_invalidated']);
const maxCapacityRetries = 5;
function retryableStreamError(error) { return /network|disconnect|socket|body|fetch|transport/i.test(String(error?.message || error)); }
async function transientResponse(response) {
    if (!response || response.ok || ![429, 500, 502, 503, 504].includes(response.status)) return false;
    try { const body = await response.clone().text(); return /selected\s+model\s+is\s+at\s+capacity/i.test(body) || (response.status === 502 && /bad\s+gateway|unknown\s+error/i.test(body)); }
    catch { return false; }
}
async function quotaExhausted(response) {
    if (!response || response.ok || response.status !== 429) return false;
    try {
        const body = await response.clone().text();
        return /usage_limit_reached|insufficient_quota|usage limit has been reached|exceeded retry limit|too many requests/i.test(body);
    } catch { return false; }
}
async function waitRetry(settings) { await new Promise(resolve => setTimeout(resolve, Math.round((settings.min_seconds + Math.random() * (settings.max_seconds - settings.min_seconds)) * 1000))); }
async function bufferStream(body) {
    const chunks = []; let size = 0;
    for await (const chunk of Readable.fromWeb(body)) { size += chunk.length; if (size > maxBody) throw new ProxyError('Response body too large.', 'response_too_large', 502); chunks.push(chunk); }
    return Buffer.concat(chunks);
}
function streamCompleted(buffer) { const text = buffer.toString('utf8'); return /response\.completed/.test(text) && /"status"\s*:\s*"completed"/.test(text); }
function upstreamErrorDetail(error) { return error?.cause?.message || error?.message || String(error) || 'The upstream connection failed.'; }

function windowsSystemProxy() {
    if (process.platform !== 'win32') return '';
    try {
        const output = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', timeout: 2000 });
        if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(output)) return '';
        const match = output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
        const value = match?.[1]?.trim() || '';
        if (!value) return '';
        const httpProxy = value.split(';').find(item => /^https?=\s*/i.test(item))?.replace(/^https?=\s*/i, '') || value;
        return /^https?:\/\//i.test(httpProxy) ? httpProxy : `http://${httpProxy}`;
    } catch { return ''; }
}

export function upstreamFetch() {
    let proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY;
    if (!proxy) proxy = windowsSystemProxy();
    if (!proxy && process.platform === 'darwin') {
        try {
            const settings = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 2000 });
            if (/HTTPSEnable\s*:\s*1/.test(settings)) {
                const host = settings.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
                const port = settings.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
                if (host && port) proxy = `http://${host}:${port}`;
            }
        } catch { /* Direct connections on platforms without system HTTP proxy settings. */ }
    }
    const dispatcher = proxy ? new ProxyAgent(proxy) : new Agent({ headersTimeout: 300000, bodyTimeout: 300000 });
    return (url, options = {}) => undiciFetch(url, { ...options, dispatcher });
}

async function bodyJSON(request) {
    if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
        throw new ProxyError('Request compression is unsupported.', 'unsupported_encoding', 415);
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBody) { const error = new ProxyError('Request body too large.', 'body_too_large', 413); error.requestBody = Buffer.concat(chunks).toString('utf8'); throw error; }
        chunks.push(chunk);
    }
    try {
        const value = JSON.parse(Buffer.concat(chunks));
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
        return value;
    } catch { const error = new ProxyError('Expected a JSON object.', 'invalid_body', 400); error.requestBody = Buffer.concat(chunks).toString('utf8'); throw error; }
}

async function rawBody(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBody) throw new ProxyError('Request body too large.', 'body_too_large', 413);
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function responseText(value) {
    const output = Array.isArray(value?.output) ? value.output : [];
    return output.flatMap(item => Array.isArray(item?.content) ? item.content : [])
        .filter(item => item?.type === 'output_text' && typeof item.text === 'string')
        .map(item => item.text).join('');
}

function sendJSON(response, status, value, extraHeaders = {}) {
    const body = JSON.stringify(value);
    response.writeHead(status, { ...extraHeaders, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Requested-With' });
    response.end(body);
}

function cursorProtoHeaders(request, { stream = false } = {}) {
    // Cursor's Connect transport validates the response against the RPC kind,
    // rather than echoing the request content type. Unary methods such as
    // AvailableModels and DashboardService require application/proto;
    // StreamCpp uses the length-prefixed application/connect+proto format.
    const requested = String(request.headers['content-type'] || '').toLowerCase();
    const contentType = stream ? (requested.includes('grpc-web') ? 'application/grpc-web+proto' :
        requested.includes('grpc') ? 'application/grpc+proto' : 'application/connect+proto') : 'application/proto';
    return { 'Content-Type': contentType, 'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Requested-With',
        ...(contentType.includes('grpc') ? { 'grpc-encoding': 'identity' } :
            contentType.includes('connect') ? { 'Connect-Protocol-Version': '1' } : {}) };
}

function authenticated(request, key) {
    const expected = Buffer.from(`Bearer ${key}`);
    const actual = Buffer.from(request.headers.authorization || '');
    return actual.length === expected.length && timingSafeEqual(actual, expected) && !request.headers.origin;
}

export async function createGateway(directory, { fetchUpstream = upstreamFetch(), fetchSubscription = fetchUpstream, codexHome = codexDirectory } = {}) {
    const statePath = path.join(directory, 'proxy.json');
    const initial = await readJSON(statePath);
    const credentials = new Credentials(directory, initial.auth_directory, fetchUpstream);
    const statistics = new TokenStatistics(directory);
    const requestLog = await createRequestLog(directory);
    const metrics = { in_flight: 0, last_error: null, last_account: null, completed_requests: 0 };
    const controllers = new Set();
    const pendingRequests = new Set();
    let paused = false;
    let closed = false;
    let codexConnection = null;
    let configurationGeneration = 0;
    const notified = new Map();
    const recentErrors = new Map();
    // Modern Cursor keeps request metadata in BidiAppend and consumes the
    // generated answer through a later RunSSE call with the same request id.
    // The entry is deliberately short-lived and local to this gateway process.
    const cursorRuns = new Map();

    async function report(error, name) {
        metrics.last_error = { code: error.code || 'upstream_unavailable', account: name || null, at: new Date().toISOString() };
        const webhook = process.env.AUTH_SWITCHER_DINGTALK_WEBHOOK;
        if (!webhook) { metrics.last_error.notification = 'DingTalk webhook not configured'; return; }
        const id = `${name}:${metrics.last_error.code}`;
        if (Date.now() - (notified.get(id) || 0) < 300000) return;
        notified.set(id, Date.now());
        try {
            const result = await fetchUpstream(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ msgtype: 'text', text: { content: `Codex Auth Switcher: ${name || 'proxy'} / ${metrics.last_error.code}` } }),
                redirect: 'error', signal: AbortSignal.timeout(5000) });
            const data = await result.json();
            if (!result.ok || data.errcode !== 0) metrics.last_error.notification = 'DingTalk delivery failed';
        } catch { metrics.last_error.notification = 'DingTalk delivery failed'; }
    }

    async function selectedRecord(name) {
        const state = await readJSON(statePath);
        if (state.mode === 'auth_file') await syncActive(state.auth_directory, codexHome);
        return credentials.get(accountPath(state, name));
    }
    async function priorityEntries(state) {
        const files = (await fs.readdir(state.auth_directory, { withFileTypes: true }))
            .filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name);
        const priority = normalizePrioritySettings(state.priority);
        const order = [...priority.order.filter(name => files.includes(name)), ...files.filter(name => !priority.order.includes(name)).sort()];
        const entries = order.map(name => ({ name, enabled: !priority.disabled.includes(name), active: name === state.selected_file }));
        if (priority.include_custom && state.custom_base_url) entries.push({ name: '__custom__', label: `局域网 ${state.custom_base_url}`, enabled: !priority.disabled.includes('__custom__'), active: state.mode === 'custom' });
        return entries;
    }
    async function selectNext(state, current) {
        const entries = await priorityEntries(state);
        const enabled = entries.filter(item => item.enabled);
        const index = enabled.findIndex(item => item.name === current);
        return enabled[(index + 1 + enabled.length) % enabled.length]?.name || null;
    }

    async function usage(name) {
        const state = await readJSON(statePath);
        if (state.mode === 'auth_file') await syncActive(state.auth_directory, codexHome);
        const file = accountPath(state, name);
        let record = await credentials.get(file);
        if (isDeepSeek(record)) {
            return { data: null, subscription: null, fetchedAt: new Date().toISOString(), tokenExpiresAt: null };
        }
        if (record.OPENAI_API_KEY) throw new ProxyError('Subscription usage is unavailable for API keys.', 'usage_unavailable', 400);
        const fetchUsage = current => fetchUpstream('https://chatgpt.com/backend-api/wham/usage', {
            headers: { Authorization: `Bearer ${current.tokens.access_token}`, 'ChatGPT-Account-Id': current.tokens.account_id,
                originator: 'codex_cli_rs' }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
        let response = await fetchUsage(record);
        if (response.status === 401) {
            const error = await responseError(response);
            if (!retryableAuthCodes.has(error.code)) throw error;
            record = await credentials.get(file, { force: true, failedToken: record.tokens.access_token });
            response = await fetchUsage(record);
        }
        if (!response.ok) throw await responseError(response);
        const data = await response.json();
        const subscription = await querySubscription(record, fetchSubscription);
        return { data, subscription, subscriptionExpiry: subscription.expiresAt || subscription.cancelsAt || null, fetchedAt: new Date().toISOString(),
            tokenExpiresAt: claims(record.tokens.access_token).exp || null };
    }

    const server = http.createServer(async (request, response) => {
        let name;
        let active = false;
        let controller;
        let statisticsAccount;
        let tokenUsage;
        let finishRequest;
        let pendingRequest;
        let admittedConfiguration;
        let admittedGeneration;
        let terminalCompleted = false;
        let completionCounted = false;
        const requestStartedAt = new Date();
        let requestBody;
        let requestErrorCode;
        let requestErrorMessage;
        let requestModel;
        let attemptErrors = [];
        let attemptCount = 0;
        let shouldRecord = false;
        const responseChunks = [];
        const originalWrite = response.write.bind(response);
        const originalEnd = response.end.bind(response);
        response.write = (chunk, ...args) => { if (chunk && responseChunks.reduce((n, b) => n + b.length, 0) < maxBody) responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return originalWrite(chunk, ...args); };
        response.end = (chunk, ...args) => { if (chunk && responseChunks.reduce((n, b) => n + b.length, 0) < maxBody) responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return originalEnd(chunk, ...args); };
        try {
            const requestedPath = new URL(request.url, 'http://127.0.0.1').pathname;
            const cursorConnect = request.method === 'POST' &&
                /^\/aiserver\.v1\.AiService\/StreamCpp$/.test(requestedPath);
            const cursorChat = request.method === 'POST' &&
                /^\/aiserver\.v1\.AiService\/StreamChat(?:Web|TryReallyHard)?$/.test(requestedPath);
            const cursorBidi = request.method === 'POST' &&
                requestedPath === '/aiserver.v1.BidiService/BidiAppend';
            const cursorRunSse = request.method === 'POST' &&
                requestedPath === '/agent.v1.AgentService/RunSSE';
            const cursorCppConfig = request.method === 'POST' &&
                requestedPath === '/aiserver.v1.AiService/CppConfig';
            const cursorDashboard = request.method === 'POST' &&
                /^\/aiserver\.v1\.(DashboardService|NetworkService)\/.+/.test(requestedPath);
            const cursorAvailableModels = request.method === 'POST' &&
                /^\/aiserver\.v1\.(AiService|CppService)\/AvailableModels$/.test(requestedPath);
            const cursorAuthRpc = request.method === 'POST' &&
                /^\/aiserver\.v1\.AuthService\/(GetEmail|MarkPrivacy|GetSessionToken|CheckSessionToken|EmailValid|GetCustomerId)$/.test(requestedPath);
            const cursorAuth = requestedPath.startsWith('/auth/');
            const local = isLoopback(request.socket.remoteAddress);
            if (request.method === 'OPTIONS' && local) {
                response.writeHead(204, { 'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Requested-With' });
                response.end();
                return;
            }
            if (!authenticated(request, initial.key) && !(isLoopback(request.socket.remoteAddress) &&
                (cursorConnect || cursorChat || cursorBidi || cursorRunSse || cursorCppConfig || cursorDashboard || cursorAvailableModels || cursorAuthRpc || cursorAuth))) {
                sendJSON(response, 401, { error: { code: 'local_key_required', message: 'Local gateway authentication required.' } });
                return;
            }
            const url = new URL(request.url, 'http://127.0.0.1');
            if (!local && (!initial.lan_enabled || !isPrivateAddress(request.socket.remoteAddress))) {
                throw new ProxyError('Only local network clients are allowed.', 'lan_access_denied', 403);
            }
            if (!local && (url.pathname.startsWith('/admin/') || url.pathname === '/health')) {
                throw new ProxyError('Management is available only on this computer.', 'local_admin_required', 403);
            }
            const state = await readJSON(statePath);
            if (url.search) throw new ProxyError('Query parameters are unsupported.', 'unsupported_route', 404);
            // Cursor performs these account and entitlement probes before it
            // opens the completion stream. They must terminate locally so a
            // fake local session is not rejected by api2/api3. Connect's
            // length-prefixed empty protobuf is valid for the unary replies;
            // Cursor treats omitted optional fields as the local free/ultra
            // defaults and proceeds to the configured completion endpoint.
            if (cursorDashboard) {
                const payload = Buffer.alloc(0);
                response.writeHead(200, cursorProtoHeaders(request));
                response.end(payload);
                return;
            }
            if (cursorAvailableModels) {
                let modelNames = [];
                const selected = state.selected_file ? await credentials.get(accountPath(state, state.selected_file)).catch(() => null) : null;
                if (selected) {
                    try {
                        const target = upstream(selected, 'models');
                        const modelResponse = await fetchUpstream(target.url, { headers: { Authorization: `Bearer ${target.token}` },
                            redirect: 'manual', signal: AbortSignal.timeout(20000) });
                        if (modelResponse.ok) {
                            const catalog = await modelResponse.json();
                            const entries = Array.isArray(catalog) ? catalog : catalog.data || catalog.models || [];
                            modelNames = entries.map(item => typeof item === 'string' ? item : item?.id || item?.slug)
                                .filter(name => typeof name === 'string');
                        }
                    } catch { /* Keep the local fallback when a provider has no model endpoint. */ }
                }
                const payload = encodeAvailableModelsResponse(modelNames);
                response.writeHead(200, cursorProtoHeaders(request));
                response.end(payload);
                return;
            }
            if (cursorCppConfig) {
                // CppConfig is a unary RPC. Unlike StreamCpp it carries a raw
                // protobuf message and must receive application/proto without
                // a Connect envelope.
                await rawBody(request);
                const config = Buffer.concat([Buffer.from([0x08, 0x01]), Buffer.from([0x10, 0x01]),
                    Buffer.from([0x28, 0x01]), Buffer.from([0x30, 0x01])]);
                response.writeHead(200, cursorProtoHeaders(request));
                response.end(config);
                return;
            }
            if (cursorAuth) {
                if (request.method === 'GET' && /\/auth\/(full_stripe_profile|stripe_profile)$/.test(requestedPath)) {
                    sendJSON(response, 200, { membershipType: 'ultra', subscriptionStatus: 'active',
                        hasValidPaymentMethod: true, email: 'cursor@ai.com' });
                    return;
                }
                if (requestedPath === '/auth/has_valid_payment_method') {
                    sendJSON(response, 200, { hasValidPaymentMethod: true });
                    return;
                }
                if (requestedPath === '/auth/poll') {
                    sendJSON(response, 200, { authenticated: true, status: 'active', email: 'cursor@ai.com' });
                    return;
                }
            }
            if (cursorAuthRpc) {
                // Connect unary responses are raw protobuf messages.  The
                // injected local session is deliberately synthetic and is
                // accepted only by this local gateway.
                const authMethod = requestedPath.split('/').pop();
                await rawBody(request);
                let payload = Buffer.alloc(0);
                if (authMethod === 'GetEmail') payload = encodeCursorGetEmailResponse();
                else if (authMethod === 'GetSessionToken') payload = encodeCursorSessionTokenResponse(initial.key);
                else if (authMethod === 'CheckSessionToken' || authMethod === 'EmailValid') payload = encodeCursorBoolResponse(true);
                else if (authMethod === 'GetCustomerId') payload = encodeCursorSessionTokenResponse('local-customer');
                response.writeHead(200, cursorProtoHeaders(request));
                response.end(payload);
                return;
            }
            if (cursorBidi) {
                const append = decodeCursorBidiAppend(await rawBody(request));
                if (!append.requestId || !append.payload.length)
                    throw new ProxyError('Cursor BidiAppend 请求缺少 request_id 或消息体。', 'invalid_cursor_request', 400);
                const prompt = extractCursorChatPrompt(append.payload) ||
                    'Please answer the latest user message from Cursor Chat.';
                const model = extractCursorChatModel(append.payload) || 'gpt-6.1-sol';
                cursorRuns.set(append.requestId, { prompt, model, at: Date.now() });
                for (const [id, value] of cursorRuns) if (Date.now() - value.at > 10 * 60 * 1000) cursorRuns.delete(id);
                response.writeHead(200, cursorProtoHeaders(request));
                response.end(Buffer.alloc(0));
                return;
            }
            if (cursorRunSse) {
                const run = decodeCursorRunSseRequest(await rawBody(request));
                const pending = run.requestId && cursorRuns.get(run.requestId);
                if (!pending) throw new ProxyError('找不到 Cursor BidiAppend 请求。', 'invalid_cursor_request', 400);
                cursorRuns.delete(run.requestId);
                const localPort = server.address()?.port;
                if (!localPort) throw new ProxyError('本地代理尚未监听端口。', 'proxy_not_ready', 503);
                const localResult = await undiciFetch(`http://127.0.0.1:${localPort}/v1/responses`, {
                    method: 'POST', headers: { Authorization: `Bearer ${initial.key}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: pending.model, input: [{ role: 'user', content: [{ type: 'input_text', text: pending.prompt }] }], stream: false }),
                    signal: AbortSignal.timeout(600000) });
                if (!localResult.ok) {
                    const message = await localResult.text().catch(() => 'Cursor tab completion failed.');
                    throw new ProxyError(message.slice(0, 500), `cursor_upstream_${localResult.status}`, localResult.status);
                }
                const completion = responseText(await localResult.json());
                const payload = Buffer.concat([
                    connectEnvelope(encodeCursorAgentText(completion)),
                    connectEnvelope(encodeCursorAgentTurnEnded()),
                    connectEnvelope(Buffer.from('{"error":null}', 'utf8'), 0x02)
                ]);
                response.writeHead(200, { ...cursorProtoHeaders(request, { stream: true }), 'Content-Type': 'text/event-stream' });
                response.end(payload);
                return;
            }
            if (cursorConnect) {
                const body = await rawBody(request);
                let envelopes = [];
                try { envelopes = decodeConnectEnvelopes(body); } catch { /* raw protobuf is also valid */ }
                // Cursor versions differ here: some send one Connect frame,
                // while newer builds send raw protobuf or include metadata
                // frames before the request. Always select the first data
                // frame and fall back to the raw body instead of returning a
                // connection-level 400 to the editor.
                const input = envelopes.find(item => item.flags === 0)?.message || body;
                let cursor;
                try { cursor = decodeStreamCppRequest(input); }
                catch { cursor = { model: '', path: '', contents: '', line: 0, column: 0 }; }
                const prompt = cursorPrompt(cursor);
                const localPort = server.address()?.port;
                if (!localPort) throw new ProxyError('本地代理尚未监听端口。', 'proxy_not_ready', 503);
                // Cursor sends internal names such as "main" and "turbo". They
                // are not OpenAI model IDs, so route them through a compatible
                // local model while preserving explicit OpenAI-compatible IDs.
                const model = /^(main|turbo|default)$/i.test(cursor.model || '')
                    ? 'gpt-4o-mini' : (cursor.model || 'gpt-4o-mini');
                const localResult = await undiciFetch(`http://127.0.0.1:${localPort}/v1/responses`, {
                    method: 'POST', headers: { Authorization: `Bearer ${initial.key}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }], stream: false }),
                    signal: AbortSignal.timeout(600000) });
                if (!localResult.ok) {
                    const message = await localResult.text().catch(() => 'Cursor completion failed.');
                    throw new ProxyError(message.slice(0, 500), `cursor_upstream_${localResult.status}`, localResult.status);
                }
                const completion = responseText(await localResult.json());
                const line = Math.max(1, cursor.line + 1);
                const payload = Buffer.concat([
                    connectEnvelope(encodeStreamCppResponse({ text: completion, startLine: line, endLine: line })),
                    connectEnvelope(encodeStreamCppResponse({ doneStream: true, doneEdit: true, startLine: line, endLine: line }))
                ]);
                response.writeHead(200, cursorProtoHeaders(request, { stream: true }));
                response.end(payload);
                return;
            }
            if (cursorChat) {
                const body = await rawBody(request);
                let envelopes;
                try {
                    envelopes = decodeConnectEnvelopes(body);
                } catch {
                    envelopes = [];
                }
                // Cursor 0.44.x may send a raw protobuf body for StreamChat
                // even though the response uses the Connect stream envelope.
                // Accept both forms so a protocol framing change does not
                // surface as an opaque 400 to the chat UI.
                const input = envelopes.length === 1 && envelopes[0].flags === 0
                    ? envelopes[0].message : body;
                const extractedPrompt = extractCursorChatPrompt(input);
                const plainInput = input.toString('utf8').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
                const plainChars = [...plainInput];
                const plainPrintable = plainChars.filter(char => {
                    const code = char.codePointAt(0);
                    return code >= 0x20 && code !== 0x7f;
                }).length / Math.max(1, plainChars.length);
                // Newer Cursor builds encrypt/compress the chat protobuf. Do
                // not forward decoded binary as a fake prompt; it produces
                // confusing answers and can make the client report a failed
                // connection. The local provider still returns a valid chat
                // response while the opaque payload is unsupported.
                const prompt = extractedPrompt || (plainPrintable >= 0.8 && !plainInput.includes('\ufffd')
                    ? plainInput : 'Please answer the latest user message from Cursor Chat.');
                if (!prompt) throw new ProxyError('无法从 Cursor Chat 请求中提取用户消息。', 'invalid_cursor_request', 400);
                const model = extractCursorChatModel(input) || 'gpt-6.1-sol';
                const localPort = server.address()?.port;
                if (!localPort) throw new ProxyError('本地代理尚未监听端口。', 'proxy_not_ready', 503);
                const localResult = await undiciFetch(`http://127.0.0.1:${localPort}/v1/responses`, {
                    method: 'POST', headers: { Authorization: `Bearer ${initial.key}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }], stream: false }),
                    signal: AbortSignal.timeout(600000) });
                if (!localResult.ok) {
                    const message = await localResult.text().catch(() => 'Cursor chat completion failed.');
                    throw new ProxyError(message.slice(0, 500), `cursor_upstream_${localResult.status}`, localResult.status);
                }
                const completion = responseText(await localResult.json());
                const payloadParts = [connectEnvelope(encodeStreamChatResponse(completion))];
                const requestType = String(request.headers['content-type'] || '').toLowerCase();
                if (requestType.includes('grpc-web')) {
                    payloadParts.push(connectEnvelope(Buffer.from('grpc-status: 0\r\n', 'ascii'), 0x80));
                } else if (!requestType.includes('grpc')) {
                    // Connect streaming RPCs finish with an end-stream
                    // envelope carrying JSON metadata.
                    payloadParts.push(connectEnvelope(Buffer.from('{"error":null}', 'utf8'), 0x02));
                }
                const payload = Buffer.concat(payloadParts);
                response.writeHead(200, cursorProtoHeaders(request, { stream: true }));
                response.end(payload);
                return;
            }
            if (url.pathname === '/health' && request.method === 'GET') {
                const selected = state.selected_file
                    ? await readJSON(accountPath(state, state.selected_file)).catch(() => null) : null;
                const configuration = await inspectConfiguration(state, path.join(codexHome, 'config.toml'));
                const verified = state.mode === 'key' && configuration.matches &&
                    codexConnection?.fingerprint === configuration.fingerprint;
                sendJSON(response, 200, { service: provider, selected_file: state.selected_file || null,
                    selected_provider: isDeepSeek(selected) ? 'deepseek' : 'openai',
                    enabled: state.enabled, mode: state.mode || (state.enabled ? 'key' : 'unconfigured'),
                    proxy_running: true, codex_mode: state.mode || (state.enabled ? 'key' : 'unconfigured'),
                    restore_available: Boolean(state.config_backup && state.config_path && state.installed_config_hash),
                    codex_auth_file: state.codex_auth_file || (state.mode === 'auth_file' ? state.selected_file : null),
                    custom_base_url: state.mode === 'custom' ? state.custom_base_url : null,
                    capacity_retry: normalizeCapacityRetrySettings(state.capacity_retry),
                    priority: normalizePrioritySettings(state.priority),
                    codex_connection: { status: state.mode !== 'key' ? 'not_managed' :
                        !configuration.matches ? 'config_mismatch' : verified ? 'verified' : 'pending',
                        config_matches: configuration.matches, provider: configuration.provider || null,
                        verified_at: verified ? codexConnection.at : null },
                    port: server.address().port, lan_enabled: Boolean(initial.lan_enabled),
                    lan_addresses: lanAddresses(), ...metrics });
                return;
            }
            if (url.pathname === '/admin/accounts' && request.method === 'GET') {
                const accounts = [];
                for (const entry of await fs.readdir(state.auth_directory, { withFileTypes: true })) {
                    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
                    const record = await readJSON(accountPath(state, entry.name)).catch(() => ({}));
                    const stat = await fs.stat(accountPath(state, entry.name));
                    let base;
                    if (isDeepSeek(record)) {
                        try { base = deepSeekSettings(record).base_url; } catch { base = null; }
                    }
                    accounts.push({ name: entry.name, modifiedAt: stat.mtime.toISOString(),
                        provider: isDeepSeek(record) ? 'deepseek' : 'openai',
                        ...(isDeepSeek(record) ? { base_url: base } : {}),
                        tokenExpiresAt: claims(record.tokens?.access_token || '').exp || null,
                        active: entry.name === state.selected_file });
                }
                const order = (await priorityEntries(state)).map(item => item.name);
                accounts.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
                sendJSON(response, 200, { accounts,
                    authDirectory: state.auth_directory });
                return;
            }
            if (url.pathname === '/admin/statistics' && request.method === 'GET') {
                const files = [];
                for (const entry of await fs.readdir(state.auth_directory, { withFileTypes: true })) {
                    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
                    const record = await readJSON(accountPath(state, entry.name)).catch(error => {
                        if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
                        throw error;
                    });
                    files.push(usageAccount(entry.name, record));
                }
                sendJSON(response, 200, { ...await statistics.periods(),
                    files: files.sort((a, b) => a.name.localeCompare(b.name)), authDirectory: state.auth_directory });
                return;
            }
            if (url.pathname === '/admin/request-logs' && request.method === 'GET') {
                const filter = new URL(request.url, 'http://127.0.0.1').searchParams.get('filter') || 'all';
                const pageSize = 10, total = requestLog.count(filter), totalPages = Math.max(1, Math.ceil(total / pageSize));
                sendJSON(response, 200, { logs: requestLog.list(pageSize, 0, filter), page: 1, pageSize, total, totalPages, filter }); return;
            }
            if (url.pathname.startsWith('/admin/request-logs/') && request.method === 'GET') {
                const item = requestLog.get(Number(url.pathname.slice('/admin/request-logs/'.length)));
                if (!item) throw new ProxyError('Request record not found.', 'request_log_not_found', 404);
                sendJSON(response, 200, item); return;
            }
            if (url.pathname === '/admin/settings' && request.method === 'GET') {
                sendJSON(response, 200, { capacity_retry: normalizeCapacityRetrySettings(state.capacity_retry) }); return;
            }
            if (url.pathname === '/admin/priority' && request.method === 'GET') {
                const entries = await priorityEntries(state);
                sendJSON(response, 200, { priority: normalizePrioritySettings(state.priority), entries }); return;
            }
            if (url.pathname.startsWith('/admin/') && request.method === 'POST') {
                const input = await bodyJSON(request);
                name = input.name;
                requestBody = input;
                if (url.pathname === '/admin/request-logs') {
                    const filter = ['all', 'errors', 'capacity', 'network'].includes(input.filter) ? input.filter : 'all';
                    const pageSize = 10, total = requestLog.count(filter), totalPages = Math.max(1, Math.ceil(total / pageSize));
                    const page = Math.min(totalPages, Math.max(1, Number(input.page) || 1));
                    sendJSON(response, 200, { logs: requestLog.list(pageSize, (page - 1) * pageSize, filter), page, pageSize, total, totalPages, filter }); return;
                }
                if (url.pathname === '/admin/settings') {
                    const capacityRetry = normalizeCapacityRetrySettings(input.capacity_retry);
                    await locked(path.join(directory, 'state.mutex'), async () => { const latest = await readJSON(statePath); latest.capacity_retry = capacityRetry; await writeJSON(statePath, latest); });
                    sendJSON(response, 200, { ok: true, capacity_retry: capacityRetry }); return;
                }
                if (url.pathname === '/admin/priority') {
                    const priority = normalizePrioritySettings(input.priority);
                    await locked(path.join(directory, 'state.mutex'), async () => { const latest = await readJSON(statePath); latest.priority = priority; await writeJSON(statePath, latest); });
                    sendJSON(response, 200, { ok: true, priority }); return;
                }
                if (url.pathname === '/admin/deepseek') {
                    await locked(path.join(directory, 'state.mutex'), async () => {
                        const latest = await readJSON(statePath);
                        const file = accountPath(latest, name);
                        let previous;
                        try { previous = await readJSON(file); }
                        catch (error) { if (error.code !== 'ENOENT') throw error; }
                        if (input.edit === true) {
                            if (!previous || !isDeepSeek(previous))
                                throw new ProxyError('只能修改已有的 DeepSeek 账号。', 'invalid_account', 409);
                        } else if (previous) throw new ProxyError('同名账号已存在，请换一个名称。', 'account_exists', 409);
                        const settings = deepSeekSettings({ base_url: input.base_url,
                            api_key: input.edit === true && input.api_key === ''
                                ? previous.DEEPSEEK_API_KEY ?? previous.api_key : input.api_key });
                        await writeJSON(file, { provider: 'deepseek', base_url: settings.base_url,
                            DEEPSEEK_API_KEY: settings.api_key });
                    });
                    sendJSON(response, 200, { ok: true, name });
                    return;
                }
                if (url.pathname === '/admin/custom') {
                    await configureCustom(directory, input.base_url, input.api_key, path.join(codexDirectory, 'config.toml'), path.join(codexDirectory, 'auth.json'));
                    configurationGeneration++;
                    codexConnection = null;
                    sendJSON(response, 200, { ok: true, base_url: String(input.base_url).replace(/\/$/, '') });
                    return;
                }
                if (url.pathname === '/admin/codex-api') {
                    const account = await readJSON(accountPath(state, input.name));
                    const settings = deepSeekSettings(account);
                    await configureCustom(directory, settings.base_url, settings.api_key, path.join(codexHome, 'config.toml'), path.join(codexHome, 'auth.json'));
                    configurationGeneration++; codexConnection = null;
                    sendJSON(response, 200, { ok: true, base_url: settings.base_url }); return;
                }
                if (url.pathname === '/admin/select') {
                    const selected = await selectedRecord(name);
                    // Validate account access before committing the global route.
                    if (isDeepSeek(selected)) {
                        const target = upstream(selected, 'models');
                        const check = await fetchUpstream(target.url, { headers: { Authorization: `Bearer ${target.token}` },
                            redirect: 'manual', signal: AbortSignal.timeout(20000) });
                        if (!check.ok) throw await responseError(check);
                        await check.body?.cancel();
                    } else await usage(name);
                    await locked(path.join(directory, 'state.mutex'), async () => {
                        const latest = await readJSON(statePath);
                        if (isDeepSeek(selected)) {
                            const current = await readJSON(accountPath(latest, name));
                            if (latest.auth_directory !== state.auth_directory || JSON.stringify(current) !== JSON.stringify(selected))
                                throw new ProxyError('账号配置已变化，请重新切换。', 'account_changed', 409);
                        }
                        if (latest.mode === 'auth_file' && !latest.codex_auth_file) latest.codex_auth_file = latest.selected_file;
                        latest.selected_file = name;
                        await writeJSON(statePath, latest);
                    });
                    metrics.last_error = null;
                    sendJSON(response, 200, { ok: true, selected_file: name });
                    return;
                }
                if (url.pathname === '/admin/usage') { sendJSON(response, 200, await usage(name)); return; }
                if (url.pathname === '/admin/renew') {
                    await credentials.get(accountPath(state, name), { force: Boolean(input.force) });
                    sendJSON(response, 200, { ok: true });
                    return;
                }
                if (url.pathname === '/admin/configure') {
                    await configure(directory, path.join(codexHome, 'config.toml'));
                    configurationGeneration++;
                    codexConnection = null;
                    sendJSON(response, 200, { ok: true });
                    return;
                }
                if (url.pathname === '/admin/auth-file') {
                    name = input.name || state.codex_auth_file || state.selected_file;
                    if (!name) throw new ProxyError('请先选择 Codex 直连账号。', 'no_account_selected', 400);
                    // Switching a local authorization file is an explicit file operation,
                    // not a renewal or entitlement check. Even expired credentials may be copied.
                    const record = await readJSON(accountPath(state, name));
                    await configureAuthFile(directory, record, path.join(codexHome, 'config.toml'), path.join(codexHome, 'auth.json'), name);
                    metrics.last_error = null;
                    sendJSON(response, 200, { ok: true });
                    return;
                }
                if (url.pathname === '/admin/unconfigure') {
                    await unconfigure(directory);
                    sendJSON(response, 200, { ok: true });
                    return;
                }
                if (url.pathname === '/admin/restore') {
                    await restore(directory);
                    sendJSON(response, 200, { ok: true });
                    return;
                }
            }
            const routes = { '/v1/responses': ['POST', 'responses'],
                '/v1/chat/completions': ['POST', 'chat/completions'],
                '/v1/responses/compact': ['POST', 'responses/compact'], '/v1/models': ['GET', 'models'] };
            const route = routes[url.pathname];
            if (paused) throw new ProxyError('代理正在更新网络设置，请稍后重试。', 'proxy_restarting', 503);
            if (!route || route[0] !== request.method) throw new ProxyError('Unsupported gateway route.', 'unsupported_route', 404);
            shouldRecord = route[1] !== 'models';
            name = state.selected_file;
            let file = accountPath(state, name);
            const queue = (await priorityEntries(state)).filter(item => item.enabled).map(item => item.name);
            let queueIndex = queue.indexOf(name);
            const triedAccounts = new Set([name]);
            let record;
            async function switchQueuedAccount() {
                if (!normalizePrioritySettings(state.priority).enabled || !queue.length) return false;
                for (let count = 0; count < queue.length; count++) {
                    queueIndex = (queueIndex + 1) % queue.length;
                    const next = queue[queueIndex];
                    if (triedAccounts.has(next)) continue;
                    triedAccounts.add(next);
                    try {
                        const nextFile = next === '__custom__' ? file : accountPath(state, next);
                        const nextRecord = next === '__custom__'
                            ? { provider: 'custom', base_url: state.custom_base_url,
                                api_key: (await readJSON(path.join(codexHome, 'auth.json'))).OPENAI_API_KEY }
                            : await credentials.get(nextFile);
                        name = next;
                        file = nextFile;
                        record = nextRecord;
                        if (name !== '__custom__') await locked(path.join(directory, 'state.mutex'), async () => { const latest = await readJSON(statePath); latest.selected_file = name; await writeJSON(statePath, latest); });
                        return true;
                    } catch (error) {
                        attemptErrors.push({ attempt: attemptCount, account: next,
                            status: error.status || 401, code: error.code || 'account_unavailable',
                            message: error.message || 'Account unavailable.' });
                    }
                }
                return false;
            }
            try {
                record = await credentials.get(file);
            } catch (initialError) {
                attemptErrors.push({ attempt: 0, account: name,
                    status: initialError.status || 401,
                    code: initialError.code || 'token_refresh_failed',
                    message: initialError.message || 'Token refresh failed.' });
                if (!(await switchQueuedAccount())) throw initialError;
            }
            let body;
            let stream = false;
            let upstreamStream = false;
            if (request.method === 'POST') {
                const input = await bodyJSON(request);
                requestBody = input;
                requestModel = typeof input.model === 'string' ? input.model : null;
                if (input.previous_response_id) throw new ProxyError('Send full conversation input when using account switching.', 'unsupported_continuation', 400);
                if (route[1] === 'responses/compact' && isDeepSeek(record)) {
                    throw new ProxyError('DeepSeek 未提供 Responses compact 接口。', 'unsupported_wire_api', 400);
                }
                if (route[1] === 'responses') {
                    if (input.stream != null && typeof input.stream !== 'boolean') {
                        throw new ProxyError('stream 必须为 true 或 false。', 'invalid_stream', 400);
                    }
                    stream = input.stream === true;
                    const legacy = upstream(record, route[1]).url.startsWith('https://chatgpt.com/backend-api/codex/');
                    upstreamStream = legacy || stream;
                    input.store = false;
                    input.stream = upstreamStream;
                    if (legacy) {
                        input.instructions ??= '';
                        if (typeof input.input === 'string') input.input = [{ role: 'user',
                            content: [{ type: 'input_text', text: input.input }] }];
                    }
                }
                if (route[1] === 'chat/completions') {
                    if (typeof input.stream !== 'undefined' && typeof input.stream !== 'boolean')
                        throw new ProxyError('stream 必须为 true 或 false。', 'invalid_stream', 400);
                    stream = input.stream === true;
                    upstreamStream = stream;
                }
                body = JSON.stringify(input);
            }
            controller = new AbortController();
            controllers.add(controller);
            if (request.method === 'POST') statisticsAccount = usageAccount(name, record);
            admittedGeneration = configurationGeneration;
            if (state.mode === 'key') admittedConfiguration = await inspectConfiguration(state, path.join(codexHome, 'config.toml'));
            response.once('close', () => { if (!response.writableEnded) controller.abort(); });
            metrics.in_flight++;
            active = true;
            pendingRequest = new Promise(resolve => { finishRequest = resolve; });
            pendingRequests.add(pendingRequest);
            let result;
            let capacityRetries = 0;
            const capacityRetry = normalizeCapacityRetrySettings(state.capacity_retry);
            for (let attempt = 0; attempt < 2 + maxCapacityRetries; attempt++) {
                const target = upstream(record, route[1]);
                if (!target.token) throw new ProxyError('Account has no usable token.', 'login_required', 401);
                const headers = { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json',
                    Accept: upstreamStream ? 'text/event-stream' : 'application/json',
                    originator: 'codex_cli_rs', 'User-Agent': 'codex_cli_rs/0.159.2' };
                if (record.tokens?.account_id && !record.OPENAI_API_KEY) headers['ChatGPT-Account-Id'] = record.tokens.account_id;
                for (const key of ['session_id', 'conversation_id', 'openai-beta', 'x-codex-turn-metadata']) {
                    if (request.headers[key]) headers[key] = request.headers[key];
                }
                result = await fetchUpstream(target.url, { method: request.method, headers, body,
                    redirect: 'manual', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600000)]) });
                attemptCount++;
                if (!result.ok) { const errorText = await result.clone().text().catch(() => ''); attemptErrors.push({ attempt: attemptCount, account: name, status: result.status, code: `upstream_http_${result.status}`, message: errorText.slice(0, 500) }); }
                if (result.ok && upstreamStream && stream) {
                    try {
                        const buffered = await bufferStream(result.body);
                        if (!streamCompleted(buffered) && capacityRetry.enabled && capacityRetries < maxCapacityRetries) {
                            capacityRetries++; await waitRetry(capacityRetry); attempt--; continue;
                        }
                        result = new Response(buffered, { status: result.status, headers: result.headers });
                    } catch (error) {
                        attemptErrors.push({ attempt: attemptCount, account: name, code: error.code || 'stream_error', message: error.message });
                        if (capacityRetry.enabled && capacityRetries < maxCapacityRetries && retryableStreamError(error)) { capacityRetries++; await waitRetry(capacityRetry); attempt--; continue; }
                        throw error;
                    }
                }
                if (capacityRetry.enabled && capacityRetries < maxCapacityRetries && await transientResponse(result)) {
                    capacityRetries++; await waitRetry(capacityRetry); attempt--; continue;
                }
                const errorKey = `${name}`;
                if (!result.ok) { const previous = recentErrors.get(errorKey); const now = Date.now(); const count = previous && now - previous.at < 60000 ? previous.count + 1 : 1; recentErrors.set(errorKey, { count, at: now }); } else recentErrors.delete(errorKey);
                const exhausted = !result.ok && (await quotaExhausted(result) || recentErrors.get(errorKey)?.count >= normalizePrioritySettings(state.priority).max_errors || await transientResponse(result));
                if (exhausted && await switchQueuedAccount()) { statisticsAccount = usageAccount(name, record); capacityRetries = 0; attempt = -1; continue; }
                if (result.status !== 401 || attempt !== 0 || record.OPENAI_API_KEY || isDeepSeek(record)) break;
                const error = await responseError(result);
                if (!retryableAuthCodes.has(error.code)) throw error;
                try {
                    record = await credentials.get(file, { force: true, failedToken: record.tokens.access_token });
                } catch (refreshError) {
                    // A revoked or reused refresh token must not strand the
                    // request on one account when priority switching is on.
                    // Treat the failed renewal as an account failure and try
                    // the next eligible account before exposing 401.
                    attemptErrors.push({ attempt: attemptCount, account: name,
                        status: refreshError.status || 401,
                        code: refreshError.code || 'token_refresh_failed',
                        message: refreshError.message || 'Token refresh failed.' });
                    if (await switchQueuedAccount()) {
                        statisticsAccount = usageAccount(name, record);
                        capacityRetries = 0;
                        attempt = -1;
                        continue;
                    }
                    throw refreshError;
                }
            }
            if (route[1] === 'models' && result.ok) {
                let catalog = await result.json();
                if (Array.isArray(catalog.models)) catalog = { object: 'list', data: catalog.models
                    .filter(item => item.slug).map(item => ({ id: item.slug, object: 'model', owned_by: 'openai' })) };
                sendJSON(response, result.status, catalog);
                return;
            }
            if (result && !result.ok) {
                requestErrorCode = `upstream_http_${result.status}`;
                requestErrorMessage = attemptErrors.at(-1)?.message || `Upstream returned HTTP ${result.status}.`;
            }
            const headers = { 'Cache-Control': 'no-store', 'Content-Type': result.headers.get('content-type') ||
                (route[1] === 'responses' && result.ok ? 'text/event-stream' : 'application/json') };
            for (const [key, value] of result.headers) {
                if (['retry-after', 'x-request-id'].includes(key) || key.startsWith('x-ratelimit-')) headers[key] = value;
            }
            if (!result.ok) void report(new ProxyError('Upstream request failed.', `upstream_http_${result.status}`, result.status), name);
            if (result.ok && route[1] === 'responses' && !stream &&
                (headers['Content-Type'].includes('text/event-stream'))) {
                const completed = await collectResponse(result.body, maxBody, value => {
                    if (normalizedUsage(value?.usage)) tokenUsage ||= value.usage;
                });
                sendJSON(response, result.status, completed, headers);
                metrics.last_account = name;
                metrics.completed_requests++;
                return;
            }
            if (result.ok && !headers['Content-Type'].includes('text/event-stream') && request.method === 'POST') {
                const completed = await result.json();
                tokenUsage = completed.usage;
                sendJSON(response, result.status, completed, headers);
                metrics.last_account = name;
                metrics.completed_requests++;
                return;
            }
            response.writeHead(result.status, headers);
            response.flushHeaders();
            if (result.body && result.ok && headers['Content-Type'].includes('text/event-stream')) {
                let observer = eventObserver(event => {
                    if (event.type === 'response.completed' && event.response?.status === 'completed') terminalCompleted = true;
                    if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type) &&
                        normalizedUsage(event.response?.usage)) tokenUsage ||= event.response.usage;
                    if (normalizedUsage(event.usage)) tokenUsage ||= event.usage;
                });
                function observe(chunk, finish = false) {
                    try { if (observer) { if (finish) observer.finish(); else observer.push(chunk); } }
                    catch { observer = null; void report(new ProxyError('用量事件解析失败。', 'usage_parse_failed'), name); }
                }
                const tap = new Transform({ transform(chunk, _encoding, callback) { observe(chunk); callback(null, chunk); },
                    flush(callback) { observe(null, true); callback(); } });
                await pipeline(Readable.fromWeb(result.body), tap, response);
            } else if (result.body) await pipeline(Readable.fromWeb(result.body), response);
            else response.end();
            metrics.last_account = name;
            metrics.completed_requests++;
            completionCounted = true;
        } catch (error) {
            requestErrorCode = error.code || 'upstream_unavailable';
            requestErrorMessage = upstreamErrorDetail(error);
            requestBody ??= error.requestBody;
            if (!controller?.signal.aborted) void report(error, name);
            if (!response.headersSent && !response.destroyed) {
                sendJSON(response, error.status || 502, { error: { code: error.code || 'upstream_unavailable',
                    message: error instanceof ProxyError ? error.message : 'The upstream connection failed.' } });
            } else response.destroy();
        } finally {
            if (shouldRecord) {
                try { await requestLog.record({ startedAt: requestStartedAt.toISOString(), finishedAt: new Date().toISOString(), method: request.method,
                    path: request.url, account: name, status: response.statusCode || null, success: (response.statusCode || 500) < 400,
                    durationMs: Date.now() - requestStartedAt.getTime(), requestBody,
                    responseBody: Buffer.concat(responseChunks).toString('utf8') || JSON.stringify({ error: { code: requestErrorCode, message: requestErrorMessage } }), errorCode: requestErrorCode || (response.statusCode >= 400 ? 'http_error' : null),
                    errorMessage: requestErrorMessage, model: requestModel, attemptCount: attemptCount || 1, errorEvents: attemptErrors }); }
                catch { /* Logging must never break a completed request. */ }
            }
            // Codex can close immediately after response.completed, before upstream EOF.
            // Count that completed inference, but never a stream canceled before its terminal event.
            if (active && terminalCompleted && !completionCounted && response.statusCode < 400) {
                metrics.last_account = name;
                metrics.completed_requests++;
            }
            // Only completed, authenticated, local Codex-client inference requests are evidence.
            // curl, LAN clients and health/model-list checks must not mark local Codex as connected.
            if (active && statisticsAccount && (response.writableFinished || terminalCompleted) && response.statusCode < 400 &&
                isLoopback(request.socket.remoteAddress) &&
                /codex/i.test(String(request.headers.originator || '') + ' ' + String(request.headers['user-agent'] || ''))) {
                const current = await readJSON(statePath).catch(() => null);
                if (current?.mode === 'key' && admittedConfiguration?.matches && admittedGeneration === configurationGeneration) {
                    const configuration = await inspectConfiguration(current, path.join(codexHome, 'config.toml'));
                    if (configuration.matches && configuration.fingerprint === admittedConfiguration.fingerprint)
                        codexConnection = { fingerprint: configuration.fingerprint, at: new Date().toISOString() };
                }
            }
            if (statisticsAccount && active) {
                try { await statistics.record(statisticsAccount, tokenUsage); }
                catch { await report(new ProxyError('Token 统计保存失败。', 'statistics_write_failed'), name); }
            }
            if (controller) controllers.delete(controller);
            if (active) metrics.in_flight--;
            if (finishRequest) { finishRequest(); pendingRequests.delete(pendingRequest); }
        }
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 15000;
    server.maxHeadersCount = 100;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(initial.port, initial.lan_enabled ? '0.0.0.0' : '127.0.0.1', resolve);
    });
    return { server, metrics, requestLog, notifyError: report, pause: () => {
        if (metrics.in_flight) throw new ProxyError('请等待正在进行的请求结束后再修改网络设置。', 'requests_in_flight', 409);
        paused = true;
    }, close: async () => {
        if (closed) return;
        closed = true;
        for (const controller of controllers) controller.abort();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await Promise.allSettled([...pendingRequests]);
    } };
}

export async function localCall(directory, route, body) {
    const state = await readJSON(path.join(directory, 'proxy.json'));
    const response = await fetch(`http://127.0.0.1:${state.port}${route}`, {
        method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${state.key}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
    const result = await response.json();
    if (!response.ok) throw new ProxyError(result.error?.message || 'Local proxy operation failed.', result.error?.code, response.status);
    return result;
}

export async function start(directory = defaultDirectory, options) {
    await initialize(directory);
    const state = await readJSON(path.join(directory, 'proxy.json'));
    if (!state.enabled) await syncActive(state.auth_directory, codexDirectory);
    return createGateway(directory, options);
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'serve';
    const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
    const directory = option('--directory') || defaultDirectory;
    const name = option('--account') && path.basename(option('--account'));
    if (command === 'serve') {
        const gateway = await start(directory);
        console.log(JSON.stringify({ ready: true, port: gateway.server.address().port }));
        for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await gateway.close(); process.exit(0); });
        return;
    }
    let result;
    if (command === 'initialize') { await initialize(directory, name); result = { ok: true }; }
    else if (command === 'status') result = await localCall(directory, '/health');
    else if (command === 'select') result = await localCall(directory, '/admin/select', { name });
    else if (command === 'renew') result = await localCall(directory, '/admin/renew', { name, force: args.includes('--force') });
    else if (command === 'configure') result = await localCall(directory, '/admin/configure', {});
    else if (command === 'restore') result = await localCall(directory, '/admin/restore', {});
    else throw new ProxyError('Unknown gateway command.', 'invalid_command', 400);
    console.log(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.log(JSON.stringify({ error: error instanceof ProxyError ? error.message : 'Local proxy operation failed.', code: error.code || 'proxy_error' }));
        process.exitCode = 1;
    });
}
