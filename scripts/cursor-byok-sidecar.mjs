import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import { Readable } from 'node:stream';
import { injectCursorAuthState, restoreCursorAuthState } from './cursor-local.mjs';
import selfsigned from 'selfsigned';

// Native implementation of the cursor-byok takeover design. No cursor-byok
// executable, control API, or generated artifact is used here.
const root = path.join(os.homedir(), '.codex-auth-switcher', 'cursor');
const settingsFile = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'settings.json') : process.platform === 'linux' ? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Cursor', 'User', 'settings.json') : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'User', 'settings.json');
const settingsBackup = `${settingsFile}.codex-auth-switcher-backup`;
const certFile = path.join(root, 'ca', 'ca.crt');
const keyFile = path.join(root, 'ca', 'ca.key');
let mitmServer;

function exec(file, args) { return new Promise((resolve, reject) => execFile(file, args, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))); }

async function caTrusted() {
    if (!(await fs.stat(certFile).catch(() => null)) || !(await fs.stat(keyFile).catch(() => null))) return { state: 'missing', certFile };
    if (process.platform === 'win32') {
        const result = await exec('certutil.exe', ['-user', '-store', 'Root']).catch(() => exec('certutil.exe', ['-store', 'Root']).catch(() => null));
        return { state: result && /(?:Codex Auth Switcher Local CA|\*\.cursor\.sh)/i.test(`${result.stdout}\n${result.stderr}`) ? 'ready' : 'untrusted', certFile };
    }
    const anchors = process.platform === 'darwin' ? ['/Library/Keychains/System.keychain'] : ['/etc/ssl/certs/codex-auth-switcher-local-ca.crt', '/usr/local/share/ca-certificates/codex-auth-switcher-local-ca.crt'];
    const certificate = await fs.readFile(certFile, 'utf8');
    for (const anchor of anchors) {
        const value = process.platform === 'darwin' ? await exec('security', ['find-certificate', '-a', '-Z', anchor]).then(result => result.stdout).catch(() => '') : await fs.readFile(anchor, 'utf8').catch(() => '');
        if (/(?:Codex Auth Switcher Local CA|\*\.cursor\.sh)/i.test(value) || value.trim() === certificate.trim()) return { state: 'ready', certFile };
    }
    return { state: 'untrusted', certFile };
}

async function generateCa() {
    await fs.mkdir(path.dirname(certFile), { recursive: true });
    const generated = selfsigned.generate([{ name: 'commonName', value: 'Codex Auth Switcher Local CA' }], { days: 1825, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'basicConstraints', cA: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: '*.cursor.sh' }, { type: 2, value: 'cursor.sh' }] }] });
    await fs.writeFile(certFile, generated.cert, 'utf8');
    await fs.writeFile(keyFile, generated.private, 'utf8');
}

async function installCa() {
    if (process.platform === 'win32') {
        const escaped = certFile.replace(/'/g, "''");
        await exec('certutil.exe', ['-user', '-addstore', '-f', 'Root', certFile]).catch(() => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$p=Start-Process certutil.exe -ArgumentList @('-addstore','-f','Root','${escaped}') -Verb RunAs -Wait -PassThru; exit $p.ExitCode`]));
    } else if (process.platform === 'darwin') await exec('osascript', ['-e', `do shell script "security add-trusted-cert -d -r trustRoot -p ssl -k /Library/Keychains/System.keychain '${certFile}'" with administrator privileges`]);
    else await exec('pkexec', ['sh', '-c', `cp '${certFile}' /usr/local/share/ca-certificates/codex-auth-switcher-local-ca.crt && update-ca-certificates`]);
    const result = await caTrusted();
    if (result.state !== 'ready') throw new Error('本地 CA 已生成，但系统信任安装未完成。');
    return result;
}
async function ensureCaTrust() { let result = await caTrusted(); if (result.state === 'missing') { await generateCa(); result = await caTrusted(); } return result.state === 'untrusted' ? installCa() : result; }
async function backupSettings() { await fs.mkdir(path.dirname(settingsFile), { recursive: true }); if (!(await fs.stat(settingsBackup).catch(() => null))) await fs.copyFile(settingsFile, settingsBackup).catch(error => error.code === 'ENOENT' ? fs.writeFile(settingsBackup, '') : Promise.reject(error)); }
async function applySettings(proxyUrl) { const current = await fs.readFile(settingsFile, 'utf8').then(JSON.parse).catch(() => ({})); await fs.writeFile(settingsFile, JSON.stringify({ ...current, 'http.proxy': proxyUrl, 'http.proxySupport': 'on', 'http.experimental.systemCertificatesV2': true }, null, 2)); }

function startMitm(baseUrl) {
    const secureContext = tls.createSecureContext({ cert: readFileSync(certFile), key: readFileSync(keyFile) });
    const listener = net.createServer(socket => {
        let header = Buffer.alloc(0);
        const onConnectHeader = () => {
            const end = header.indexOf('\r\n\r\n');
            if (end < 0) return;
            socket.removeListener('data', onConnectData);
            socket.pause();
            const remainder = header.subarray(end + 4);
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n', () => {
                // CONNECT headers and the TLS ClientHello can arrive in one
                // TCP packet. Put the bytes after the proxy header back before
                // handing the socket to Node's TLS state machine.
                if (remainder.length) socket.unshift(remainder);
                const secure = new tls.TLSSocket(socket, { isServer: true, secureContext });
                let requestBuffer = Buffer.alloc(0);
                secure.on('secure', () => secure.resume());
                secure.on('data', chunk => {
                    requestBuffer = Buffer.concat([requestBuffer, chunk]);
                    const marker = requestBuffer.indexOf('\r\n\r\n');
                    if (marker < 0) return;
                    const head = requestBuffer.subarray(0, marker).toString('latin1');
                    const [first, ...lines] = head.split('\r\n');
                    const match = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\S+)/.exec(first);
                    if (!match) return secure.destroy();
                    const headers = Object.fromEntries(lines.map(line => line.split(/:\s*/, 2)).filter(parts => parts.length === 2).map(([key, value]) => [key.toLowerCase(), value]));
                    const length = Number(headers['content-length'] || 0);
                    const bodyStart = marker + 4;
                    const chunked = /chunked/i.test(headers['transfer-encoding'] || '');
                    let body;
                    if (chunked) {
                        const encoded = requestBuffer.subarray(bodyStart);
                        const chunks = []; let cursor = 0; let complete = false;
                        while (cursor < encoded.length) {
                            const lineEnd = encoded.indexOf('\r\n', cursor); if (lineEnd < 0) return;
                            const size = Number.parseInt(encoded.subarray(cursor, lineEnd).toString('ascii').split(';', 1)[0], 16);
                            if (!Number.isFinite(size) || size < 0) return secure.destroy();
                            cursor = lineEnd + 2;
                            if (encoded.length < cursor + size + 2) return;
                            if (size === 0) { complete = true; break; }
                            chunks.push(encoded.subarray(cursor, cursor + size)); cursor += size + 2;
                        }
                        if (!complete) return;
                        body = Buffer.concat(chunks);
                    } else {
                        if (requestBuffer.length < bodyStart + length) return;
                        body = requestBuffer.subarray(bodyStart, bodyStart + length);
                    }
                    const forwardHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => !['host', 'connection', 'content-length', 'transfer-encoding'].includes(key)));
                    fetch(`${baseUrl}${match[2]}`, { method: match[1], headers: forwardHeaders, body: body.length ? body : undefined }).then(async upstream => {
                        const contentType = upstream.headers.get('content-type') || '';
                        const streaming = contentType.includes('text/event-stream') || !upstream.headers.has('content-length');
                        const responseHeaders = [`HTTP/1.1 ${upstream.status} ${upstream.statusText || 'OK'}`, streaming ? 'Transfer-Encoding: chunked' : `Content-Length: ${upstream.headers.get('content-length')}`, 'Connection: close', ...[...upstream.headers].filter(([key]) => !['content-length', 'connection', 'transfer-encoding'].includes(key)).map(([key, value]) => `${key}: ${value}`)];
                        secure.write(`${responseHeaders.join('\r\n')}\r\n\r\n`);
                        if (!upstream.body) return secure.end();
                        if (!streaming) return secure.end(Buffer.from(await upstream.arrayBuffer()));
                        for await (const chunk of Readable.fromWeb(upstream.body)) {
                            const data = Buffer.from(chunk);
                            secure.write(`${data.length.toString(16)}\r\n`); secure.write(data); secure.write('\r\n');
                        }
                        secure.end('0\r\n\r\n');
                    }).catch(() => secure.destroy());
                    secure.removeAllListeners('data');
                });
                secure.on('error', () => secure.destroy());
                socket.resume();
            });
        };
        const onConnectData = chunk => { header = Buffer.concat([header, chunk]); onConnectHeader(); };
        socket.on('data', onConnectData);
        socket.on('error', () => socket.destroy());
    });
    listener.listen(0, '127.0.0.1');
    return new Promise((resolve, reject) => { listener.once('listening', () => { mitmServer = listener; resolve(`http://127.0.0.1:${listener.address().port}`); }); listener.once('error', reject); });
}

export function cursorByokExecutable() { return null; }
export async function prepareCursorByok() { await fs.mkdir(root, { recursive: true }); return { root }; }
export async function startCursorByok(options = {}) {
    await prepareCursorByok(options);
    let injected = false;
    let backedUp = false;
    try {
        await injectCursorAuthState(); injected = true;
        await backupSettings(); backedUp = true;
        const ca = await ensureCaTrust();
        const proxyUrl = await startMitm(options.baseUrl);
        await applySettings(proxyUrl);
        return { running: true, pid: process.pid, proxyUrl, takeover: 'native-cursor-mitm', tabMode: 'native', tabAddress: options.baseUrl, ca };
    } catch (error) {
        await new Promise(resolve => mitmServer ? mitmServer.close(resolve) : resolve()); mitmServer = null;
        if (backedUp) await stopCursorByok({ restore: true }).catch(() => {});
        else if (injected) await restoreCursorAuthState().catch(() => {});
        throw error;
    }
}
export async function stopCursorByok({ restore = true } = {}) { await new Promise(resolve => mitmServer ? mitmServer.close(resolve) : resolve()); mitmServer = null; if (restore && await fs.stat(settingsBackup).catch(() => null)) { const stat = await fs.stat(settingsBackup); if (stat.size) await fs.copyFile(settingsBackup, settingsFile); else await fs.rm(settingsFile, { force: true }); await fs.rm(settingsBackup, { force: true }); } if (restore) await restoreCursorAuthState(); return { running: false, restored: restore }; }
export { caTrusted };
