import test from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionDetails, querySubscription } from '../proxy/subscription.mjs';

test('subscription dates belong to the selected account, never another default workspace', () => {
    const data = { accounts: { a: { entitlement: { expires_at: '2026-10-17T14:44:40+00:00',
        renews_at: '2026-10-17T08:44:40+00:00', has_active_subscription: true } },
    default: { account: { account_id: 'b' }, entitlement: { expires_at: '2030-01-01T00:00:00Z' } } } };
    const result = subscriptionDetails(data, 'a');
    assert.equal(result.expiresAt, '2026-10-17T14:44:40.000Z');
    assert.equal(result.renewsAt, '2026-10-17T08:44:40.000Z');
    assert.equal(result.active, true);
    assert.equal(subscriptionDetails(data, 'missing').status, 'unavailable');
    assert.equal(subscriptionDetails(data, 'b').expiresAt, '2030-01-01T00:00:00.000Z');
});

test('renewal is not expiry; cancellation, grace, numeric timestamps and missing dates remain explicit', () => {
    const result = subscriptionDetails({ accounts: { a: { entitlement: {
        expires_at: 'invalid', renews_at: 1792248280, cancels_at: 1792248280000,
        grace_period_end_timestamp: '2026-10-20T00:00:00Z', has_active_subscription: false } } } }, 'a');
    assert.equal(result.expiresAt, null);
    assert.equal(result.renewsAt, result.cancelsAt);
    assert.equal(result.gracePeriodEndsAt, '2026-10-20T00:00:00.000Z');
    assert.equal(result.active, false);
    assert.equal(subscriptionDetails({ accounts: { a: { entitlement: { expires_at: {}, renews_at: null } } } }, 'a').expiresAt, null);
});

test('subscription lookup failure is sanitized and distinguishable from missing fields', async () => {
    const record = { tokens: { account_id: 'a', access_token: 'private-test-token' } };
    assert.deepEqual(await querySubscription(record, async () => Response.json({ secret: 'private-test-token' }, { status: 403 })),
        { status: 'failed', error: 'subscription_http_403' });
    assert.deepEqual(await querySubscription(record, async () => { throw Error('private-test-token'); }),
        { status: 'failed', error: 'subscription_query_failed' });
    assert.deepEqual(await querySubscription(record, async () => Response.json({ accounts: {} })), { status: 'unavailable' });
});
