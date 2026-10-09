import { ProxyError } from './storage.mjs';

// A bounded side-channel parser; it never edits bytes forwarded to a streaming client.
export function eventObserver(onEvent, limit = 32 * 1024 * 1024) {
    const decoder = new TextDecoder();
    let line = '';
    let skipLF = false;
    let data = [];
    let name = '';
    let size = 0;
    function dispatch() {
        const payload = data.join('\n');
        data = [];
        size = 0;
        const type = name;
        name = '';
        if (!payload || payload === '[DONE]') return;
        let event;
        try { event = JSON.parse(payload); }
        catch { throw new ProxyError('上游事件格式无效。', 'invalid_upstream_event', 502); }
        onEvent({ ...event, type: event.type || type });
    }
    function consumeLine() {
        if (!line) dispatch();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('event:')) name = line.slice(6).trim();
        line = '';
    }
    function consume(text) {
        for (const char of text) {
            if (++size > limit) throw new ProxyError('上游事件超过大小限制。', 'response_too_large', 502);
            if (skipLF) { skipLF = false; if (char === '\n') continue; }
            if (char === '\r' || char === '\n') { consumeLine(); skipLF = char === '\r'; }
            else line += char;
        }
    }
    return { push: chunk => consume(decoder.decode(chunk, { stream: true })), finish: () => {
        consume(decoder.decode());
        if (line) consumeLine();
        dispatch();
    } };
}
