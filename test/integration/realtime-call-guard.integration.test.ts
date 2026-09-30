import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PostgresRealtimeCallGuard } from '../../src/modules/private-lessons/realtime-call-guard.js';
import { createTestDatabase } from '../helpers/postgres.js';

test(
  'Realtime tickets permit one bounded call, end it on the server, and reject parallel or replayed use',
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
        [scope.applicationUserId, scope.applicationId, 'realtime@example.test'],
      );
      await db.adminPool.query(
        `INSERT INTO product_gotit.user_profiles
         (application_id,application_user_id,timezone,daily_goal_type,daily_goal_value,default_new_items_per_day)
         VALUES($1,$2,'UTC','items',20,10)`,
        [scope.applicationId, scope.applicationUserId],
      );
      const calls: string[] = [];
      const refunds: string[] = [];
      const guard = new PostgresRealtimeCallGuard(
        db.runtimePool,
        'server-key',
        {
          balance: async () => {
            throw new Error('unused');
          },
          reserve: async () => {},
          release: async (id) => {
            refunds.push(id);
          },
        },
        async (url, init) => {
          calls.push(String(url));
          if (String(url).endsWith('/hangup')) {
            assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer server-key');
            return new Response(null, { status: 200 });
          }
          assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer provider-secret');
          return new Response('v=0\r\no=provider\r\n', {
            status: 201,
            headers: { location: '/v1/realtime/calls/rtc_test' },
          });
        },
      );
      const lessonId = randomUUID();
      const ticket = await guard.reserve(scope, 'private_lesson', 60, lessonId);
      await assert.rejects(
        guard.reserve(scope, 'private_lesson', 60),
        (error: any) => error.code === 'AI_SESSION_ACTIVE',
      );
      await guard.issue(ticket, 'provider-secret');
      assert.equal(await guard.connect(ticket, 'v=0\r\no=browser\r\n'), 'v=0\r\no=provider\r\n');
      await assert.rejects(
        guard.connect(ticket, 'v=0\r\no=browser\r\n'),
        (error: any) => error.code === 'AI_SESSION_UNAVAILABLE',
      );
      assert.equal(calls.filter((url) => url.endsWith('/calls')).length, 1);
      await guard.end(ticket);
      assert.equal(calls.filter((url) => url.endsWith('/hangup')).length, 1);
      assert.deepEqual(refunds, []);

      const second = await guard.reserve(scope, 'course_interview', 600);
      await guard.issue(second, 'provider-secret');
      await guard.connect(second, 'v=0\r\no=browser\r\n');
      await db.adminPool.query(
        "UPDATE product_gotit.realtime_call_tickets SET ends_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [second],
      );
      await guard.sweep();
      assert.equal(calls.filter((url) => url.endsWith('/hangup')).length, 2);

      const third = await guard.reserve(scope, 'private_lesson', 60, randomUUID());
      await guard.issue(third, 'provider-secret');
      await guard.cancel(third);
      assert.equal(refunds.length, 1);
      assert.equal(
        await db.runtimePool
          .query(
            'SELECT count(*)::int AS n FROM product_gotit.realtime_call_tickets WHERE provider_secret IS NOT NULL',
          )
          .then((r) => r.rows[0].n),
        0,
      );

      for (let index = 0; index < 28; index++)
        await db.runtimePool.query(
          `INSERT INTO product_gotit.realtime_call_tickets
           (id,application_id,application_user_id,feature,status,duration_seconds,expires_at,provider_credential_issued)
           VALUES($1,$2,$3,'private_lesson','ended',60,clock_timestamp(),true)`,
          [randomUUID(), scope.applicationId, scope.applicationUserId],
        );
      await assert.rejects(
        guard.reserve(scope, 'private_lesson', 60),
        (error: any) => error.code === 'AI_DAILY_LIMIT_REACHED',
      );
    } finally {
      await db.dispose();
    }
  },
);
