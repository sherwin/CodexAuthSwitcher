import { ProxyError } from './storage.mjs';

// Keep only the final Responses object, not delta snapshots or partially generated output.
export async function collectResponse(body, limit = 32 * 1024 * 1024, onResponse = () => {}) {
    if (!body) throw new ProxyError('上游未返回响应内容。', 'upstream_empty_response', 502);
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let line = '';
    let skipLF = false;
    let data = [];
    let eventName = '';
    let final;
    function dispatch() {
        if (!data.length) { eventName = ''; return; }
        const payload = data.join('\n');
        data = [];
        const type = eventName;
        eventName = '';
        if (payload === '[DONE]') return;
        let event;
        try { event = JSON.parse(payload); }
        catch { throw new ProxyError('上游事件格式无效。', 'invalid_upstream_event', 502); }
        const name = event.type || type;
        if (['response.completed', 'response.incomplete', 'response.failed'].includes(name)) onResponse(event.response);
        if (name === 'error' || name === 'response.failed') {
            const code = String(event.response?.error?.code || event.error?.code || event.code || 'upstream_response_failed')
                .replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
            throw new ProxyError('上游生成失败。', code, 502);
        }
        if (name === 'response.completed' || name === 'response.incomplete') {
            if (event.response?.object !== 'response' || !Array.isArray(event.response.output) ||
                !['completed', 'incomplete'].includes(event.response.status)) {
                throw new ProxyError('上游最终响应格式无效。', 'invalid_upstream_response', 502);
            }
            final = event.response;
        }
    }
    function consumeLine() {
        if (!line) dispatch();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('event:')) eventName = line.slice(6).trim();
        line = '';
    }
    function consume(text) {
        for (const char of text) {
            if (skipLF) { skipLF = false; if (char === '\n') continue; }
            if (char === '\r' || char === '\n') { consumeLine(); skipLF = char === '\r'; }
            else line += char;
            if (final) return;
        }
    }
    try {
        while (!final) {
            const chunk = await reader.read();
            if (chunk.done) {
                consume(decoder.decode());
                if (line) consumeLine();
                dispatch();
                break;
            }
            size += chunk.value.byteLength;
            if (size > limit) throw new ProxyError('非流式响应超过大小限制，请使用流式请求。', 'response_too_large', 502);
            consume(decoder.decode(chunk.value, { stream: true }));
        }
        if (!final) throw new ProxyError('上游连接结束，但没有完整响应，请勿将部分结果当作成功。', 'upstream_stream_incomplete', 502);
        return final;
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
