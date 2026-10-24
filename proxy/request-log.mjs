import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { atomicWrite } from './storage.mjs';

const require = createRequire(import.meta.url);

const schema = `
CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    account TEXT,
    status INTEGER,
    success INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    request_body TEXT NOT NULL,
    response_body TEXT NOT NULL,
    error_code TEXT
);
CREATE INDEX IF NOT EXISTS request_logs_started_at_idx ON request_logs(started_at DESC);
`;

function jsonBody(value) {
    if (value === undefined || value === null) return '';
    try { return JSON.stringify(value); } catch { return String(value); }
}

export async function createRequestLog(directory) {
    const SQL = await initSqlJs({ locateFile: file => path.join(path.dirname(require.resolve('sql.js')), file) });
    const file = path.join(directory, 'requests.sqlite3');
    const bytes = await fs.readFile(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    const db = new SQL.Database(bytes || undefined);
    db.run(schema);
    let writeQueue = Promise.resolve();
    const persist = () => {
        const output = Buffer.from(db.export());
        writeQueue = writeQueue.then(() => atomicWrite(file, output));
        return writeQueue;
    };
    return {
        async record(entry) {
            db.run(`INSERT INTO request_logs
                (started_at, finished_at, method, path, account, status, success, duration_ms, request_body, response_body, error_code)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                entry.startedAt, entry.finishedAt, entry.method, entry.path, entry.account || null,
                Number.isInteger(entry.status) ? entry.status : null, entry.success ? 1 : 0,
                Math.max(0, Number(entry.durationMs) || 0), jsonBody(entry.requestBody),
                typeof entry.responseBody === 'string' ? entry.responseBody : jsonBody(entry.responseBody), entry.errorCode || null]);
            await persist();
        },
        list(limit = 15, offset = 0) {
            const safeLimit = Math.min(100, Math.max(1, Number(limit) || 15));
            const safeOffset = Math.max(0, Number(offset) || 0);
            const result = db.exec(`SELECT id, started_at AS startedAt, finished_at AS finishedAt, method, path,
                account, status, success, duration_ms AS durationMs, error_code AS errorCode
                FROM request_logs ORDER BY id DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`);
            const [table] = result;
            if (!table) return [];
            return table.values.map(values => Object.fromEntries(table.columns.map((key, index) => [key, values[index]])));
        },
        count() {
            const result = db.exec('SELECT COUNT(*) AS count FROM request_logs');
            return Number(result[0]?.values[0]?.[0] || 0);
        },
        get(id) {
            const result = db.exec(`SELECT id, started_at AS startedAt, finished_at AS finishedAt, method, path,
                account, status, success, duration_ms AS durationMs, request_body AS requestBody,
                response_body AS responseBody, error_code AS errorCode FROM request_logs WHERE id = ${Number(id) || 0}`);
            const [table] = result;
            if (!table?.values.length) return null;
            return Object.fromEntries(table.columns.map((key, index) => [key, table.values[0][index]]));
        },
        async close() { await persist(); db.close(); }
    };
}
