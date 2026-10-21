import path from 'node:path';
import { createHash } from 'node:crypto';
import { locked, readJSON, writeJSON } from './storage.mjs';
import { identity } from './credentials.mjs';

const hourCount = 24;
const dayMilliseconds = 86400000;
const fields = ['requests', 'measured_requests', 'unknown_requests', 'input_tokens', 'output_tokens',
    'total_tokens', 'cached_tokens', 'reasoning_tokens'];
const empty = () => Object.fromEntries(fields.map(field => [field, 0]));
export function beijingTime(now = Date.now()) {
    const shifted = new Date(now + 8 * 3600000);
    return { day: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours() };
}
export function usageAccount(name, record) {
    const ids = identity(record);
    const key = record.OPENAI_API_KEY || record.DEEPSEEK_API_KEY || record.api_key;
    const source = key ? 'api:' + key : ids.every(Boolean) ? JSON.stringify(ids) : 'file:' + name;
    return { id: createHash('sha256').update(source).digest('hex'), name };
}
export function normalizedUsage(usage) {
    const valid = value => Number.isSafeInteger(value) && value >= 0;
    if (usage && valid(usage.prompt_tokens) && valid(usage.completion_tokens)) {
        return { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens,
            total_tokens: valid(usage.total_tokens) ? usage.total_tokens : usage.prompt_tokens + usage.completion_tokens,
            cached_tokens: valid(usage.prompt_tokens_details?.cached_tokens) ? usage.prompt_tokens_details.cached_tokens : 0,
            reasoning_tokens: 0 };
    }
    if (!usage || !valid(usage.input_tokens) || !valid(usage.output_tokens)) return null;
    const total = valid(usage.total_tokens) ? usage.total_tokens : usage.input_tokens + usage.output_tokens;
    if (!valid(total)) return null;
    return { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: total,
        cached_tokens: valid(usage.input_tokens_details?.cached_tokens) ? usage.input_tokens_details.cached_tokens : 0,
        reasoning_tokens: valid(usage.output_tokens_details?.reasoning_tokens) ? usage.output_tokens_details.reasoning_tokens : 0 };
}
export class TokenStatistics {
    constructor(directory) { this.directory = path.join(directory, 'statistics'); }
    async load(day) {
        try { return await readJSON(path.join(this.directory, day + '.json')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; return { version: 1, day, accounts: {} }; }
    }
    async record(account, usage, now = Date.now()) {
        const { day, hour } = beijingTime(now);
        await locked(path.join(this.directory, day + '.mutex'), async () => {
            const data = await this.load(day);
            const item = data.accounts[account.id] ||= { id: account.id, name: account.name, aliases: [], ...empty(),
                hours: Array.from({ length: hourCount }, () => 0) };
            item.name = account.name;
            if (!item.aliases.includes(account.name)) item.aliases.push(account.name);
            item.requests++;
            const tokens = normalizedUsage(usage);
            if (tokens) {
                item.measured_requests++;
                for (const [field, value] of Object.entries(tokens)) item[field] += value;
                item.hours[hour] += tokens.total_tokens;
            } else item.unknown_requests++;
            data.updated_at = new Date(now).toISOString();
            await writeJSON(path.join(this.directory, day + '.json'), data);
        });
    }
    async today(now = Date.now()) {
        const { day } = beijingTime(now);
        return locked(path.join(this.directory, day + '.mutex'), async () => {
            const data = await this.load(day);
            const accounts = Object.values(data.accounts).sort((a, b) => b.total_tokens - a.total_tokens);
            const totals = { ...empty(), hours: Array.from({ length: hourCount }, () => 0) };
            for (const account of accounts) {
                for (const field of fields) totals[field] += account[field];
                for (let hour = 0; hour < hourCount; hour++) totals.hours[hour] += account.hours[hour];
            }
            return { day, timezone: 'Asia/Shanghai', updated_at: data.updated_at || null, accounts, totals };
        });
    }
    async periods(now = Date.now()) {
        const { day } = beijingTime(now);
        const date = new Date(day + 'T00:00:00Z');
        const weekStart = new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * dayMilliseconds);
        const monthStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
        const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
        const dates = (start, end) => {
            const result = [];
            for (let time = start.getTime(); time <= end.getTime(); time += dayMilliseconds) result.push(new Date(time).toISOString().slice(0, 10));
            return result;
        };
        const ranges = { day: [day], week: dates(weekStart, new Date(weekStart.getTime() + 6 * dayMilliseconds)), month: dates(monthStart, monthEnd) };
        const snapshots = new Map();
        for (const current of [...new Set(Object.values(ranges).flat())].sort()) {
            if (current > day) continue;
            snapshots.set(current, await locked(path.join(this.directory, current + '.mutex'), () => this.load(current)));
        }
        const periods = {};
        for (const [period, days] of Object.entries(ranges)) {
            const buckets = period === 'day' ? Array.from({ length: hourCount }, (_, hour) => String(hour).padStart(2, '0')) : days;
            const accounts = new Map();
            let updatedAt = null;
            for (const current of days) {
                const data = snapshots.get(current);
                if (!data) continue;
                if (data.updated_at && (!updatedAt || data.updated_at > updatedAt)) updatedAt = data.updated_at;
                for (const source of Object.values(data.accounts)) {
                    if (!accounts.has(source.id)) accounts.set(source.id, { id: source.id, name: source.name, aliases: [], ...empty(), buckets: buckets.map(() => 0) });
                    const target = accounts.get(source.id);
                    target.name = source.name;
                    target.aliases = [...new Set([...target.aliases, ...(source.aliases || [source.name])])];
                    for (const field of fields) target[field] += source[field];
                    if (period === 'day') target.buckets = [...source.hours];
                    else target.buckets[days.indexOf(current)] += source.total_tokens;
                }
            }
            const totals = { ...empty(), buckets: buckets.map(() => 0) };
            for (const account of accounts.values()) {
                for (const field of fields) totals[field] += account[field];
                account.buckets.forEach((value, index) => { totals.buckets[index] += value; });
            }
            periods[period] = { period, day, start: days[0], end: days.at(-1), timezone: 'Asia/Shanghai', updated_at: updatedAt,
                buckets, accounts: [...accounts.values()].sort((a, b) => b.total_tokens - a.total_tokens), totals };
        }
        // Preserve the daily API shape for existing local clients.
        const today = periods.day;
        return { ...today, accounts: today.accounts.map(account => ({ ...account, hours: account.buckets })),
            totals: { ...today.totals, hours: today.totals.buckets }, periods };
    }
}
