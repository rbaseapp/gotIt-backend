import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import type { ProfileScope } from '../../src/modules/profile/profile.types.js';
import { CoreAuthClient } from '../../src/shared/core/core-auth.client.js';
import { createLogger } from '../../src/shared/logger/logger.js';
import { createTestDatabase } from '../helpers/postgres.js';

test(
  'profile persistence with disposable PostgreSQL and a product-only runtime role',
  { timeout: 150_000 },
  async (t) => {
    const database = await createTestDatabase();
    try {
      const applicationA = randomUUID();
      const applicationB = randomUUID();
      const userA: ProfileScope = { applicationId: applicationA, applicationUserId: randomUUID() };
      const userB: ProfileScope = { applicationId: applicationA, applicationUserId: randomUUID() };
      const otherApplicationUser: ProfileScope = {
        applicationId: applicationB,
        applicationUserId: randomUUID(),
      };
      const patchFirstUser: ProfileScope = {
        applicationId: applicationA,
        applicationUserId: randomUUID(),
      };
      await database.adminPool.query(
        `
        INSERT INTO core.applications (id, key, name) VALUES ($1, 'gotit', 'GotIt Test'), ($2, 'sandbox', 'Scope Test')
      `,
        [applicationA, applicationB],
      );
      for (const [index, scope] of [userA, userB, otherApplicationUser, patchFirstUser].entries()) {
        await database.adminPool.query(
          `
          INSERT INTO core.application_users (id, application_id, email) VALUES ($1, $2, $3)
        `,
          [scope.applicationUserId, scope.applicationId, `profile-${index}@example.test`],
        );
      }

      const identities = new Map([
        ['test-user-a', userA],
        ['test-user-b', userB],
        ['test-other-application', otherApplicationUser],
        ['test-patch-first', patchFirstUser],
      ]);
      const coreAuthClient = new CoreAuthClient({
        baseUrl: 'https://core.example.test',
        applicationKey: 'gotit',
        timeoutMs: 1000,
        fetchImpl: async (_input, init) => {
          const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '');
          const scope = identities.get(token ?? '');
          return scope
            ? Response.json({
                user: { id: scope.applicationUserId, applicationId: scope.applicationId },
              })
            : new Response(null, { status: 401 });
        },
      });
      const repository = new ProfileRepository(database.runtimePool);
      const app = createApp({
        logger: createLogger('silent'),
        coreAuthClient,
        profileService: new ProfileService(repository),
        checkDatabase: async () => {
          await database.runtimePool.query('SELECT 1');
        },
      });
      const get = (token: string) =>
        request(app).get('/api/v1/profile').set('authorization', `Bearer ${token}`);
      const patch = (token: string, body: object) =>
        request(app).patch('/api/v1/profile').set('authorization', `Bearer ${token}`).send(body);

      async function snapshot(scope: ProfileScope) {
        const parameters = [scope.applicationId, scope.applicationUserId];
        const profile = await database.adminPool.query(
          `SELECT * FROM product_gotit.user_profiles
          WHERE application_id = $1 AND application_user_id = $2`,
          parameters,
        );
        const languages = await database.adminPool.query(
          `SELECT * FROM product_gotit.user_language_proficiencies
          WHERE application_id = $1 AND application_user_id = $2 ORDER BY language_code`,
          parameters,
        );
        const interests = await database.adminPool.query(
          `SELECT * FROM product_gotit.user_interests
          WHERE application_id = $1 AND application_user_id = $2 ORDER BY normalized_name`,
          parameters,
        );
        return { profile: profile.rows, languages: languages.rows, interests: interests.rows };
      }

      await t.test(
        'fresh bootstrap creates the 20 baseline tables plus two GotIt operational tables',
        async () => {
          const tables = await database.adminPool
            .query(`SELECT count(*)::integer AS count FROM information_schema.tables
          WHERE table_schema = 'product_gotit' AND table_type = 'BASE TABLE'`);
          assert.equal(tables.rows[0].count, 22);
          await assert.rejects(
            () => database.runtimePool.query('SELECT id FROM core.application_users'),
            (error: unknown) => error instanceof Error && 'code' in error && error.code === '42501',
          );
        },
      );

      await t.test(
        'first GET creates defaults and first PATCH creates and updates a profile',
        async () => {
          const first = await get('test-user-a').expect(200);
          assert.deepEqual(first.body.profile, {
            ...PROFILE_DEFAULTS,
            languages: [],
            interests: [],
          });
          const repeated = await get('test-user-a').expect(200);
          assert.deepEqual(repeated.body.profile, first.body.profile);
          const firstPatch = await patch('test-patch-first', { timezone: 'Europe/Paris' }).expect(
            200,
          );
          assert.equal(firstPatch.body.profile.timezone, 'Europe/Paris');
          assert.equal(
            firstPatch.body.profile.defaultNewItemsPerDay,
            PROFILE_DEFAULTS.defaultNewItemsPerDay,
          );
          const persisted = await snapshot(patchFirstUser);
          assert.equal(persisted.profile.length, 1);
          assert.equal(persisted.profile[0].timezone, 'Europe/Paris');
        },
      );

      await t.test(
        'PATCH persists normalized languages and interests and preserves omitted fields',
        async () => {
          const result = await patch('test-user-a', {
            defaultTranslationLanguage: 'HE',
            timezone: 'Asia/Jerusalem',
            dailyGoal: { type: 'attempts', value: 25 },
            defaultNewItemsPerDay: 12,
            languages: [
              { languageCode: 'pt-br', selfAssessedLevel: 'B1' },
              { languageCode: 'EN', selfAssessedLevel: 'B2' },
            ],
            interests: ['  Ｔｅｃｈｎｏｌｏｇｙ  ', 'space   science'],
          }).expect(200);
          assert.equal(result.body.profile.defaultTranslationLanguage, 'he');
          assert.deepEqual(
            result.body.profile.languages.map(
              (language: { languageCode: string }) => language.languageCode,
            ),
            ['en', 'pt-BR'],
          );
          assert.deepEqual(result.body.profile.interests, ['space science', 'Technology']);
          const partial = await patch('test-user-a', { defaultNewItemsPerDay: 0 }).expect(200);
          assert.deepEqual(partial.body.profile, {
            ...result.body.profile,
            defaultNewItemsPerDay: 0,
          });
          const persisted = await get('test-user-a').expect(200);
          assert.deepEqual(persisted.body.profile, partial.body.profile);
          const rows = await snapshot(userA);
          assert.equal(rows.profile[0].daily_goal_type, 'attempts');
          assert.equal(rows.languages.length, 2);
          assert.equal(rows.interests.length, 2);
          assert.ok(rows.interests.some((interest) => interest.normalized_name === 'technology'));
        },
      );

      await t.test(
        'different users and applications stay isolated; forged scope cannot change them',
        async () => {
          await patch('test-user-b', {
            defaultTranslationLanguage: 'fr',
            timezone: 'Europe/Paris',
            interests: ['travel'],
          }).expect(200);
          await patch('test-other-application', {
            timezone: 'America/New_York',
            interests: ['history'],
          }).expect(200);
          const beforeB = await snapshot(userB);
          const beforeOther = await snapshot(otherApplicationUser);
          const own = await get('test-user-a')
            .query({ applicationUserId: userB.applicationUserId, applicationId: applicationB })
            .expect(200);
          assert.equal(own.body.profile.timezone, 'Asia/Jerusalem');
          for (const scopeFields of [
            { applicationUserId: userB.applicationUserId },
            {
              application_id: applicationB,
              application_user_id: otherApplicationUser.applicationUserId,
            },
          ]) {
            const rejected = await patch('test-user-a', { ...scopeFields, timezone: 'UTC' }).expect(
              400,
            );
            assert.equal(rejected.body.error.code, 'VALIDATION_ERROR');
          }
          assert.deepEqual(await snapshot(userB), beforeB);
          assert.deepEqual(await snapshot(otherApplicationUser), beforeOther);
          // A known user ID paired with the wrong application cannot address that user's row.
          const wrongScope = await database.runtimePool.query(
            `SELECT * FROM product_gotit.user_profiles
          WHERE application_id = $1 AND application_user_id = $2`,
            [applicationA, otherApplicationUser.applicationUserId],
          );
          assert.equal(wrongScope.rowCount, 0);
          await assert.rejects(
            () =>
              repository.ensureAndGet(
                {
                  applicationId: applicationA,
                  applicationUserId: otherApplicationUser.applicationUserId,
                },
                PROFILE_DEFAULTS,
              ),
            (error: unknown) =>
              error instanceof Error && 'code' in error && error.code === 'DATABASE_UNAVAILABLE',
          );
        },
      );

      await t.test(
        'invalid language, timezone and normalized duplicates do not mutate any profile table',
        async () => {
          const before = await snapshot(userA);
          for (const body of [
            { timezone: 'invalid/timezone' },
            { defaultTranslationLanguage: 'not_a_language' },
            { interests: ['Technology', 'Ｔｅｃｈｎｏｌｏｇｙ'] },
            {
              languages: [
                { languageCode: 'en', selfAssessedLevel: 'A1' },
                { languageCode: 'EN', selfAssessedLevel: 'B1' },
              ],
            },
          ]) {
            await patch('test-user-a', body).expect(400);
            assert.deepEqual(await snapshot(userA), before);
          }
        },
      );

      await t.test(
        'a late interest write failure rolls back profile, languages and interests',
        async () => {
          const before = await snapshot(userA);
          await database.adminPool.query(`ALTER TABLE product_gotit.user_interests
          ADD CONSTRAINT profile_test_reject_interest CHECK (name <> 'rollback-probe')`);
          try {
            const rejected = await patch('test-user-a', {
              timezone: 'UTC',
              languages: [{ languageCode: 'fr', selfAssessedLevel: 'A2' }],
              interests: ['first-write', 'rollback-probe'],
            }).expect(503);
            assert.equal(rejected.body.error.code, 'DATABASE_UNAVAILABLE');
            assert.ok(!JSON.stringify(rejected.body).includes('profile_test_reject_interest'));
            assert.deepEqual(await snapshot(userA), before);
          } finally {
            await database.adminPool.query(
              'ALTER TABLE product_gotit.user_interests DROP CONSTRAINT profile_test_reject_interest',
            );
          }
          await get('test-user-a').expect(200);
        },
      );

      await t.test('concurrent partial updates preserve both changes', async () => {
        await Promise.all([
          patch('test-user-a', { timezone: 'Europe/London' }).expect(200),
          patch('test-user-a', { dailyGoal: { type: 'minutes', value: 30 } }).expect(200),
        ]);
        const final = await get('test-user-a').expect(200);
        assert.equal(final.body.profile.timezone, 'Europe/London');
        assert.deepEqual(final.body.profile.dailyGoal, { type: 'minutes', value: 30 });
      });

      await t.test('clearing preferences preserves system language estimates', async () => {
        await database.adminPool.query(
          `UPDATE product_gotit.user_language_proficiencies
          SET system_estimated_level = 'B2', effective_level = 'B2', system_confidence = 0.75, last_evaluated_at = NOW()
          WHERE application_id = $1 AND application_user_id = $2 AND language_code = 'en'`,
          [userA.applicationId, userA.applicationUserId],
        );
        const result = await patch('test-user-a', {
          defaultTranslationLanguage: null,
          translationMethodPreference: null,
          languages: [],
          interests: [],
        }).expect(200);
        assert.equal(result.body.profile.defaultTranslationLanguage, null);
        assert.equal(result.body.profile.translationMethodPreference, null);
        assert.deepEqual(result.body.profile.interests, []);
        assert.equal(result.body.profile.languages.length, 1);
        const language = result.body.profile.languages[0];
        assert.equal(language.languageCode, 'en');
        assert.equal(language.selfAssessedLevel, null);
        assert.equal(language.systemEstimatedLevel, 'B2');
        assert.equal(language.effectiveLevel, 'B2');
        assert.equal(language.systemConfidence, 0.75);
        assert.ok(language.lastEvaluatedAt);
      });
    } finally {
      await database.dispose();
    }
  },
);
