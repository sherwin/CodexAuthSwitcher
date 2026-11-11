import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TokenStatistics } from '../proxy/statistics.mjs';

const at = value => Date.parse(value + '+08:00');
const usage = { input_tokens: 8, output_tokens: 2, total_tokens: 10 };
async function fixture(t) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'statistics-range-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return new TokenStatistics(directory);
}

test('minute, hour, natural day and multi-day ranges filter all metrics and buckets consistently', async t => {
    const stats = await fixture(t);
    const now = at('2026-11-11T00:05:30');
    const account = { id: 'a', name: 'account.json' };
    for (const value of ['2026-10-13T12:00:00', '2026-11-05T12:00:00', '2026-11-10T12:00:00',
        '2026-11-10T23:20:00', '2026-11-10T23:58:00', '2026-11-11T00:02:00']) await stats.record(account, usage, at(value));
    await stats.record(account, undefined, at('2026-11-11T00:03:00'));
    const expected = { 'ten-minutes': [20, 3, 'minute', 10], hour: [30, 4, 'minute', 60],
        'natural-day': [10, 2, 'hour', 1], week: [50, 6, 'day', 8], month: [60, 7, 'day', 31], year: [60, 7, 'day', 366] };
    for (const [period, [tokens, requests, granularity, length]] of Object.entries(expected)) {
        const data = await stats.range({ period }, now);
        assert.equal(data.totals.total_tokens, tokens, period);
        assert.equal(data.totals.requests, requests, period);
        assert.equal(data.totals.unknown_requests, 1);
        assert.equal(data.granularity, granularity);
        assert.equal(data.buckets.length, length);
        assert.equal(data.totals.buckets.reduce((sum, value) => sum + value, 0), tokens);
        assert.equal(data.accounts[0].total_tokens, tokens);
    }
    const custom = await stats.range({ period: 'custom', start: at('2026-11-10T23:20:00'), end: at('2026-11-10T23:58:00') }, now);
    assert.equal(custom.totals.total_tokens, 10, 'custom end is exclusive');
    assert.equal(custom.totals.requests, 1);
    assert.equal(custom.buckets.length, 38);
});

test('legacy totals remain available for full days and are never passed off as minute statistics', async t => {
    const stats = await fixture(t);
    await mkdir(stats.directory, { recursive: true });
    const fields = { requests: 2, measured_requests: 1, unknown_requests: 1, input_tokens: 8,
        output_tokens: 2, total_tokens: 10, cached_tokens: 0, reasoning_tokens: 0 };
    await writeFile(path.join(stats.directory, '2026-11-11.json'), JSON.stringify({ accounts: {
        a: { id: 'a', name: 'account.json', aliases: [], ...fields, hours: Array.from({ length: 24 }, (_, i) => i === 10 ? 10 : 0) }
    } }));
    const now = at('2026-11-11T10:30:00');
    await stats.record({ id: 'a', name: 'renamed.json' }, usage, at('2026-11-11T10:29:00'));
    const today = await stats.range({ period: 'natural-day' }, now);
    assert.equal(today.totals.total_tokens, 20);
    assert.equal(today.totals.requests, 3);
    assert.equal(today.totals.buckets.reduce((a, b) => a + b, 0), 20);
    assert.equal(today.incomplete_history, false);
    const short = await stats.range({ period: 'ten-minutes' }, now);
    assert.equal(short.totals.total_tokens, 10);
    assert.equal(short.totals.requests, 1);
    assert.equal(short.incomplete_history, true);
});

test('range validation rejects invalid, reversed, future and unbounded custom queries', async t => {
    const stats = await fixture(t);
    const now = at('2026-11-11T10:30:00');
    for (const input of [{ period: 'missing' }, { period: 'custom' },
        { period: 'custom', start: now, end: now }, { period: 'custom', start: now + 60000, end: now + 120000 },
        { period: 'custom', start: now - 367 * 86400000, end: now },
        { period: 'custom', start: now - 60001, end: now }]) {
        await assert.rejects(stats.range(input, now), { code: 'invalid_statistics_range' });
    }
});
