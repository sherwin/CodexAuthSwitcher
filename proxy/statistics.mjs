import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { locked, readJSON, writeJSON } from './storage.mjs';
import { identity } from './credentials.mjs';

const hourCount = 24;
const dayMilliseconds = 86400000;
const minuteMilliseconds = 60000;
const hourMilliseconds = 3600000;
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
            // 旧数据只保留已知精度；分钟记录从本次升级后开始累积。
            item.minutes ||= {};
            const minute = Math.floor(now / minuteMilliseconds) * minuteMilliseconds;
            const measured = item.minutes[minute] ||= empty();
            measured.requests++;
            item.name = account.name;
            if (!item.aliases.includes(account.name)) item.aliases.push(account.name);
            item.requests++;
            const tokens = normalizedUsage(usage);
            if (tokens) {
                item.measured_requests++;
                measured.measured_requests++;
                for (const [field, value] of Object.entries(tokens)) { item[field] += value; measured[field] += value; }
                item.hours[hour] += tokens.total_tokens;
            } else { item.unknown_requests++; measured.unknown_requests++; }
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
    async range(input = {}, now = Date.now()) {
        const { day } = beijingTime(now);
        const midnight = Date.parse(day + 'T00:00:00+08:00');
        const presets = { hour: hourMilliseconds, 'ten-minutes': 10 * minuteMilliseconds,
            week: 7 * dayMilliseconds, month: 30 * dayMilliseconds, year: 365 * dayMilliseconds };
        const period = input.period || 'natural-day';
        // 筛选边界统一到分钟，当前分钟包含在实时范围内。
        const end = period === 'custom' ? Number(input.end) : Math.floor(now / minuteMilliseconds) * minuteMilliseconds + minuteMilliseconds;
        const start = period === 'custom' ? Number(input.start) : period === 'natural-day' ? midnight : end - presets[period];
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start % minuteMilliseconds || end % minuteMilliseconds ||
            start < 0 || start >= end || end - start > 366 * dayMilliseconds || end > now + minuteMilliseconds) {
            const error = new Error('Invalid statistics range.'); error.code = 'invalid_statistics_range'; error.status = 400; throw error;
        }
        const step = period === 'natural-day' ? hourMilliseconds : end - start <= hourMilliseconds ? minuteMilliseconds : end - start <= 2 * dayMilliseconds ? hourMilliseconds : dayMilliseconds;
        const origin = step === dayMilliseconds ? Date.parse(beijingTime(start).day + 'T00:00:00+08:00') : Math.floor(start / step) * step;
        const buckets = [];
        for (let time = origin; time < end; time += step) buckets.push(new Date(time).toISOString());
        const accounts = new Map();
        let updatedAt = null, incompleteHistory = false;
        const availableDays = new Set((await fs.readdir(this.directory).catch(error => {
            if (error.code === 'ENOENT') return [];
            throw error;
        })).filter(file => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).map(file => file.slice(0, 10)));
        const firstDay = Date.parse(beijingTime(start).day + 'T00:00:00+08:00');
        for (let time = firstDay; time < end; time += dayMilliseconds) {
            const current = beijingTime(time).day;
            if (current !== day && !availableDays.has(current)) continue;
            const snapshot = await locked(path.join(this.directory, current + '.mutex'), () => this.load(current));
            if (snapshot.updated_at && (!updatedAt || snapshot.updated_at > updatedAt)) updatedAt = snapshot.updated_at;
            const wholeDay = start <= time && end >= Math.min(time + dayMilliseconds, now);
            for (const source of Object.values(snapshot.accounts)) {
                const target = accounts.get(source.id) || { id: source.id, name: source.name, aliases: [], ...empty(), buckets: buckets.map(() => 0) };
                target.name = source.name;
                target.aliases = [...new Set([...target.aliases, ...(source.aliases || [source.name])])];
                if (wholeDay && step === dayMilliseconds) {
                    // 长区间直接合并完整日期，避免每次刷新重扫全年分钟明细。
                    for (const field of fields) target[field] += source[field] || 0;
                    target.buckets[Math.floor((time - origin) / step)] += source.total_tokens || 0;
                    if (target.requests) accounts.set(source.id, target);
                    continue;
                }
                const recorded = empty();
                const minuteHours = Array.from({ length: hourCount }, () => 0);
                for (const [key, values] of Object.entries(source.minutes || {})) {
                    const minute = Number(key);
                    for (const field of fields) recorded[field] += values[field] || 0;
                    minuteHours[beijingTime(minute).hour] += values.total_tokens || 0;
                    if (minute < start || minute >= end) continue;
                    for (const field of fields) target[field] += values[field] || 0;
                    target.buckets[Math.floor((minute - origin) / step)] += values.total_tokens || 0;
                }
                const legacyRequests = (source.requests || 0) - recorded.requests;
                if (legacyRequests > 0) {
                    if (wholeDay && step >= hourMilliseconds) {
                        // 自然日完整包含时，历史汇总可精确合并；局部范围不能推测旧请求时间。
                        for (const field of fields) target[field] += (source[field] || 0) - recorded[field];
                        for (let hour = 0; hour < hourCount; hour++) {
                            const stamp = time + hour * hourMilliseconds;
                            if (stamp >= end) break;
                            target.buckets[Math.floor((stamp - origin) / step)] += Math.max(0, (source.hours?.[hour] || 0) - minuteHours[hour]);
                        }
                    } else incompleteHistory = true;
                }
                if (target.requests) accounts.set(source.id, target);
            }
        }
        const totals = { ...empty(), buckets: buckets.map(() => 0) };
        for (const account of accounts.values()) {
            for (const field of fields) totals[field] += account[field];
            account.buckets.forEach((value, index) => { totals.buckets[index] += value; });
        }
        return { period, start: new Date(start).toISOString(), end: new Date(end).toISOString(), timezone: 'Asia/Shanghai',
            granularity: step === minuteMilliseconds ? 'minute' : step === hourMilliseconds ? 'hour' : 'day',
            incomplete_history: incompleteHistory, updated_at: updatedAt, buckets,
            accounts: [...accounts.values()].sort((a, b) => b.total_tokens - a.total_tokens), totals };
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
        const ranges = { day: [day], week: dates(weekStart, new Date(weekStart.getTime() + 6 * dayMilliseconds)), month: dates(monthStart, monthEnd), year: dates(new Date(date.getTime() - 364 * dayMilliseconds), date) };
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
        const allAccounts = new Map();
        for (const file of await fs.readdir(this.directory).catch(() => [])) {
            if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(file)) continue;
            const snapshot = await this.load(file.slice(0, 10));
            for (const source of Object.values(snapshot.accounts)) {
                const target = allAccounts.get(source.id) || { id: source.id, name: source.name, aliases: [], ...empty(), buckets: [] };
                target.name = source.name; target.aliases = [...new Set([...target.aliases, ...(source.aliases || [source.name])])];
                for (const field of fields) target[field] += source[field];
                allAccounts.set(source.id, target);
            }
        }
        const totalAccounts = [...allAccounts.values()].sort((a, b) => b.total_tokens - a.total_tokens);
        const total = { period: 'total', day, start: null, end: day, timezone: 'Asia/Shanghai', updated_at: null, buckets: [], accounts: totalAccounts, totals: { ...empty(), buckets: [] } };
        for (const account of totalAccounts) for (const field of fields) total.totals[field] += account[field];
        return { ...today, accounts: today.accounts.map(account => ({ ...account, hours: account.buckets })),
            totals: { ...today.totals, hours: today.totals.buckets }, periods: { ...periods, total } };
    }
}
