import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { z } from 'zod';
import { PracticeService } from '../../src/modules/practice/practice.service.js';
import { publicCourse } from '../../src/modules/courses/course.service.js';
import { exercisesSchema } from '../../src/modules/practice/practice.validation.js';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProductAdminService, type AdminActor } from '../../src/modules/admin/admin.service.js';
import { listSchema } from '../../src/modules/admin/admin.schemas.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import {
  DEFAULT_LEARNING_POLICY,
  policyVersion,
} from '../../src/modules/learning/learning.policy.js';
import {
  adminRuntimeContext,
  runtimeLearningPolicy,
} from '../../src/modules/admin/admin.context.js';
import { adminAiFetch } from '../../src/modules/admin/admin.ai-fetch.js';
import { AiMonthlyQuota } from '../../src/modules/reading/ai-monthly-quota.js';
import { preferences, plan } from '../helpers/course-fixtures.js';
import { createLogger } from '../../src/shared/logger/logger.js';

const command = () => ({
  operationId: randomUUID(),
  reason: 'Administrator integration verification',
});
test(
  'administration: PostgreSQL transactions, application boundaries, revisions, assignments and measured usage',
  { timeout: 180000 },
  async (t) => {
    const database = await createTestDatabase();
    let corePool: { end(): Promise<void> } | undefined;
    try {
      process.env.NODE_ENV = 'test';
      process.env.LOG_LEVEL = 'silent';
      process.env.JWT_SECRET = 'admin-test-secret-at-least-thirty-two-characters';
      process.env.DATABASE_URL = database.adminPool.options.connectionString!;
      const corePath = process.env.CORE_PLATFORM_PATH ?? resolve('../core-platform');
      const { AdminService } = await import(
        pathToFileURL(resolve(corePath, 'src/modules/admin/admin.service.ts')).href
      );
      corePool = (
        await import(pathToFileURL(resolve(corePath, 'src/shared/database/pool.ts')).href)
      ).pool;
      const appId = randomUUID(),
        otherApp = randomUUID(),
        adminId = randomUUID(),
        userId = randomUUID(),
        otherUser = randomUUID();
      await database.adminPool.query(
        `INSERT INTO core.applications(id,key,name) VALUES($1,'admin-test','Admin test'),($2,'other-admin-test','Other app')`,
        [appId, otherApp],
      );
      await database.adminPool.query(
        `INSERT INTO core.application_users(application_id,id,email,role,email_verified_at) VALUES($1,$2,'admin@example.test','admin',now()),($1,$3,'learner@example.test','user',now()),($4,$5,'other@example.test','user',now())`,
        [appId, adminId, userId, otherApp, otherUser],
      );
      const context = {
        applicationId: appId,
        applicationKey: 'admin-test',
        applicationUserId: adminId,
        sessionId: randomUUID(),
        adminStepUp: undefined as string | undefined,
      };
      const core = new AdminService(database.adminPool);
      const query = listSchema.parse({});
      await t.test(
        'regular users cannot enter administration; staff writes require explicit permissions',
        async () => {
          await assert.rejects(() => core.access({ ...context, applicationUserId: userId }), {
            code: 'ADMIN_REQUIRED',
          });
          const response = await core.list(context, 'users', query);
          assert.equal(response.total, 2);
          assert.ok(response.data.every((row: { id: string }) => row.id !== otherUser));
          await assert.rejects(
            () =>
              core.updateUser(context, userId, {
                ...command(),
                expectedRevision: 0,
                changes: { displayName: 'Denied' },
              }),
            { code: 'PERMISSION_REQUIRED' },
          );
          await database.adminPool.query(
            `INSERT INTO core.admin_staff_permissions(application_id,application_user_id,permission) SELECT $1,$2,unnest($3::text[])`,
            [
              appId,
              adminId,
              ['users.write', 'billing.write', 'content.write', 'learning.write', 'support.write'],
            ],
          );
          await assert.rejects(() => core.list(context, 'users', query, otherUser), {
            code: 'NOT_FOUND',
          });
          await assert.rejects(() => core.access({ ...context, applicationId: otherApp }), {
            code: 'ADMIN_REQUIRED',
          });
        },
      );
      await t.test(
        'staff writes require MFA; setup is encrypted and codes cannot be replayed across sessions',
        async () => {
          await assert.rejects(
            () =>
              core.updateUser(context, userId, {
                ...command(),
                expectedRevision: 0,
                changes: { displayName: 'Denied before MFA' },
              }),
            { code: 'ADMIN_MFA_REQUIRED' },
          );
          const { totpCode } = await import(
            pathToFileURL(resolve('../core-platform/src/modules/admin/admin.mfa.ts')).href
          );
          const enrollment = await core.mfa.enroll(context);
          const stored = (
            await database.adminPool.query(
              `SELECT * FROM core.admin_mfa_credentials WHERE application_id=$1 AND application_user_id=$2`,
              [appId, adminId],
            )
          ).rows[0];
          assert.doesNotMatch(JSON.stringify(stored), new RegExp(enrollment.secret));
          const code = totpCode(enrollment.secret, Math.floor(Date.now() / 30000));
          await assert.rejects(
            () => core.mfa.verify(context, code === '000000' ? '000001' : '000000'),
            { code: 'ADMIN_MFA_CODE_INVALID' },
          );
          assert.equal(
            (
              await database.adminPool.query(
                `SELECT failed_attempts FROM core.admin_mfa_credentials WHERE application_id=$1 AND application_user_id=$2`,
                [appId, adminId],
              )
            ).rows[0].failed_attempts,
            1,
          );
          const confirmed = await core.mfa.verify(context, code);
          context.adminStepUp = confirmed.stepUpToken;
          assert.equal((await core.access(context)).mfaVerified, true);
          assert.equal(
            (await core.access({ ...context, sessionId: randomUUID() })).mfaVerified,
            false,
          );
          assert.equal(
            (await core.access({ ...context, adminStepUp: context.adminStepUp + 'invalid' }))
              .mfaVerified,
            false,
          );
          await assert.rejects(() => core.mfa.verify(context, code), {
            code: 'ADMIN_MFA_CODE_INVALID',
          });
          await assert.rejects(() => core.mfa.enroll(context), {
            code: 'ADMIN_MFA_ALREADY_ENROLLED',
          });
        },
      );
      await t.test(
        'identity changes are atomic, replay once, reject conflicts and revoke target sessions',
        async () => {
          await database.adminPool.query(
            `INSERT INTO core.auth_sessions(application_id,application_user_id,refresh_token_hash,expires_at) VALUES($1,$2,'fixture-refresh-hash',now()+interval '1 day')`,
            [appId, userId],
          );
          await database.adminPool.query(
            `INSERT INTO core.password_credentials(application_id,application_user_id,password_hash) VALUES($1,$2,'fixture-password-hash')`,
            [appId, userId],
          );
          await database.adminPool.query(
            `INSERT INTO core.oauth_identities(application_id,application_user_id,provider,provider_subject) VALUES($1,$2,'google','fixture-google-subject')`,
            [appId, userId],
          );
          const input = {
            ...command(),
            expectedRevision: 0,
            changes: { email: 'new@example.test', displayName: 'Learner name' },
          };
          const results = await Promise.all([
            core.updateUser(context, userId, input),
            core.updateUser(context, userId, input),
          ]);
          assert.deepEqual(results[0], results[1]);
          assert.equal(results[0].data.revision, 1);
          assert.equal(results[0].data.emailVerified, false);
          assert.equal(
            (
              await database.adminPool.query(
                `SELECT count(*)::int AS n FROM core.admin_audit_events WHERE target_id=$1`,
                [userId],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await database.adminPool.query(
                `SELECT count(*)::int AS n FROM core.auth_sessions WHERE application_user_id=$1 AND revoked_at IS NULL`,
                [userId],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await database.adminPool.query(
                `SELECT count(*)::int AS n FROM core.password_credentials WHERE application_user_id=$1`,
                [userId],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await database.adminPool.query(
                `SELECT count(*)::int AS n FROM core.oauth_identities WHERE application_user_id=$1`,
                [userId],
              )
            ).rows[0].n,
            0,
          );
          await assert.rejects(
            () => core.updateUser(context, userId, { ...input, changes: { status: 'disabled' } }),
            { code: 'CONFLICT' },
          );
          await assert.rejects(
            () =>
              core.updateUser(context, adminId, {
                ...command(),
                expectedRevision: 0,
                changes: { status: 'disabled' },
              }),
            { code: 'SELF_CHANGE_FORBIDDEN' },
          );
          const concurrent = await Promise.allSettled(
            ['First', 'Second'].map((displayName) =>
              core.updateUser(context, userId, {
                ...command(),
                expectedRevision: 1,
                changes: { displayName },
              }),
            ),
          );
          assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
        },
      );
      await t.test(
        'manual access grants stay separate from provider subscription state and are replayable',
        async () => {
          const planId = randomUUID();
          await database.adminPool.query(
            `INSERT INTO core.billing_plans(application_id,id,key,name,kind,provider,provider_price_id,billing_interval,entitlements) VALUES($1,$2,'manual-test','Manual test','paid','paddle',$3,'month','["practice.play"]')`,
            [appId, planId, `pri_${'b'.repeat(26)}`],
          );
          const input = {
            ...command(),
            applicationUserId: userId,
            planId,
            endsAt: new Date(Date.now() + 86400000).toISOString(),
          };
          const grant = await core.grant(context, input);
          assert.deepEqual(await core.grant(context, input), grant);
          assert.equal(
            (await core.list(context, 'subscriptions', query)).data[0].source,
            'manual_grant',
          );
          await assert.rejects(
            () =>
              core.grant(context, {
                ...command(),
                applicationUserId: otherUser,
                planId,
                endsAt: input.endsAt,
              }),
            { code: 'NOT_FOUND' },
          );
          await core.revoke(context, grant.data.id, { ...command(), expectedRevision: 0 });
          assert.equal(
            (await core.list(context, 'subscriptions', query)).data[0].status,
            'revoked',
          );
          assert.equal(
            (
              await database.adminPool.query(
                `SELECT count(*)::int AS n FROM core.billing_subscriptions WHERE application_id=$1`,
                [appId],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      const profiles = new ProfileService(new ProfileRepository(database.runtimePool));
      await t.test(
        'staff management needs its own permission, verified targets and MFA; role changes revoke sessions and replay once',
        async () => {
          const targetId = randomUUID();
          await database.adminPool.query(
            `INSERT INTO core.application_users(application_id,id,email,role,email_verified_at) VALUES($1,$2,'staff-target@example.test','user',now())`,
            [appId, targetId],
          );
          const input = {
            ...command(),
            expectedRevision: 0,
            role: 'admin' as const,
            permissions: ['content.write'],
          };
          await assert.rejects(() => core.updateStaff(context, targetId, input), {
            code: 'PERMISSION_REQUIRED',
          });
          await database.adminPool.query(
            `INSERT INTO core.admin_staff_permissions(application_id,application_user_id,permission) VALUES($1,$2,'staff.write')`,
            [appId, adminId],
          );
          await assert.rejects(
            () => core.updateStaff({ ...context, adminStepUp: undefined }, targetId, input),
            { code: 'ADMIN_MFA_REQUIRED' },
          );
          await assert.rejects(() => core.updateStaff(context, otherUser, input), {
            code: 'CONFLICT',
          });
          await assert.rejects(() => core.updateStaff(context, adminId, input), {
            code: 'SELF_CHANGE_FORBIDDEN',
          });
          await assert.rejects(
            () => core.updateStaff(context, userId, { ...input, expectedRevision: 2 }),
            { code: 'VERIFIED_USER_REQUIRED' },
          );
          await database.adminPool.query(
            `INSERT INTO core.auth_sessions(application_id,application_user_id,refresh_token_hash,expires_at) VALUES($1,$2,'staff-session',now()+interval '1 day')`,
            [appId, targetId],
          );
          const results = await Promise.all([
            core.updateStaff(context, targetId, input),
            core.updateStaff(context, targetId, input),
          ]);
          assert.deepEqual(results[0], results[1]);
          assert.equal(results[0].data.role, 'admin');
          assert.deepEqual(
            (await core.access({ ...context, applicationUserId: targetId })).permissions,
            ['content.write'],
          );
          assert.equal(
            (
              await database.adminPool.query(
                `SELECT count(*)::int n FROM core.auth_sessions WHERE application_user_id=$1 AND revoked_at IS NULL`,
                [targetId],
              )
            ).rows[0].n,
            0,
          );
          assert.equal((await core.list(context, 'users', query, targetId)).data.planKey, 'admin');
          await core.updateStaff(context, targetId, {
            ...command(),
            expectedRevision: 1,
            role: 'user',
            permissions: [],
          });
          await assert.rejects(() => core.access({ ...context, applicationUserId: targetId }), {
            code: 'ADMIN_REQUIRED',
          });
          assert.equal(
            (
              await database.adminPool.query(
                `SELECT count(*)::int n FROM core.admin_staff_permissions WHERE application_user_id=$1`,
                [targetId],
              )
            ).rows[0].n,
            0,
          );
          const audit = (
            await database.adminPool.query(
              `SELECT metadata FROM core.admin_audit_events WHERE target_id=$1 AND action='staff.update' ORDER BY created_at`,
              [targetId],
            )
          ).rows;
          assert.equal(audit.length, 2);
          assert.equal(audit[0].metadata.role, 'admin');
        },
      );
      await t.test(
        'Free/Pro access overrides drive the actual billing status, preserve provider charges, expire and restore normal access',
        async () => {
          const targetId = randomUUID(),
            freeId = randomUUID(),
            paidId = randomUUID();
          await database.adminPool.query(
            `INSERT INTO core.application_users(application_id,id,email,email_verified_at) VALUES($1,$2,'plan-target@example.test',now())`,
            [appId, targetId],
          );
          await database.adminPool.query(
            `INSERT INTO core.billing_plans(application_id,id,key,name,kind,entitlements) VALUES($1,$2,'free','Free / Basic','free','["practice.basic"]')`,
            [appId, freeId],
          );
          await database.adminPool.query(
            `INSERT INTO core.billing_plans(application_id,id,key,name,kind,provider,provider_price_id,billing_interval,entitlements) VALUES($1,$2,'pro-switch-test','Pro','paid','paddle',$3,'month','["practice.basic","reading.ai"]')`,
            [appId, paidId, `pri_${'e'.repeat(26)}`],
          );
          const { BillingService } = await import(
            pathToFileURL(resolve(corePath, 'src/modules/billing/billing.service.ts')).href
          );
          const billing = new BillingService();
          const learnerContext = { ...context, applicationUserId: targetId };
          await database.adminPool.query(
            `INSERT INTO core.billing_subscriptions(application_id,application_user_id,billing_plan_id,provider,provider_subscription_id,provider_customer_id,status,provider_occurred_at) VALUES($1,$2,$3,'paddle',$4,$5,'active',now())`,
            [appId, targetId, paidId, `sub_${'c'.repeat(26)}`, `ctm_${'d'.repeat(26)}`],
          );
          assert.equal(
            (await billing.getStatus(learnerContext, database.adminPool)).source,
            'provider',
          );
          const input = {
            ...command(),
            expectedRevision: 0,
            planId: freeId,
            endsAt: new Date(Date.now() + 86400000).toISOString(),
          };
          const result = await core.setPlan(context, targetId, input);
          assert.deepEqual(await core.setPlan(context, targetId, input), result);
          let status = await billing.getStatus(learnerContext, database.adminPool);
          assert.equal(status.tier, 'free');
          assert.equal(status.source, 'admin_override');
          assert.deepEqual(status.entitlements, ['practice.basic']);
          assert.equal(status.subscription?.status, 'active');
          assert.equal((await core.list(context, 'users', query, targetId)).data.planKey, 'free');
          await assert.rejects(() => core.setPlan(context, targetId, { ...input, ...command() }), {
            code: 'CONFLICT',
          });
          await core.setPlan(context, targetId, {
            ...input,
            ...command(),
            expectedRevision: 1,
            planId: paidId,
          });
          assert.equal((await billing.getStatus(learnerContext, database.adminPool)).tier, 'paid');
          await database.adminPool.query(
            `UPDATE core.admin_plan_overrides SET created_at=now()-interval '2 days',ends_at=now()-interval '1 second' WHERE application_id=$1 AND application_user_id=$2`,
            [appId, targetId],
          );
          assert.equal(
            (await billing.getStatus(learnerContext, database.adminPool)).source,
            'provider',
          );
          await core.setPlan(context, targetId, {
            ...input,
            ...command(),
            expectedRevision: 2,
            planId: freeId,
          });
          await core.setPlan(context, targetId, {
            ...command(),
            expectedRevision: 3,
            planId: null,
            endsAt: null,
          });
          status = await billing.getStatus(learnerContext, database.adminPool);
          assert.equal(status.source, 'provider');
          assert.equal(
            (
              await database.adminPool.query(
                `SELECT status FROM core.billing_subscriptions WHERE application_id=$1 AND application_user_id=$2`,
                [appId, targetId],
              )
            ).rows[0].status,
            'active',
          );
          await assert.rejects(
            () =>
              core.setPlan(context, targetId, {
                ...input,
                ...command(),
                expectedRevision: 4,
                endsAt: new Date(Date.now() + 91 * 86400000).toISOString(),
              }),
            { code: 'VALIDATION_ERROR' },
          );
          await assert.rejects(
            () => core.setPlan(context, adminId, { ...input, ...command(), expectedRevision: 0 }),
            { code: 'ADMIN_ACCESS_FIXED' },
          );
          await core.setPlan(context, targetId, {
            ...command(),
            expectedRevision: 4,
            planId: paidId,
            endsAt: null,
          });
          status = await billing.getStatus(learnerContext, database.adminPool);
          assert.equal(status.source, 'admin_override');
          assert.equal(status.overrideEndsAt, null);
          assert.equal(status.tier, 'paid');
          await core.setPlan(context, targetId, {
            ...command(),
            expectedRevision: 5,
            planId: null,
            endsAt: null,
          });
        },
      );
      const actor: AdminActor = {
        applicationId: appId,
        applicationUserId: adminId,
        token: 'admin-token',
        requestId: randomUUID(),
        stepUp: context.adminStepUp!,
      };
      const coreAdapter = {
        getAdminAccess: async (token: string, _requestId?: string, stepUp?: string) => {
          if (token !== 'admin-token') throw new Error('Denied token');
          return core.access({ ...context, adminStepUp: stepUp });
        },
        getAdminUser: async (token: string, id: string) => {
          if (token !== 'admin-token') throw new Error('Denied token');
          return (await core.list(context, 'users', query, id)).data;
        },
      };
      let generations = 0;
      const generator = {
        async generate<T>(_scope: unknown, schema: z.ZodType<T>) {
          generations++;
          return schema.parse(plan);
        },
        async transcribe() {
          return 'unused';
        },
      };
      const service = new ProductAdminService(
        database.runtimePool,
        coreAdapter,
        profiles,
        DEFAULT_LEARNING_POLICY,
        generator,
      );
      await profiles.getProfile(actor);
      await t.test(
        'prepared catalog exposes the real English-from-zero units without learner progress',
        async () => {
          const response = await service.list(actor, 'catalog-programs', query);
          const program = response.data.find((row: { slug: string }) =>
            ['daily-english', 'english-learning-path-en-he'].includes(row.slug),
          );
          assert.ok(program);
          const detail = await service.list(actor, 'catalog-programs', query, program.id);
          assert.match(detail.data.title, /English from zero/);
          assert.ok(detail.data.units.length > 0);
          assert.equal(detail.data.units.length, detail.data.unitCount);
          assert.equal(
            detail.data.units.reduce((n: number, u: { wordCount: number }) => n + u.wordCount, 0),
            detail.data.wordCount,
          );
          assert.ok(
            detail.data.units.every(
              (u: Record<string, unknown>) => !('applicationUserId' in u) && !('progress' in u),
            ),
          );
        },
      );
      await t.test('owner authorization compares trusted application and actor scope', async () => {
        await assert.rejects(
          () => service.list({ ...actor, applicationId: otherApp }, 'prompts', query),
          { code: 'APPLICATION_MISMATCH' },
        );
        await assert.rejects(
          () => service.list({ ...actor, applicationUserId: userId }, 'prompts', query),
          { code: 'APPLICATION_MISMATCH' },
        );
        assert.equal((await service.list(actor, 'prompts', query)).total, 8);
      });
      await t.test(
        'prompt publication is explicit and immutable; rollback preserves historical bodies',
        async () => {
          const items = await service.list(actor, 'prompts', query);
          const first = items.data.find((row: { key: string }) => row.key === 'reading');
          assert.ok(first);
          const initial = await service.list(actor, 'prompts', query, first.id);
          assert.equal(initial.data.content.instructions, '');
          assert.equal(initial.data.activeGuidance, '');
          assert.match(
            initial.data.promptReference.templates[0].text,
            /Write a natural reading passage/,
          );
          const draft = await service.save(actor, 'prompts', first.id, {
            ...command(),
            expectedRevision: 0,
            document: {
              key: 'reading',
              title: 'Reading guidance',
              content: { instructions: 'Use concrete beginner examples.' },
            },
          });
          assert.equal((await service.runtime(actor, actor.requestId)).prompts.reading, undefined);
          const published = await service.publish(actor, 'prompts', first.id, {
            ...command(),
            expectedRevision: draft.data.revision,
            expectedActiveId: null,
          });
          assert.equal(
            (await service.runtime(actor, actor.requestId)).prompts.reading!.instructions,
            'Use concrete beginner examples.',
          );
          const next = await service.save(actor, 'prompts', first.id, {
            ...command(),
            expectedRevision: published.data.revision,
            document: {
              key: 'reading',
              title: 'New draft',
              content: { instructions: 'Use travel examples.' },
            },
          });
          assert.notEqual(next.data.id, first.id);
          const preview = await service.list(actor, 'prompts', query, String(next.data.id));
          assert.equal(preview.data.content.instructions, 'Use travel examples.');
          assert.equal(preview.data.activeGuidance, 'Use concrete beginner examples.');
          assert.equal(next.data.version, 2);
          assert.equal(
            (await service.runtime(actor, actor.requestId)).prompts.reading!.id,
            first.id,
          );
          const activated = await service.publish(actor, 'prompts', String(next.data.id), {
            ...command(),
            expectedRevision: Number(next.data.revision),
            expectedActiveId: first.id,
          });
          const prior = await service.list(actor, 'prompts', query, first.id);
          await service.publish(actor, 'prompts', first.id, {
            ...command(),
            expectedRevision: prior.data.revision,
            expectedActiveId: String(activated.data.id),
          });
          assert.equal(
            (await service.runtime(actor, actor.requestId)).prompts.reading!.instructions,
            'Use concrete beginner examples.',
          );
          await assert.rejects(
            () =>
              service.publish(actor, 'prompts', first.id, {
                ...command(),
                expectedRevision: 0,
                expectedActiveId: null,
              }),
            { code: 'CONFLICT' },
          );
        },
      );
      await t.test(
        'Realtime prompt drafts preserve modular settings across activation, rollback and scoped preview',
        async () => {
          const items = await service.list(actor, 'prompts', query);
          const first = items.data.find((row: { key: string }) => row.key === 'lesson-live');
          assert.ok(first);
          const content = {
            instructions: 'ADMIN TUTOR {{targetLanguage}}',
            mode: 'replace',
            modules: [{ key: 'method', title: 'Method', enabled: true, text: 'ONE QUESTION' }],
            realtime: {
              session: { model: 'fixture-realtime', audio: { output: { speed: 0.8 } } },
              stages: { opening: 'OPEN {{topic}}' },
            },
          };
          const saved = await service.save(actor, 'prompts', first.id, {
            ...command(),
            expectedRevision: first.revision,
            document: { key: 'lesson-live', title: 'Live tutor configuration', content },
          });
          assert.equal(
            (await service.runtime(actor, actor.requestId)).prompts['lesson-live'],
            undefined,
          );
          const input = { content, sample: { targetLanguageCode: 'en', topic: 'Travel' } };
          const preview = await service.previewPrompt({ ...actor, stepUp: undefined }, input);
          assert.equal(preview.providerRequest.body.session.model, 'fixture-realtime');
          assert.match(preview.clientEvents.opening.response.instructions, /OPEN Travel/);
          await assert.rejects(
            () => service.previewPrompt({ ...actor, applicationId: otherApp }, input),
            { code: 'APPLICATION_MISMATCH' },
          );
          const published = await service.publish(actor, 'prompts', String(saved.data.id), {
            ...command(),
            expectedRevision: Number(saved.data.revision),
            expectedActiveId: null,
          });
          const active = await service.runtime(actor, actor.requestId);
          assert.deepEqual(active.prompts['lesson-live']!.realtime, content.realtime);
          const detail = await service.list(actor, 'prompts', query, String(published.data.id));
          assert.deepEqual(detail.data.activeContent, content);
          const changed = await service.save(actor, 'prompts', String(published.data.id), {
            ...command(),
            expectedRevision: Number(published.data.revision),
            document: {
              key: 'lesson-live',
              title: 'Another draft',
              content: { instructions: 'ANOTHER VERSION' },
            },
          });
          assert.notEqual(changed.data.id, published.data.id);
          const second = await service.publish(actor, 'prompts', String(changed.data.id), {
            ...command(),
            expectedRevision: Number(changed.data.revision),
            expectedActiveId: String(published.data.id),
          });
          const prior = await service.list(actor, 'prompts', query, String(published.data.id));
          await service.publish(actor, 'prompts', String(published.data.id), {
            ...command(),
            expectedRevision: prior.data.revision,
            expectedActiveId: String(second.data.id),
          });
          assert.deepEqual(
            (await service.runtime(actor, actor.requestId)).prompts['lesson-live']!.realtime,
            content.realtime,
          );
          // A request already holding its snapshot retains that revision.
          assert.equal(active.prompts['lesson-live']!.instructions, content.instructions);
        },
      );
      await t.test(
        'concurrent prompt publishers choose one revision without a row-lock deadlock',
        { timeout: 5000 },
        async () => {
          const drafts = await Promise.all(
            [1, 2].map((index) =>
              service.save(actor, 'prompts', null, {
                ...command(),
                expectedRevision: null,
                document: {
                  key: 'image-brief',
                  title: `Concurrent draft ${index}`,
                  content: { instructions: `Brief guidance ${index}` },
                },
              }),
            ),
          );
          const outcomes = await Promise.allSettled(
            drafts.map((draft) =>
              service.publish(actor, 'prompts', String(draft.data.id), {
                ...command(),
                expectedRevision: Number(draft.data.revision),
                expectedActiveId: null,
              }),
            ),
          );
          assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
          const rejected = outcomes.find((result) => result.status === 'rejected');
          assert.equal(rejected?.status === 'rejected' && rejected.reason.code, 'CONFLICT');
          const active = (await service.runtime(actor, actor.requestId)).prompts['image-brief'];
          assert.ok(active && drafts.some((draft) => draft.data.id === active.id));
        },
      );
      let programId: string,
        assignmentId = '',
        courseId = '';
      await t.test(
        'programs create real learner course documents, replay assignment once and preserve snapshots',
        async () => {
          const created = await service.save(actor, 'programs', null, {
            ...command(),
            expectedRevision: null,
            document: { key: 'first-program', title: plan.title, content: { preferences, plan } },
          });
          programId = String(created.data.id);
          const published = await service.publish(actor, 'programs', programId, {
            ...command(),
            expectedRevision: 0,
            expectedActiveId: null,
          });
          const input = {
            ...command(),
            applicationUserId: userId,
            expectedRevision: Number(published.data.revision),
          };
          const assignments = await Promise.all([
            service.assign(actor, programId, input),
            service.assign(actor, programId, input),
          ]);
          assert.deepEqual(assignments[0], assignments[1]);
          assignmentId = String(assignments[0]!.data.id);
          courseId = String(assignments[0]!.data.courseId);
          const courses = await database.runtimePool.query(
            `SELECT document FROM product_gotit.learning_documents WHERE application_id=$1 AND application_user_id=$2`,
            [appId, userId],
          );
          assert.equal(courses.rowCount, 1);
          assert.equal(courses.rows[0].document.activeVersion, 1);
          assert.deepEqual(courses.rows[0].document.versions[0].plan, plan);
          await assert.rejects(
            () =>
              service.assign(actor, programId, {
                ...command(),
                applicationUserId: otherUser,
                expectedRevision: 1,
              }),
            { code: 'NOT_FOUND' },
          );
        },
      );
      await t.test(
        'learner-program editing scopes equal course IDs to their owners and preserves completed units',
        async () => {
          const original = (
            await database.runtimePool.query(
              `SELECT document FROM product_gotit.learning_documents WHERE application_id=$1 AND application_user_id=$2 AND id=$3`,
              [appId, userId, courseId],
            )
          ).rows[0]!.document;
          await database.runtimePool.query(
            `INSERT INTO product_gotit.learning_documents(application_id,application_user_id,id,kind,revision,document) VALUES($1,$2,$3,'course',0,$4::jsonb)`,
            [appId, adminId, courseId, JSON.stringify(original)],
          );
          const evidence = {
            lessonId: randomUUID(),
            version: 1,
            unitKey: 'foundation',
            lessonIndex: 0,
            covered: true,
            independent: true,
            recordedAt: new Date().toISOString(),
          };
          original.evidence = [evidence];
          await database.runtimePool.query(
            `UPDATE product_gotit.learning_documents SET document=$4::jsonb WHERE application_id=$1 AND application_user_id=$2 AND id=$3`,
            [appId, userId, courseId, JSON.stringify(original)],
          );
          const listed = await service.list(actor, 'assignments', query);
          assert.equal(listed.total, 2);
          assert.notEqual(listed.data[0]!.id, listed.data[1]!.id);
          const detail = await service.list(actor, 'assignments', query, assignmentId);
          assert.equal(detail.data.completedLessons, 1);
          const invalid = structuredClone(plan);
          invalid.units[0]!.outcome = 'Rewrite already learned material';
          await assert.rejects(
            () =>
              service.updateAssignment(actor, assignmentId, {
                ...command(),
                expectedRevision: 0,
                document: {
                  key: courseId,
                  title: plan.title,
                  content: { preferences, plan: invalid },
                },
              }),
            { code: 'PLAN_INVALID' },
          );
          const updated = structuredClone(plan);
          updated.units[2]!.title = 'Updated future unit';
          const input = {
            ...command(),
            expectedRevision: 0,
            document: { key: courseId, title: plan.title, content: { preferences, plan: updated } },
          };
          const saved = await service.updateAssignment(actor, assignmentId, input);
          assert.equal(saved.data.draftVersion, 2);
          assert.equal(saved.data.activeVersion, 1);
          await assert.rejects(
            () => service.updateAssignment(actor, `${adminId}_${courseId}`, input),
            { code: 'CONFLICT' },
          );
          await service.activateAssignment(actor, assignmentId, {
            ...command(),
            expectedRevision: 1,
          });
          const rows = await database.runtimePool.query(
            `SELECT application_user_id,document FROM product_gotit.learning_documents WHERE application_id=$1 AND id=$2 ORDER BY application_user_id`,
            [appId, courseId],
          );
          const learner = rows.rows.find((row) => row.application_user_id === userId)!.document,
            other = rows.rows.find((row) => row.application_user_id === adminId)!.document;
          assert.equal(learner.activeVersion, 2);
          assert.deepEqual(learner.evidence, [evidence]);
          assert.equal(other.activeVersion, 1);
          assert.doesNotMatch(JSON.stringify(publicCourse(learner)), /adminAssignment/);
        },
      );
      await t.test(
        'course generation replays its provider result without a second paid generation',
        async () => {
          const draft = await service.save(actor, 'programs', null, {
            ...command(),
            expectedRevision: null,
            document: {
              key: 'generate-program',
              title: 'Generated course',
              content: { preferences, plan: null },
            },
          });
          const input = { ...command(), expectedRevision: 0 };
          const result = await service.generate(actor, String(draft.data.id), input);
          assert.deepEqual(await service.generate(actor, String(draft.data.id), input), result);
          assert.equal(generations, 1);
          await assert.rejects(
            () =>
              service.generate(actor, String(draft.data.id), {
                ...input,
                reason: 'Changed request',
              }),
            { code: 'CONFLICT' },
          );
        },
      );
      await t.test(
        'policy activation is request-scoped and does not mutate another application policy',
        async () => {
          const initial = (await service.list(actor, 'policies', query)).data[0];
          const content = { ...DEFAULT_LEARNING_POLICY, correctXp: 12 };
          const saved = await service.save(actor, 'policies', initial.id, {
            ...command(),
            expectedRevision: 0,
            document: { key: 'learning-default', title: 'Learning policy', content },
          });
          await service.publish(actor, 'policies', initial.id, {
            ...command(),
            expectedRevision: Number(saved.data.revision),
            expectedActiveId: null,
          });
          const selected = await service.runtime(actor, actor.requestId),
            proxy = runtimeLearningPolicy(DEFAULT_LEARNING_POLICY);
          const values = await Promise.all([
            adminRuntimeContext.run(selected, async () => {
              await Promise.resolve();
              return [proxy.correctXp, policyVersion(proxy)];
            }),
            adminRuntimeContext.run({ ...selected, policy: undefined }, async () => [
              proxy.correctXp,
              policyVersion(proxy),
            ]),
          ]);
          assert.equal(values[0]![0], 12);
          assert.equal(values[1]![0], 10);
          assert.notEqual(values[0]![1], values[1]![1]);
          const sessionId = randomUUID();
          await database.runtimePool.query(
            `INSERT INTO product_gotit.practice_sessions(id,application_id,application_user_id,session_type,status,started_at,item_count,algorithm_version,selection) VALUES($1,$2,$3,'recall','active',now(),0,$4,'{"itemIds":[]}'::jsonb)`,
            [sessionId, appId, adminId, policyVersion(DEFAULT_LEARNING_POLICY)],
          );
          const practice = new PracticeService(database.runtimePool, profiles, proxy);
          await adminRuntimeContext.run(selected, () =>
            assert.rejects(
              () => practice.issueExercises(actor, sessionId, exercisesSchema.parse({ count: 1 })),
              { code: 'EXERCISE_STALE' },
            ),
          );
        },
      );
      await t.test(
        'support notes and resolution use optimistic revisions and immutable command receipts',
        async () => {
          const ticket = await service.createSupport(actor, {
            ...command(),
            applicationUserId: userId,
            subject: 'Help with lessons',
            priority: 'normal',
            message: 'Please review the learner request.',
          });
          const input = {
            ...command(),
            expectedRevision: 0,
            status: 'resolved' as const,
            visibility: 'internal' as const,
            message: 'Internal investigation completed.',
          };
          const result = await service.updateSupport(actor, String(ticket.data.id), input);
          assert.deepEqual(
            await service.updateSupport(actor, String(ticket.data.id), input),
            result,
          );
          assert.equal(result.data.status, 'resolved');
          const visible = await service.learnerTickets(
            { applicationId: appId, applicationUserId: userId },
            String(ticket.data.id),
          );
          assert.doesNotMatch(JSON.stringify(visible), /Internal investigation/);
          assert.match(JSON.stringify(visible), /Please review/);
          await assert.rejects(
            () =>
              service.learnerTickets(
                { applicationId: appId, applicationUserId: adminId },
                String(ticket.data.id),
              ),
            { code: 'NOT_FOUND' },
          );
          const learner = { ...actor, applicationUserId: userId, token: 'learner-token' };
          const reply = {
            operationId: randomUUID(),
            expectedRevision: 1,
            message: 'Thank you for the learner response.',
          };
          const answered = await service.replySupport(learner, String(ticket.data.id), reply);
          assert.deepEqual(
            await service.replySupport(learner, String(ticket.data.id), reply),
            answered,
          );
          await assert.rejects(
            () =>
              service.updateSupport(actor, String(ticket.data.id), {
                ...command(),
                expectedRevision: 0,
                status: 'open',
                visibility: 'internal',
              }),
            { code: 'CONFLICT' },
          );
        },
      );
      await t.test(
        'reading credits change available quota without falsifying measured usage',
        async () => {
          const input = {
            ...command(),
            applicationUserId: userId,
            amount: 3,
            endsAt: new Date(Date.now() + 86400000).toISOString(),
          };
          await service.grantQuota(actor, input);
          await service.grantQuota(actor, input);
          const quota = new AiMonthlyQuota(database.runtimePool),
            scope = { applicationId: appId, applicationUserId: userId };
          assert.equal((await quota.status(scope)).limit, 7);
          const reservations = await Promise.allSettled(
            Array.from({ length: 8 }, () => quota.reserve(scope)),
          );
          assert.equal(reservations.filter((result) => result.status === 'fulfilled').length, 7);
          assert.equal((await quota.status(scope)).used, 7);
          assert.equal((await quota.status(scope, { limit: 1, period: 'trial' })).limit, 1);
        },
      );
      await t.test(
        'provider tokens are measured from trusted responses, deduplicated and contain no provider secrets',
        async () => {
          const selected = await service.runtime(actor, actor.requestId);
          let instructions = '';
          const instrumented = adminAiFetch(
            database.runtimePool,
            'reading',
            createLogger('silent'),
            async (_input, init) => {
              instructions = JSON.parse(String(init?.body)).instructions;
              return new Response(
                JSON.stringify({
                  id: 'fixture-provider-response',
                  model: 'fixture-model',
                  usage: {
                    input_tokens: 120,
                    output_tokens: 30,
                    input_tokens_details: { cached_tokens: 10 },
                  },
                  client_secret: 'never-store-this',
                  output: [{ content: 'private learner text' }],
                }),
                { headers: { 'content-type': 'application/json' } },
              );
            },
          );
          await adminRuntimeContext.run(selected, async () => {
            await instrumented('https://api.openai.com/v1/responses', {
              method: 'POST',
              body: JSON.stringify({ instructions: 'Base safety rules.' }),
            });
            await instrumented('https://api.openai.com/v1/responses', {
              method: 'POST',
              body: JSON.stringify({ instructions: 'Base safety rules.' }),
            });
          });
          assert.match(instructions, /Base safety rules/);
          assert.match(instructions, /concrete beginner examples/);
          const usage = await service.list(actor, 'usage', query);
          assert.equal(usage.total, 1);
          assert.equal(usage.data[0]!.inputTokens, 120);
          assert.equal(usage.data[0]!.outputTokens, 30);
          assert.doesNotMatch(JSON.stringify(usage), /never-store-this|private learner text/);
          const audit = await service.list(actor, 'audit', query);
          assert.ok(audit.total >= 8);
          assert.doesNotMatch(JSON.stringify(audit), /fixture-refresh-hash|fixture-password-hash/);
        },
      );
      await t.test(
        'large image usage is bounded, measured and does not block the original response stream',
        async () => {
          const selected = await service.runtime(actor, actor.requestId);
          const imageBody = JSON.stringify({
            data: [{ b64_json: 'x'.repeat(1200000) }],
            usage: { input_tokens: 45, output_tokens: 80 },
          });
          const instrumented = adminAiFetch(
            database.runtimePool,
            'image-generation',
            createLogger('silent'),
            async () =>
              new Response(imageBody, {
                headers: {
                  'content-type': 'application/json',
                  'x-request-id': 'fixture-image-request',
                },
              }),
          );
          await adminRuntimeContext.run(selected, async () => {
            const response = await instrumented('https://api.openai.com/v1/images/generations', {
              method: 'POST',
              body: JSON.stringify({ model: 'fixture-image-model', prompt: 'Fixture image.' }),
            });
            assert.equal((await response.text()).length, imageBody.length);
          });
          const row = (
            await database.runtimePool.query(
              `SELECT input_tokens,output_tokens,model FROM product_gotit.ai_usage_events WHERE provider_response_id='fixture-image-request'`,
            )
          ).rows[0]!;
          assert.equal(row.input_tokens, 45);
          assert.equal(row.output_tokens, 80);
          assert.equal(row.model, 'fixture-image-model');
          const oversized = adminAiFetch(
            database.runtimePool,
            'reading',
            createLogger('silent'),
            async () => new Response('x'.repeat(1100000)),
          );
          await adminRuntimeContext.run(selected, async () => {
            const response = await oversized('https://api.openai.com/v1/responses', {
              method: 'POST',
              body: '{}',
            });
            assert.equal((await response.text()).length, 1100000);
          });
        },
      );
      await t.test(
        'new product migration rolls back and reapplies on disposable data only',
        async () => {
          await assert.rejects(
            () => database.migrate('down'),
            'Rollback must not discard usage above the historical four-generation cap',
          );
          assert.ok(
            (
              await database.adminPool.query(
                `SELECT to_regclass('product_gotit.admin_documents') AS table_name`,
              )
            ).rows[0].table_name,
          );
          // Remove only this disposable fixture before rehearsing the historical constraint.
          await database.runtimePool.query(
            `DELETE FROM product_gotit.ai_monthly_usage WHERE application_id=$1`,
            [appId],
          );
          await database.migrate('down');
          assert.equal(
            (
              await database.adminPool.query(
                `SELECT to_regclass('product_gotit.admin_documents') AS table_name`,
              )
            ).rows[0].table_name,
            null,
          );
          await database.migrate('up');
          assert.ok(
            (
              await database.adminPool.query(
                `SELECT to_regclass('product_gotit.admin_documents') AS table_name`,
              )
            ).rows[0].table_name,
          );
        },
      );
      await t.test(
        'Core additive migration rolls back and reapplies only on the disposable database',
        async () => {
          const run = promisify(execFile);
          const migrateCore = async (direction: 'up' | 'down') =>
            run(
              process.execPath,
              [
                resolve(corePath, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js'),
                direction,
                '--migrations-dir',
                resolve(corePath, 'migrations'),
                '--database-url-var',
                'GOTIT_TEST_CORE_ADMIN_URL',
              ],
              {
                cwd: corePath,
                env: {
                  ...process.env,
                  GOTIT_TEST_CORE_ADMIN_URL: database.adminPool.options.connectionString!,
                },
                timeout: 30000,
                maxBuffer: 2 * 1024 * 1024,
              },
            );
          await assert.rejects(
            () => migrateCore('down'),
            /Remove plan overrides and staff.write grants/,
          );
          await database.adminPool.query(
            `DELETE FROM core.admin_staff_permissions WHERE permission='staff.write'`,
          );
          await migrateCore('down');
          assert.equal(
            (
              await database.adminPool.query(
                `SELECT to_regclass('core.admin_plan_overrides') AS name`,
              )
            ).rows[0].name,
            null,
          );
          await migrateCore('down');
          assert.equal(
            (
              await database.adminPool.query(
                `SELECT to_regclass('core.admin_mfa_credentials') AS table_name`,
              )
            ).rows[0].table_name,
            null,
          );
          assert.equal(
            (
              await database.adminPool.query(
                `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='core' AND table_name='application_users' AND column_name='admin_revision'`,
              )
            ).rows[0].n,
            0,
          );
          await migrateCore('up');
          assert.ok(
            (
              await database.adminPool.query(
                `SELECT to_regclass('core.admin_mfa_credentials') AS table_name`,
              )
            ).rows[0].table_name,
          );
          assert.ok(
            (
              await database.adminPool.query(
                `SELECT id FROM core.application_users WHERE application_id=$1 AND id=$2`,
                [appId, userId],
              )
            ).rowCount,
          );
        },
      );
    } finally {
      await corePool?.end();
      await database.dispose();
    }
  },
);
