import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { configureModel } from '../scripts/cursor-byok-sidecar.mjs';

function server(handler) {
    const instance = http.createServer(handler);
    return new Promise(resolve => instance.listen(0, '127.0.0.1', () => resolve(instance)));
}

test('configures a cursor-byok OpenAI model through its control API', async () => {
    let posted;
    const instance = await server(async (request, response) => {
        if (request.method === 'GET') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ data: [] }));
            return;
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        posted = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ model_hash: 'local-test-model' }));
    });
    try {
        const result = await configureModel(`http://127.0.0.1:${instance.address().port}/__byok-api__`, {
            baseUrl: 'http://127.0.0.1:18888', key: 'local-test-key', model: 'gpt-6.1-sol'
        });
        assert.equal(result.model_hash, 'local-test-model');
        assert.equal(posted.type, 'openai');
        assert.equal(posted.openai_endpoint, '/v1/responses');
        assert.equal(posted.base_url, 'http://127.0.0.1:18888');
        assert.equal(posted.model_id, 'gpt-6.1-sol');
        assert.ok(posted.context_window_tokens > 0);
    } finally {
        instance.close();
    }
});

test('does not duplicate an existing cursor-byok model', async () => {
    let postCount = 0;
    const instance = await server((_request, response) => {
        if (_request.method === 'POST') postCount += 1;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [{ model_id: 'gpt-6.1-sol', base_url: 'http://127.0.0.1:18888' }] }));
    });
    try {
        await configureModel(`http://127.0.0.1:${instance.address().port}/__byok-api__`, {
            baseUrl: 'http://127.0.0.1:18888', key: 'local-test-key', model: 'gpt-6.1-sol'
        });
        assert.equal(postCount, 0);
    } finally {
        instance.close();
    }
});
