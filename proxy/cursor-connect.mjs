// Minimal Connect/protobuf adapter for Cursor's native C++ completion endpoint.
// Cursor sends a length-prefixed protobuf envelope. We intentionally decode only
// the stable fields needed to build a completion prompt and ignore unknown fields.

function readVarint(buffer, offset) {
    let value = 0n;
    let shift = 0n;
    let position = offset;
    while (position < buffer.length) {
        const byte = buffer[position++];
        value |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return { value, offset: position };
        shift += 7n;
        if (shift > 70n) throw new Error('Invalid protobuf varint.');
    }
    throw new Error('Truncated protobuf varint.');
}

function skipField(buffer, offset, wireType) {
    if (wireType === 0) return readVarint(buffer, offset).offset;
    if (wireType === 1) return offset + 8;
    if (wireType === 2) {
        const length = readVarint(buffer, offset);
        const end = length.offset + Number(length.value);
        if (end > buffer.length) throw new Error('Truncated protobuf field.');
        return end;
    }
    if (wireType === 5) return offset + 4;
    throw new Error(`Unsupported protobuf wire type ${wireType}.`);
}

function fields(buffer) {
    const result = [];
    let offset = 0;
    while (offset < buffer.length) {
        const tag = readVarint(buffer, offset);
        offset = tag.offset;
        const field = Number(tag.value >> 3n);
        const wireType = Number(tag.value & 7n);
        if (!field) throw new Error('Invalid protobuf field number.');
        if (wireType === 2) {
            const length = readVarint(buffer, offset);
            offset = length.offset;
            const end = offset + Number(length.value);
            if (end > buffer.length) throw new Error('Truncated protobuf message.');
            result.push({ field, wireType, value: buffer.subarray(offset, end) });
            offset = end;
        } else if (wireType === 0) {
            const value = readVarint(buffer, offset);
            result.push({ field, wireType, value: value.value });
            offset = value.offset;
        } else {
            const end = skipField(buffer, offset, wireType);
            if (end > buffer.length) throw new Error('Truncated protobuf field.');
            result.push({ field, wireType, value: buffer.subarray(offset, end) });
            offset = end;
        }
    }
    return result;
}

function firstMessage(buffer, field) { return fields(buffer).find(item => item.field === field && item.wireType === 2)?.value; }
function firstString(buffer, field) {
    const value = firstMessage(buffer, field);
    return value ? Buffer.from(value).toString('utf8') : '';
}
function firstInt(buffer, field) {
    return Number(fields(buffer).find(item => item.field === field && item.wireType === 0)?.value || 0);
}

export function decodeStreamCppRequest(buffer) {
    const currentFile = firstMessage(buffer, 1) || Buffer.alloc(0);
    const position = firstMessage(currentFile, 3) || Buffer.alloc(0);
    return {
        model: firstString(buffer, 3),
        path: firstString(currentFile, 1),
        contents: firstString(currentFile, 2),
        line: firstInt(position, 1),
        column: firstInt(position, 2)
    };
}

function varint(value) {
    let current = BigInt(value);
    const bytes = [];
    do {
        let byte = Number(current & 0x7fn);
        current >>= 7n;
        if (current) byte |= 0x80;
        bytes.push(byte);
    } while (current);
    return Buffer.from(bytes);
}

function fieldString(number, value) {
    const bytes = Buffer.from(String(value), 'utf8');
    return Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);
}
function fieldBool(number, value) { return Buffer.concat([varint(number << 3), varint(value ? 1 : 0)]); }
function fieldMessage(number, value) { return Buffer.concat([varint((number << 3) | 2), varint(value.length), value]); }

export function encodeStreamCppResponse({ text = '', doneStream = false, doneEdit = false, startLine = 0,
    endLine = startLine } = {}) {
    const range = Buffer.concat([varint(8), varint(Math.max(1, startLine)), varint(16), varint(Math.max(1, endLine))]);
    const parts = [fieldString(1, text), fieldMessage(11, range)];
    if (doneStream) parts.push(fieldBool(4, true));
    if (doneEdit) parts.push(fieldBool(13, true));
    return Buffer.concat(parts);
}

// AvailableModelsResponse is deliberately encoded with the stable fields
// Cursor uses for the model picker. Unknown optional fields can be omitted;
// protobuf clients must treat them as their defaults.
export function encodeAvailableModelsResponse(modelNames = []) {
    const names = [...new Set(modelNames.filter(name => typeof name === 'string' && name.trim()))];
    if (!names.length) names.push('gpt-4o-mini');
    const modelEntries = names.map(name => fieldMessage(2, Buffer.concat([
        fieldString(1, name), fieldBool(2, true)
    ])));
    return Buffer.concat([
        ...names.map(name => fieldString(1, name)),
        ...modelEntries,
    ]);
}

export function decodeConnectEnvelopes(buffer) {
    const messages = [];
    let offset = 0;
    while (offset < buffer.length) {
        if (offset + 5 > buffer.length) throw new Error('Truncated Connect envelope.');
        const flags = buffer[offset++];
        const length = buffer.readUInt32BE(offset); offset += 4;
        if (offset + length > buffer.length) throw new Error('Truncated Connect message.');
        messages.push({ flags, message: buffer.subarray(offset, offset + length) });
        offset += length;
    }
    return messages;
}

export function connectEnvelope(message, flags = 0) {
    const header = Buffer.alloc(5);
    header[0] = flags;
    header.writeUInt32BE(message.length, 1);
    return Buffer.concat([header, message]);
}

export function cursorPrompt(request) {
    const lines = request.contents.split(/\r?\n/);
    const line = Math.max(0, Math.min(lines.length - 1, request.line));
    const prefix = lines.slice(0, line + 1).join('\n');
    return [`Complete the code at the cursor. Return only the completion text.`,
        `File: ${request.path || 'untitled'}`, `Language: ${request.path?.split('.').pop() || 'text'}`,
        `Cursor line: ${line + 1}, column: ${request.column}`, '```', prefix, '```'].join('\n');
}

// Chat requests contain many nested protobuf messages.  The human prompt is
// represented as one or more UTF-8 length-delimited fields, so collect the
// readable leaves and use the longest recent value as a provider prompt.
export function extractCursorChatPrompt(buffer) {
    const values = [];
    const visit = (message, depth = 0) => {
        if (depth > 8) return;
        let items;
        try { items = fields(message); } catch { return; }
        for (const item of items) {
            if (item.wireType !== 2 || !Buffer.isBuffer(item.value)) continue;
            const text = item.value.toString('utf8');
            if (text && !text.includes('\u0000') && /[\p{L}\p{N}]/u.test(text)) values.push(text);
            visit(item.value, depth + 1);
        }
    };
    visit(buffer);
    return values.filter(value => value.length <= 20000).sort((a, b) => b.length - a.length)[0] || '';
}

export function encodeStreamChatResponse(text = '') {
    return fieldString(1, text);
}
