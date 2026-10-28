import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const authBackupMarker = '.codex-auth-switcher-cursor-auth-backup';
const localAccountEmail = 'cursor@ai.com';
// Keep the same synthetic session shape as cursor-byok's local account
// service. Its HTTPS proxy uses the subject to decide whether auth/profile
// requests can be answered locally instead of going to Cursor's servers.
const localAuthToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImN1cnNvckBhaS5jb20iLCJleHAiOjQwNzA5MDg4MDAsImlzcyI6ImN1cnNvci1jbGllbnQiLCJzY29wZSI6Im9wZW5pZCBwcm9maWxlIGVtYWlsIiwic3ViIjoiY3Vyc29yLWxvY2FsLXVzZXIiLCJ0eXBlIjoic2Vzc2lvbiJ9.cursor-local-user';

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
        'cursorAuth/stripeMembershipAuthId': 'cursor-local-user',
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
