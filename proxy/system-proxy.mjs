import { fetch as undiciFetch, Agent, ProxyAgent } from 'undici';
import { ProxyError } from './storage.mjs';

// Electron resolves the Windows system/PAC/bypass rules; inference stays in Node.
export function proxyAddress(directives) {
    for (const item of String(directives).split(';')) {
        const value = item.trim();
        if (value === 'DIRECT') return null;
        const match = /^(PROXY|HTTPS)\s+(\S+)$/i.exec(value);
        if (match) {
            try {
                const endpoint = /^(?:\[[0-9a-f:]+\]|[a-z0-9_.-]+):(\d+)$/i.exec(match[2]);
                if (!endpoint || Number(endpoint[1]) < 1 || Number(endpoint[1]) > 65535) throw Error();
                const address = new URL((match[1].toUpperCase() === 'HTTPS' ? 'https://' : 'http://') + match[2]);
                return address.origin;
            } catch { throw new ProxyError('系统 HTTP 代理地址无效。', 'invalid_system_proxy', 503); }
        }
        if (/^SOCKS/i.test(value)) throw new ProxyError('请将系统代理设置为 HTTP/HTTPS 代理。', 'unsupported_system_proxy', 503);
    }
    throw new ProxyError('无法解析系统代理设置。', 'invalid_system_proxy', 503);
}
export function systemProxyFetch(resolveProxy, { request = undiciFetch,
    createAgent = address => address ? new ProxyAgent(address) : new Agent({ headersTimeout: 300000, bodyTimeout: 300000 }) } = {}) {
    const agents = new Map();
    return async (url, options = {}) => {
        const address = proxyAddress(await resolveProxy(String(url)));
        if (!agents.has(address)) agents.set(address, createAgent(address));
        return request(url, { ...options, dispatcher: agents.get(address) });
    };
}
