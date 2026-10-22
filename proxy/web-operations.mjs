import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readJSON, writeJSON, locked, ProxyError } from './storage.mjs';
import { createGateway } from './server.mjs';
import { changeNetwork, validateNetwork, shareHost } from './network.mjs';
import { curlCommand } from './curl.mjs';

export function createWebOperations(directory, { call, gateway,
    startGateway = directory => createGateway(directory), config } = {}) {
    let currentGateway = gateway, busy = false;
    const stateFile = path.join(directory, 'proxy.json');
    async function exclusive(action) {
        if (busy) throw new ProxyError('服务设置正在更新，请稍后重试。', 'settings_busy', 409);
        if (!currentGateway) throw new ProxyError('当前服务不支持修改设置。', 'gateway_unavailable', 503);
        busy = true;
        try { return await action(); } finally { busy = false; }
    }
    return {
        get busy() { return busy; },
        close: () => currentGateway?.close(),
        async directories(input) {
            const state = await readJSON(stateFile);
            if (input && !path.isAbsolute(input))
                throw new ProxyError('请输入 Surface 上的绝对目录路径。', 'invalid_directory', 400);
            const target = await fs.realpath(input || state.auth_directory);
            const entries = await fs.readdir(target, { withFileTypes: true });
            return { path: target, parent: path.dirname(target), directories: entries
                .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
                .map(entry => ({ name: entry.name, path: path.join(target, entry.name) }))
                .sort((a, b) => a.name.localeCompare(b.name)) };
        },
        network: input => exclusive(async () => {
            const settings = validateNetwork(input);
            try {
                const result = await changeNetwork(directory, settings, { gateway: currentGateway, startGateway, config });
                currentGateway = result.gateway;
                return { ok: true, configChanged: result.configChanged };
            } catch (error) {
                if (error.restoredGateway) currentGateway = error.restoredGateway;
                throw error;
            }
        }),
        directory: input => exclusive(async () => {
            if (typeof input?.path !== 'string' || !path.isAbsolute(input.path))
                throw new ProxyError('请输入 Surface 上的绝对目录路径。', 'invalid_directory', 400);
            const target = await fs.realpath(input.path);
            if (!(await fs.stat(target)).isDirectory())
                throw new ProxyError('请选择已有目录。', 'invalid_directory', 400);
            return locked(path.join(directory, 'state.mutex'), async () => {
                const original = await readJSON(stateFile);
                currentGateway.pause();
                await currentGateway.close();
                try {
                    const state = { ...original, auth_directory: target };
                    delete state.selected_file;
                    await writeJSON(stateFile, state);
                    currentGateway = await startGateway(directory);
                    return { ok: true };
                } catch (error) {
                    await writeJSON(stateFile, original);
                    currentGateway = await startGateway(directory);
                    throw error;
                }
            });
        }),
        async curl(input) {
            if (!['preview', 'copy'].includes(input?.action))
                throw new ProxyError('不支持的命令操作。', 'invalid_action', 400);
            const state = await readJSON(stateFile), health = await call('/health');
            return { command: curlCommand({ ...state, selected_provider: health.selected_provider }, '', { masked: input.action === 'preview',
                host: shareHost(health, input.target), stream: input.stream === true }) };
        },
    };
}
