import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const localUrl = process.env.CODEX_AUTH_SWITCHER_CURSOR_URL || 'http://127.0.0.1:18888';
const marker = '.codex-auth-switcher-cursor-backup';
const targetFile = path.join('out', 'vs', 'workbench', 'workbench.desktop.main.js');

export function candidateRoots(platform = process.platform, env = process.env) {
    if (platform === 'win32') return [path.join(env.LOCALAPPDATA || '', 'Programs', 'cursor', 'resources', 'app')];
    if (platform === 'darwin') return ['/Applications/Cursor.app/Contents/Resources/app',
        path.join(env.HOME || os.homedir(), 'Applications', 'Cursor.app', 'Contents', 'Resources', 'app')];
    return [path.join(env.HOME || os.homedir(), '.local', 'share', 'cursor', 'resources', 'app')];
}

export function patchCursorSource(source, url = localUrl) {
    const replacements = [
        ['ykt="https://api4.cursor.sh"', `ykt="${url}"`],
        ['SWe="https://api4.cursor.sh"', `SWe="${url}"`],
        // Cursor renamed the minified variable names in newer releases. The
        // native completion and completion-config backends still use the
        // api4 host, so replace those URL literals without relying on names.
        ['https://api4.cursor.sh', url]
    ];
    let result = source;
    for (const [from, to] of replacements) result = result.replaceAll(from, to);
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
