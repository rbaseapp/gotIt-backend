import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProductAdminService } from '../../src/modules/admin/admin.service.js';
import { listSchema, usageListSchema } from '../../src/modules/admin/admin.schemas.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { DEFAULT_LEARNING_POLICY } from '../../src/modules/learning/learning.policy.js';

test(
  'admin activity: cancellation times, failure filters, pagination and application isolation',
  { timeout: 180000 },
  async () => {
    const database = await createTestDatabase();
    let corePool: { end(): Promise<void> } | undefined;
    try {
      process.env.NODE_ENV = 'test';
      process.env.LOG_LEVEL = 'silent';
      process.env.JWT_SECRET = 'activity-test-secret-at-least-thirty-two-characters';
      process.env.DATABASE_URL = database.adminPool.options.connectionString!;
      const corePath = process.env.CORE_PLATFORM_PATH ?? resolve('../core-platform');
      const { AdminService } = await import(
        pathToFileURL(resolve(corePath, 'src/modules/admin/admin.service.ts')).href
      );
      const { listSchema: coreList } = await import(
        pathToFileURL(resolve(corePath, 'src/modules/admin/admin.schemas.ts')).href
      );
      corePool = (
        await import(pathToFileURL(resolve(corePath, 'src/shared/database/pool.ts')).href)
      ).pool;
      const appId = randomUUID(),
        otherApp = randomUUID(),
        adminId = randomUUID(),
        otherUser = randomUUID();
      await database.adminPool.query(
        `INSERT INTO core.applications(id,key,name) VALUES($1,'activity-test','Activity'),($2,'activity-other','Other')`,
        [appId, otherApp],
      );
      await database.adminPool.query(
        `INSERT INTO core.application_users(application_id,id,email,role,email_verified_at) VALUES($1,$2,'admin@example.test','admin',now()),($3,$4,'other@example.test','admin',now())`,
        [appId, adminId, otherApp, otherUser],
      );
      const context = {
        applicationId: appId,
        applicationKey: 'activity-test',
        applicationUserId: adminId,
        sessionId: randomUUID(),
      };
      const core = new AdminService(database.adminPool);
      const planId = randomUUID(),
        otherPlan = randomUUID();
      await database.adminPool.query(
        `INSERT INTO core.billing_plans(application_id,id,key,name,kind,entitlements,provider,provider_price_id,billing_interval) VALUES($1,$2,'activity','Activity','paid','[]','paddle',$5,'month'),($3,$4,'activity','Activity','paid','[]','paddle',$6,'month')`,
        [appId, planId, otherApp, otherPlan, `pri_${'a'.repeat(26)}`, `pri_${'b'.repeat(26)}`],
      );
      const canceled = randomUUID(),
        scheduled = randomUUID(),
        foreign = randomUUID(),
        revoked = randomUUID();
      for (const [id, app, user, plan, status, time, suffix, cancelAtEnd] of [
        [canceled, appId, adminId, planId, 'canceled', '2026-10-10T10:00:00Z', 'a', false],
        [scheduled, appId, adminId, planId, 'active', '2026-10-15T10:00:00Z', 'b', true],
        [foreign, otherApp, otherUser, otherPlan, 'canceled', '2026-10-16T10:00:00Z', 'c', false],
      ] as const) {
        await database.adminPool.query(
          `INSERT INTO core.billing_subscriptions(id,application_id,application_user_id,billing_plan_id,provider,provider_subscription_id,provider_customer_id,status,provider_occurred_at,cancel_at_period_end,created_at) VALUES($1,$2,$3,$4,'paddle',$5,$6,$7,$8,$9,'2026-01-01')`,
          [
            id,
            app,
            user,
            plan,
            `sub_${suffix.repeat(26)}`,
            `ctm_${suffix.repeat(26)}`,
            status,
            time,
            cancelAtEnd,
          ],
        );
      }
      await database.adminPool.query(
        `INSERT INTO core.admin_access_grants(id,application_id,application_user_id,billing_plan_id,starts_at,ends_at,revoked_at) VALUES($1,$2,$3,$4,'2026-01-01','2027-01-01','2026-10-12T10:00:00Z')`,
        [revoked, appId, adminId, planId],
      );
      const cancellationQuery = coreList.parse({
        activity: 'cancelled',
        sort: 'activityAt',
        order: 'DESC',
        perPage: 1,
      });
      const first = await core.list(context, 'subscriptions', cancellationQuery);
      assert.equal(first.total, 2);
      assert.equal(first.data[0].id, revoked);
      const second = await core.list(context, 'subscriptions', { ...cancellationQuery, page: 2 });
      assert.equal(second.data[0].id, canceled);
      assert.equal(new Date(second.data[0].activityAt).toISOString(), '2026-10-10T10:00:00.000Z');
      assert.equal((await core.list(context, 'subscriptions', coreList.parse({}))).total, 3);
      await assert.rejects(() => core.list(context, 'users', cancellationQuery), {
        code: 'VALIDATION_ERROR',
      });
      await assert.rejects(() => core.list(context, 'subscriptions', cancellationQuery, foreign), {
        code: 'VALIDATION_ERROR',
      });

      const profiles = new ProfileService(new ProfileRepository(database.runtimePool));
      await profiles.getProfile({ applicationId: appId, applicationUserId: adminId });
      await profiles.getProfile({ applicationId: otherApp, applicationUserId: otherUser });
      const actor = {
        applicationId: appId,
        applicationUserId: adminId,
        token: 'local-only',
        requestId: randomUUID(),
      };
      const service = new ProductAdminService(
        database.runtimePool,
        {
          getAdminAccess: async () => ({
            applicationId: appId,
            applicationUserId: adminId,
            permissions: [],
            resources: ['usage'],
            mfaEnrolled: false,
            mfaVerified: false,
          }),
          getAdminUser: async () => {
            throw new Error('Unexpected target lookup');
          },
        },
        profiles,
        DEFAULT_LEARNING_POLICY,
      );
      const failures = [randomUUID(), randomUUID()];
      for (const [id, app, user, status, time] of [
        [failures[0], appId, adminId, 'failed', '2026-10-10T10:00:00Z'],
        [failures[1], appId, adminId, 'failed', '2026-10-11T10:00:00Z'],
        [randomUUID(), appId, adminId, 'completed', '2026-10-15T10:00:00Z'],
        [randomUUID(), appId, adminId, 'unmeasured', '2026-10-15T11:00:00Z'],
        [randomUUID(), otherApp, otherUser, 'failed', '2026-10-16T10:00:00Z'],
      ]) {
        await database.runtimePool.query(
          `INSERT INTO product_gotit.ai_usage_events(id,application_id,application_user_id,operation,operation_id,provider,status,created_at) VALUES($1,$2,$3,'reading',$6,'fixture',$4,$5)`,
          [id, app, user, status, time, id],
        );
      }
      const failureQuery = usageListSchema.parse({
        activity: 'failed',
        sort: 'createdAt',
        order: 'DESC',
        perPage: 1,
      });
      const failed = await service.list(actor, 'usage', failureQuery);
      assert.equal(failed.total, 2);
      assert.equal(failed.data[0].id, failures[1]);
      assert.equal(
        (await service.list(actor, 'usage', { ...failureQuery, page: 2 })).data[0].id,
        failures[0],
      );
      assert.equal((await service.list(actor, 'usage', listSchema.parse({}))).total, 4);
      assert.equal(
        (await service.list(actor, 'usage', { ...failureQuery, q: 'not-present' })).total,
        0,
      );
      await assert.rejects(() => service.list(actor, 'programs', failureQuery), {
        code: 'VALIDATION_ERROR',
      });
      await assert.rejects(() => service.list(actor, 'usage', failureQuery, failures[0]), {
        code: 'VALIDATION_ERROR',
      });
    } finally {
      await corePool?.end();
      await database.dispose();
    }
  },
);
