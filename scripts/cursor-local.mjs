import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const localUrl = process.env.CODEX_AUTH_SWITCHER_CURSOR_URL || 'http://127.0.0.1:18888';
const marker = '.codex-auth-switcher-cursor-backup';
const targetFile = path.join('out', 'vs', 'workbench', 'workbench.desktop.main.js');
const authBackupMarker = '.codex-auth-switcher-cursor-auth-backup';
const localAccountEmail = 'cursor@ai.com';
const localAuthToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjb2RleC1hdXRoLXN3aXRjaGVyIiwidHlwZSI6InNlc3Npb24iLCJpc3MiOiJsb2NhbCIsImV4cCI6NDA3MDkwODAwMH0.local-auth-switcher';

export function cursorStateDatabase(platform = process.platform, env = process.env, home = os.homedir()) {
    if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

export function localCursorAuthValues() {
    return {
        'cursorAuth/accessToken': localAuthToken,
        'cursorAuth/cachedEmail': localAccountEmail,
        'cursorAuth/cachedSignUpType': 'Google',
        'cursorAuth/refreshToken': localAuthToken,
        'cursorAuth/stripeMembershipType': 'ultra',
        'cursorAuth/stripeSubscriptionStatus': 'active'
    };
}

async function readSqlite(file) {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs({ locateFile: name => path.join(path.dirname(require.resolve('sql.js')), name) });
    const bytes = await fs.readFile(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    return { SQL, db: new SQL.Database(bytes || undefined) };
}

export async function injectCursorAuthState(file = cursorStateDatabase()) {
    const backup = `${file}${authBackupMarker}`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (!(await fs.stat(backup).catch(() => null))) await fs.copyFile(file, backup).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return fs.writeFile(backup, Buffer.alloc(0));
    });
    const { db } = await readSqlite(file);
    db.run('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    const statement = db.prepare('INSERT OR REPLACE INTO ItemTable(key, value) VALUES (?, ?)');
    try {
        for (const [key, value] of Object.entries(localCursorAuthValues())) statement.run([key, value]);
    } finally { statement.free(); }
    const bytes = db.export();
    db.close();
    const temporary = `${file}.codex-auth-switcher-tmp`;
    await fs.writeFile(temporary, Buffer.from(bytes));
    await fs.rename(temporary, file);
    return { ok: true, file, backup, email: localAccountEmail };
}

export async function restoreCursorAuthState(file = cursorStateDatabase()) {
    const backup = `${file}${authBackupMarker}`;
    if (!(await fs.stat(backup).catch(() => null))) return { ok: true, restored: false, file };
    const stat = await fs.stat(backup);
    if (stat.size === 0) await fs.rm(file, { force: true });
    else await fs.copyFile(backup, file);
    await fs.rm(backup, { force: true });
    return { ok: true, restored: true, file };
}

export function candidateRoots(platform = process.platform, env = process.env) {
    if (platform === 'win32') return [
        env.CURSOR_INSTALL_DIR ? path.join(env.CURSOR_INSTALL_DIR, 'resources', 'app') : null,
        'C:\\Installs\\cursor\\resources\\app',
        path.join(env.LOCALAPPDATA || '', 'Programs', 'cursor', 'resources', 'app'),
        path.join(env.ProgramFiles || '', 'Cursor', 'resources', 'app')
    ].filter(Boolean);
    if (platform === 'darwin') return ['/Applications/Cursor.app/Contents/Resources/app',
        path.join(env.HOME || os.homedir(), 'Applications', 'Cursor.app', 'Contents', 'Resources', 'app')];
    return [path.join(env.HOME || os.homedir(), '.local', 'share', 'cursor', 'resources', 'app')];
}

export function patchCursorSource(source, url = localUrl) {
    const upstreamHosts = ['https://api4.cursor.sh', 'https://api3.cursor.sh', 'https://api2.cursor.sh', 'https://api.cursor.com'];
    // An older build may already have api4 pointed at the gateway while api2
    // and api3 are still official. Only skip when every supported upstream
    // host is absent, so re-enabling repairs a partially patched workbench.
    if (!upstreamHosts.some(host => source.includes(host))) return source;
    // Cursor splits completion, account and dashboard traffic across these
    // hosts. Replacing only api4 leaves the login/session probes on api2 and
    // api3, which makes the injected local session look unauthenticated.
    const replacements = [
        ['https://api4.cursor.sh', url],
        ['https://api3.cursor.sh', url],
        ['https://api2.cursor.sh', url],
        ['https://api.cursor.com', url]
    ];
    let result = source;
    for (const [from, to] of replacements) result = result.replaceAll(from, to);
    // Cursor still gates Chat behind its hosted session even after the local
    // backend URL is redirected.  The local gateway supplies the account
    // probes, so make the workbench use that local session for the two checks
    // that otherwise open the hosted login flow.  These replacements are
    // idempotent and are intentionally scoped to the current minified auth
    // service shape.
    result = result.replace(
        'isAuthenticated(){const F=this.t(),x=this.s();return!!(F&&x)}',
        'isAuthenticated(){return!0}'
    );
    result = result.replace(
        'async getAuthenticationHeader(){const F=await this.getAccessToken();return F?{Authorization:`Bearer ${F}`}:{}}',
        'async getAuthenticationHeader(){return{Authorization:"Bearer local-cursor-token"}}'
    );
    if (result === source) throw new Error('未找到当前 Cursor 版本的补全后端地址，可能需要更新适配规则。');
    return result;
}

export async function locateFile(fileOverride = process.env.CURSOR_WORKBENCH_FILE) {
    if (fileOverride) return fileOverride;
    for (const root of candidateRoots()) {
        const file = path.join(root, targetFile);
        if (await fs.stat(file).then(stat => stat.isFile()).catch(() => false)) return file;
    }
    throw new Error('未找到解包的 Cursor workbench 文件。请先关闭 Cursor，并使用解包目录或配置 CURSOR_WORKBENCH_FILE。');
}

export async function locateCursorTarget() {
    for (const root of candidateRoots()) {
        const unpacked = path.join(root, targetFile);
        if (await fs.stat(unpacked).then(stat => stat.isFile()).catch(() => false)) return { type: 'file', file: unpacked };
        const archive = path.join(root, '..', 'app.asar');
        if (await fs.stat(archive).then(stat => stat.isFile()).catch(() => false)) return { type: 'asar', file: archive };
    }
    throw new Error('未找到 Cursor 的 workbench 文件或 app.asar。请先关闭 Cursor。');
}

export async function patchAsar(archive, action, url = localUrl) {
    const { extractAll, createPackage } = await import('@electron/asar');
    const backup = `${archive}${marker}`;
    if (action === 'disable') {
        await fs.copyFile(backup, archive);
        return { ok: true, action: 'disabled', file: archive };
    }
    if (!(await fs.stat(backup).catch(() => null))) await fs.copyFile(archive, backup);
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cursor-'));
    try {
        await extractAll(archive, temp);
        const file = path.join(temp, targetFile);
        const source = await fs.readFile(file, 'utf8');
        await fs.writeFile(file, patchCursorSource(source, url), 'utf8');
        const rebuilt = `${archive}.new`;
        await createPackage(temp, rebuilt);
        await fs.rm(archive, { force: true });
        await fs.rename(rebuilt, archive);
        return { ok: true, action: 'enabled', file: archive, backup, baseUrl: url };
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

export async function enableCursor(file, url = localUrl) {
    const backup = `${file}${marker}`;
    if (!(await fs.stat(backup).catch(() => null))) await fs.copyFile(file, backup);
    const source = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, patchCursorSource(source, url), 'utf8');
    return { ok: true, action: 'enabled', file, backup, baseUrl: url };
}

export async function disableCursor(file) {
    const backup = `${file}${marker}`;
    await fs.copyFile(backup, file);
    return { ok: true, action: 'disabled', file };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const target = await locateCursorTarget();
    const action = process.argv[2] || 'enable';
    const result = target.type === 'asar' ? await patchAsar(target.file, action) :
        action === 'enable' ? await enableCursor(target.file) : action === 'disable' ? await disableCursor(target.file) : null;
    if (!result) throw new Error('用法：node scripts/cursor-local.mjs enable|disable');
    console.log(JSON.stringify(result));
}
