import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PostgresMinuteWallet } from '../../src/modules/private-lessons/minute-wallet.js';
import type { CoreMinuteGrants } from '../../src/shared/core/core-auth.client.js';
import { createTestDatabase } from '../helpers/postgres.js';

test(
  'verified subscription and purchase minutes combine, reserve once, and resist concurrent overspend',
  { timeout: 150_000 },
  async () => {
    const db = await createTestDatabase();
    try {
      const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
      await db.adminPool.query('INSERT INTO core.applications(id,key,name) VALUES($1,$2,$3)', [
        scope.applicationId,
        'gotit',
        'GotIt',
      ]);
      await db.adminPool.query(
        'INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,$3)',
        [scope.applicationUserId, scope.applicationId, 'minutes@example.test'],
      );
      const startsAt = new Date(Date.now() - 60_000).toISOString();
      const endsAt = new Date(Date.now() + 86_400_000).toISOString();
      const purchase = {
        sourceKind: 'purchase' as const,
        sourceId: 'txn_' + 'a'.repeat(26),
        startsAt,
        endsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        secondsTotal: 3600,
      };
      const subscription = {
        sourceKind: 'subscription' as const,
        sourceId: 'sub_' + 'b'.repeat(26),
        startsAt,
        endsAt,
        secondsTotal: 195 * 60,
      };
      let grants: CoreMinuteGrants['grants'] = [];
      const wallet = new PostgresMinuteWallet(db.runtimePool, {
        async getMinuteGrants(token: string) {
          assert.equal(token, 'trusted-token');
          return { grants };
        },
      });
      assert.equal((await wallet.balance(scope, 'trusted-token')).secondsRemaining, 0);
      await assert.rejects(
        wallet.reserve(scope, randomUUID(), 1200, 'trusted-token'),
        (error: any) => error.code === 'PRIVATE_LESSON_MINUTES_REQUIRED',
      );

      grants = [purchase, subscription];
      assert.equal((await wallet.balance(scope, 'trusted-token')).secondsRemaining, 255 * 60);
      const lesson = randomUUID();
      await wallet.reserve(scope, lesson, 1200, 'trusted-token');
      await wallet.reserve(scope, lesson, 1200, 'trusted-token');
      assert.equal((await wallet.balance(scope, 'trusted-token')).secondsRemaining, 235 * 60);
      assert.equal((await wallet.balance(scope, 'trusted-token')).secondsRemaining, 235 * 60);

      const failedProvider = randomUUID();
      await wallet.reserve(scope, failedProvider, 600, 'trusted-token');
      await wallet.release(failedProvider);
      await wallet.release(failedProvider);
      assert.equal((await wallet.balance(scope, 'trusted-token')).secondsRemaining, 235 * 60);

      grants = [purchase];
      assert.equal((await wallet.balance(scope, 'trusted-token')).secondsRemaining, 60 * 60);
      const results = await Promise.allSettled(
        Array.from({ length: 3 }, () => wallet.reserve(scope, randomUUID(), 1500, 'trusted-token')),
      );
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
      assert.equal((await wallet.balance(scope, 'trusted-token')).secondsRemaining, 10 * 60);
      grants = [];
      assert.equal((await wallet.balance(scope, 'trusted-token')).secondsRemaining, 0);
    } finally {
      await db.dispose();
    }
  },
);
