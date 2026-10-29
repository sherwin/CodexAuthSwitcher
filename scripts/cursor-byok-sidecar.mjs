import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
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
        if (value.includes('Codex Auth Switcher Local CA') || value.trim() === certificate.trim()) return { state: 'ready', certFile };
    }
    return { state: 'untrusted', certFile };
}

async function generateCa() {
    await fs.mkdir(path.dirname(certFile), { recursive: true });
    const generated = selfsigned.generate([{ name: 'commonName', value: '*.cursor.sh' }], { days: 1825, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'basicConstraints', cA: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: '*.cursor.sh' }, { type: 2, value: 'cursor.sh' }] }] });
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
    const tlsServer = https.createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, async (request, response) => {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const upstream = await fetch(`${baseUrl}${request.url}`, { method: request.method, headers: request.headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
        response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
        response.end(Buffer.from(await upstream.arrayBuffer()));
    });
    const listener = http.createServer();
    listener.on('connect', (_request, socket) => { socket.pause(); socket.write('HTTP/1.1 200 Connection Established\r\n\r\n', () => { tlsServer.emit('connection', socket); socket.resume(); }); });
    listener.listen(0, '127.0.0.1');
    return new Promise((resolve, reject) => { listener.once('listening', () => { mitmServer = listener; resolve(`http://127.0.0.1:${listener.address().port}`); }); listener.once('error', reject); });
}

export function cursorByokExecutable() { return null; }
export async function prepareCursorByok() { await fs.mkdir(root, { recursive: true }); return { root }; }
export async function startCursorByok(options = {}) { await prepareCursorByok(options); await injectCursorAuthState(); await backupSettings(); const ca = await ensureCaTrust(); const proxyUrl = await startMitm(options.baseUrl); await applySettings(proxyUrl); return { running: true, pid: process.pid, proxyUrl, takeover: 'native-cursor-mitm', tabMode: 'native', tabAddress: options.baseUrl, ca }; }
export async function stopCursorByok({ restore = true } = {}) { await new Promise(resolve => mitmServer ? mitmServer.close(resolve) : resolve()); mitmServer = null; if (restore && await fs.stat(settingsBackup).catch(() => null)) { const stat = await fs.stat(settingsBackup); if (stat.size) await fs.copyFile(settingsBackup, settingsFile); else await fs.rm(settingsFile, { force: true }); await fs.rm(settingsBackup, { force: true }); } if (restore) await restoreCursorAuthState(); return { running: false, restored: restore }; }
export { caTrusted };
