import assert from 'node:assert/strict';
import test from 'node:test';
import { CoreAuthClient } from '../src/shared/core/core-auth.client.js';
import { TtlCache } from '../src/shared/core/ttl-cache.js';

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  applicationId: '22222222-2222-4222-8222-222222222222',
  role: 'user',
};
/** An unsigned token with an expiry: the cache only reads `exp` to bound how long it keeps an answer. */
const token = (expInSeconds: number) =>
  `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expInSeconds })).toString('base64url')}.s`;

function client(options: { identityCacheMs?: number; billingCacheMs?: number }, access = true) {
  const calls: string[] = [];
  const core = new CoreAuthClient({
    baseUrl: 'https://core.test',
    applicationKey: 'gotit',
    timeoutMs: 1000,
    ...options,
    fetchImpl: async (url) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return path.endsWith('/auth/me')
        ? Response.json({ user })
        : Response.json({
            tier: access ? 'paid' : 'free',
            access,
            plan: access
              ? { key: 'pro', name: 'Pro', kind: 'paid' }
              : { key: 'free', name: 'Free', kind: 'free' },
            entitlements: access ? ['tutor.session'] : [],
            subscription: null,
            trial: null,
          });
    },
  });
  return { core, calls };
}

test('identity checks for the same token share one Core call while cached', async () => {
  const { core, calls } = client({ identityCacheMs: 60_000 });
  const access = token(600);
  const [first, second] = await Promise.all([
    core.validateAccessToken(access),
    core.validateAccessToken(access),
  ]);
  await core.validateAccessToken(access);
  assert.equal(first.applicationUserId, user.id);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  await core.validateAccessToken(token(500));
  assert.equal(calls.length, 2);
});

test('without a cache setting every identity check asks Core', async () => {
  const { core, calls } = client({});
  const access = token(600);
  await core.validateAccessToken(access);
  await core.validateAccessToken(access);
  assert.equal(calls.length, 2);
});

test('an expired or unreadable token is never served from the cache', async () => {
  const { core, calls } = client({ identityCacheMs: 60_000 });
  await core.validateAccessToken(token(-5));
  await core.validateAccessToken(token(-5));
  await core.validateAccessToken('opaque-token');
  await core.validateAccessToken('opaque-token');
  assert.equal(calls.length, 4);
});

test('granted billing access is reused, a denial is checked again', async () => {
  const granted = client({ billingCacheMs: 20_000 });
  const access = token(600);
  await granted.core.getBillingStatus(access);
  await granted.core.getBillingStatus(access);
  assert.equal(granted.calls.length, 1);

  const denied = client({ billingCacheMs: 20_000 }, false);
  await denied.core.getBillingStatus(access);
  await denied.core.getBillingStatus(access);
  assert.equal(denied.calls.length, 2);
});

test('the cache expires entries, drops the oldest when full and never keeps failures', async () => {
  let now = 0;
  const cache = new TtlCache<number>(2, () => now);
  let loads = 0;
  const load = async () => ++loads;
  assert.equal(await cache.get('a', load, () => 100), 1);
  assert.equal(await cache.get('a', load, () => 100), 1);
  now = 150;
  assert.equal(await cache.get('a', load, () => 100), 2);
  await cache.get('b', load, () => 100);
  await cache.get('c', load, () => 100);
  assert.equal(await cache.get('a', load, () => 100), 5);
  await assert.rejects(
    cache.get(
      'd',
      async () => Promise.reject(new Error('down')),
      () => 100,
    ),
  );
  assert.equal(await cache.get('d', load, () => 100), 6);
});
