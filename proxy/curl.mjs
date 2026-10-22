const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function curlCommand(state, _config = '', { masked = false, platform = process.platform, host = '127.0.0.1', stream = false,
    model = state.selected_provider === 'deepseek' ? 'deepseek-flash' : 'gpt-6.1-sol' } = {}) {
    if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535 ||
        typeof state.key !== 'string' || !state.key || /[\r\n]/.test(state.key)) {
        throw new Error('Local proxy configuration is invalid.');
    }
    const deepseek = state.selected_provider === 'deepseek';
    const body = JSON.stringify(deepseek ? { model,
        messages: [{ role: 'user', content: 'Reply with exactly PROXY_OK.' }], stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}) } : { model, instructions: 'You are a helpful assistant.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly PROXY_OK.' }] }],
        stream, store: false });
    const shellQuote = platform === 'win32' ? value => "'" + value.replaceAll("'", "''") + "'" : quote;
    const continuation = platform === 'win32' ? ' `\n  ' : ' \\\n  ';
    return [(platform === 'win32' ? 'curl.exe' : 'curl') + (stream ? ' --no-buffer' : ' --silent --show-error') + ' --fail-with-body',
        shellQuote(`http://${host}:${state.port}/v1/${deepseek ? 'chat/completions' : 'responses'}`),
        '-H ' + shellQuote('Content-Type: application/json'),
        '-H ' + shellQuote(`Authorization: Bearer ${masked ? '<LOCAL_PROXY_KEY>' : state.key}`),
        '--data-raw ' + shellQuote(body)].join(continuation);
}
