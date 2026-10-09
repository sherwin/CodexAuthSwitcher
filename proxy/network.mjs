import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import TOML from '@iarna/toml';
import { locked, readJSON, writeJSON, atomicWrite, codexDirectory, provider, ProxyError } from './storage.mjs';

export const defaultPort = 18888;
export function isLoopback(address = '') {
    return address === '::1' || /^127\./.test(address) || /^::ffff:127\./.test(address);
}
export function isPrivateAddress(address = '') {
    const ip = address.replace(/^::ffff:/, '');
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    return parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 169 && parts[1] === 254);
}
export function lanAddresses(interfaces = os.networkInterfaces()) {
    return [...new Set(Object.values(interfaces).flat().filter(item => item && !item.internal &&
        (item.family === 'IPv4' || item.family === 4) && isPrivateAddress(item.address)).map(item => item.address))];
}
export function validateNetwork(input) {
    if (typeof input?.lan_enabled !== 'boolean' || !Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) {
        throw new ProxyError('端口必须为 1024–65535 的整数。', 'invalid_network_settings', 400);
    }
    return { port: input.port, lan_enabled: input.lan_enabled };
}

export function shareHost(health, target) {
    if (!health.lan_enabled) {
        if (target && target !== '127.0.0.1') throw new ProxyError('局域网访问未开启。', 'lan_disabled', 400);
        return '127.0.0.1';
    }
    const addresses = health.lan_addresses || [];
    if (!addresses.length) throw new ProxyError('未发现局域网 IPv4 地址，请检查网络连接。', 'lan_ip_unavailable', 400);
    const host = !target || target === '127.0.0.1' ? addresses[0] : target;
    if (!addresses.includes(host)) throw new ProxyError('此局域网地址当前不可用。', 'lan_ip_unavailable', 400);
    return host;
}

export async function changeNetwork(directory, input, { gateway, startGateway,
    config = path.join(codexDirectory, 'config.toml') }) {
    const network = validateNetwork(input);
    return locked(path.join(directory, 'state.mutex'), async () => {
        const statePath = path.join(directory, 'proxy.json');
        const originalState = await readJSON(statePath);
        let originalConfig;
        let updatedConfig;
        const state = { ...originalState, ...network };
        if (state.enabled && originalState.port !== state.port) {
            originalConfig = await fs.readFile(config, 'utf8');
            const parsed = TOML.parse(originalConfig);
            if (parsed.model_provider !== provider || parsed.model_providers?.[provider]?.base_url !==
                `http://127.0.0.1:${originalState.port}/v1`) {
                throw new ProxyError('Codex 的代理配置已被修改，请先检查配置后再改端口。', 'config_changed', 409);
            }
            const begin = '# BEGIN CodexAuthSwitcher local proxy';
            const end = '# END CodexAuthSwitcher local proxy';
            const start = originalConfig.indexOf(begin);
            const finish = originalConfig.indexOf(end);
            if (start < 0 || finish < start) throw new ProxyError('代理配置标记不完整。', 'config_changed', 409);
            const section = originalConfig.slice(start, finish);
            updatedConfig = originalConfig.slice(0, start).replace(/^openai_base_url\s*=.*$/m,
                `openai_base_url = "http://127.0.0.1:${state.port}/v1"`) + section.replace(/^base_url\s*=.*$/gm,
                `base_url = "http://127.0.0.1:${state.port}/v1"`) + originalConfig.slice(finish);
            TOML.parse(updatedConfig);
            const hash = value => createHash('sha256').update(value).digest('hex');
            if (hash(originalConfig) === state.installed_config_hash) state.installed_config_hash = hash(updatedConfig);
            await atomicWrite(path.join(directory, `before-port-${randomUUID()}.toml`), originalConfig);
        }
        gateway.pause();
        await gateway.close();
        try {
            if (updatedConfig !== undefined) await atomicWrite(config, updatedConfig);
            await writeJSON(statePath, state);
            return { gateway: await startGateway(directory), configChanged: updatedConfig !== undefined };
        } catch (error) {
            if (originalConfig !== undefined) await atomicWrite(config, originalConfig);
            await writeJSON(statePath, originalState);
            try { error.restoredGateway = await startGateway(directory); } catch { /* Caller reports service unavailable. */ }
            throw error;
        }
    });
}
