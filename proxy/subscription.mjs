function subscriptionDate(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    if (!value || typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) return null;
    const timestamp = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
    const date = new Date(timestamp);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function subscriptionDetails(data, accountId) {
    const accounts = data?.accounts;
    // Never substitute a different workspace's membership for the requested account.
    const account = accountId ? accounts?.[accountId] ||
        (accounts?.default?.account?.account_id === accountId ? accounts.default : null) : accounts?.default;
    const entitlement = account?.entitlement;
    if (!entitlement || typeof entitlement !== 'object' || Array.isArray(entitlement)) return { status: 'unavailable' };
    return { status: 'available', expiresAt: subscriptionDate(entitlement.expires_at),
        renewsAt: subscriptionDate(entitlement.renews_at), cancelsAt: subscriptionDate(entitlement.cancels_at),
        gracePeriodEndsAt: subscriptionDate(entitlement.grace_period_end_timestamp),
        active: typeof entitlement.has_active_subscription === 'boolean' ? entitlement.has_active_subscription : null };
}

export async function querySubscription(record, fetchUpstream) {
    try {
        const response = await fetchUpstream('https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27', {
            headers: { Authorization: `Bearer ${record.tokens.access_token}`, 'ChatGPT-Account-Id': record.tokens.account_id,
                originator: 'codex_cli_rs', 'User-Agent': 'codex_cli_rs/0.159.2' },
            redirect: 'manual', signal: AbortSignal.timeout(10000) });
        if (!response.ok) return { status: 'failed', error: `subscription_http_${response.status}` };
        return subscriptionDetails(await response.json(), record.tokens.account_id);
    } catch {
        return { status: 'failed', error: 'subscription_query_failed' };
    }
}
