import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function same(a, b) {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

export function createWebAuth(password) {
    const key = randomBytes(32), attempts = new Map();
    const lifetime = 8 * 60 * 60;
    const sign = value => createHmac('sha256', key).update(value).digest('hex');
    const cookie = (value, age) => `switcher_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}`;
    return {
        authenticated(req) {
            const basic = 'Basic ' + Buffer.from('admin:' + password).toString('base64');
            if (same(req.headers.authorization || '', basic)) return true;
            const token = /(?:^|;\s*)switcher_session=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';
            const [expires, nonce, signature] = token.split('.');
            return /^\d+$/.test(expires || '') && /^[a-f0-9]{32}$/.test(nonce || '') &&
                Number(expires) > Date.now() && same(signature || '', sign(`${expires}.${nonce}`));
        },
        login(address, username, supplied) {
            const now = Date.now();
            for (const [ip, entry] of attempts) if (entry.until <= now) attempts.delete(ip);
            const entry = attempts.get(address) || { count: 0, until: now + 60000 };
            if (entry.count >= 5 || (!attempts.has(address) && attempts.size >= 256)) return { status: 429 };
            if (!same(String(username || ''), 'admin') || !same(String(supplied || ''), password)) {
                entry.count++; attempts.set(address, entry); return { status: 401 };
            }
            attempts.delete(address);
            const value = `${now + lifetime * 1000}.${randomBytes(16).toString('hex')}`;
            return { status: 200, cookie: cookie(`${value}.${sign(value)}`, lifetime) };
        },
        logoutCookie: () => cookie('', 0),
    };
}
