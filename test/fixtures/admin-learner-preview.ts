// Disposable real PostgreSQL + real Core/Product/Admin APIs. Loopback only.
// Fake credentials, no provider keys, and a fixture course generator. Never imported by production.
import { randomUUID } from 'node:crypto';
import { preferences, plan } from '../helpers/course-fixtures.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import express, { type Express } from 'express';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { CoreAuthClient } from '../../src/shared/core/core-auth.client.js';
import { ProductAdminService } from '../../src/modules/admin/admin.service.js';
import { DEFAULT_LEARNING_POLICY } from '../../src/modules/learning/learning.policy.js';
import { CourseService } from '../../src/modules/courses/course.service.js';
import { PostgresLearningDocumentStore } from '../../src/modules/courses/course.repository.js';
import { FixtureGenerator } from '../helpers/course-fixtures.js';
import { createApp as createProductApp } from '../../src/app.js';
import { createLogger } from '../../src/shared/logger/logger.js';

const database = await createTestDatabase();
const servers: Server[] = [];
let disposed = false;
let corePool: { end(): Promise<void> } | undefined;
async function dispose() {
  if (disposed) return;
  disposed = true;
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await corePool?.end();
  await database.dispose();
}
for (const event of ['SIGINT', 'SIGTERM'] as const)
  process.once(event, () => void dispose().finally(() => process.exit()));
async function listen(app: Express, port: number) {
  const server = await new Promise<Server>((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
  servers.push(server);
}
const coreModule = (file: string) =>
  import(pathToFileURL(resolve(process.env.CORE_PLATFORM_PATH ?? '../core-platform', file)).href);
try {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: database.adminPool.options.connectionString,
    JWT_SECRET: 'fixture-only-core-jwt-secret-at-least-thirty-two-characters',
    ADMIN_MFA_ENCRYPTION_KEY: 'fixture-only-admin-mfa-storage-key-thirty-two-characters',
    PADDLE_API_KEY: '',
    BILLING_CHECKOUT_URL: '',
    PADDLE_WEBHOOK_SECRET: '',
    AUTH_RESEND_API_KEY: '',
    AUTH_EMAIL_FROM: '',
    FACEBOOK_APP_SECRETS: '{}',
  });
  const [{ createApp: createCoreApp }, { pool }, { hashPassword }, { AdminService }, { totpCode }] =
    await Promise.all([
      coreModule('src/app.ts'),
      coreModule('src/shared/database/pool.ts'),
      coreModule('src/modules/auth/password.service.ts'),
      coreModule('src/modules/admin/admin.service.ts'),
      coreModule('src/modules/admin/admin.mfa.ts'),
    ]);
  corePool = pool;
  const applicationId = randomUUID(),
    adminId = randomUUID(),
    learnerId = randomUUID();
  await database.adminPool.query(
    `INSERT INTO core.applications(id,key,name) VALUES($1,'gotit','GotIt disposable admin preview')`,
    [applicationId],
  );
  await database.adminPool.query(
    `INSERT INTO core.application_users(application_id,id,email,role,email_verified_at,display_name) VALUES($1,$2,'admin@example.test','admin',now(),'Fixture admin'),($1,$3,'learner@example.test','user',now(),'Fixture learner')`,
    [applicationId, adminId, learnerId],
  );
  const hash = await hashPassword('fixture-only');
  await database.adminPool.query(
    `INSERT INTO core.password_credentials(application_id,application_user_id,password_hash) VALUES($1,$2,$4),($1,$3,$4)`,
    [applicationId, adminId, learnerId, hash],
  );
  await database.adminPool.query(
    `INSERT INTO core.admin_staff_permissions(application_id,application_user_id,permission) SELECT $1,$2,unnest($3::text[])`,
    [
      applicationId,
      adminId,
      [
        'users.write',
        'billing.write',
        'content.write',
        'learning.write',
        'support.write',
        'staff.write',
      ],
    ],
  );
  await database.adminPool.query(
    `INSERT INTO core.billing_plans(application_id,key,name,kind,provider,provider_price_id,billing_interval,entitlements) VALUES($1,'fixture-plan','Fixture access plan','paid','paddle',$2,'month','["practice.play"]')`,
    [applicationId, `pri_${'f'.repeat(26)}`],
  );
  await database.adminPool.query(
    `INSERT INTO core.billing_plans(application_id,key,name,kind,entitlements) VALUES($1,'free','Free / Basic','free','["practice.basic"]')`,
    [applicationId],
  );
  const coreAdmin = new AdminService(database.adminPool);
  const { secret: fixtureSecret } = await coreAdmin.mfa.enroll({
    applicationId,
    applicationUserId: adminId,
    applicationKey: 'gotit',
    sessionId: randomUUID(),
  });
  await database.adminPool.query(
    `UPDATE core.admin_mfa_credentials SET active_secret_enc=pending_secret_enc,pending_secret_enc=NULL,pending_expires_at=NULL,confirmed_at=now() WHERE application_id=$1 AND application_user_id=$2`,
    [applicationId, adminId],
  );
  await listen(createCoreApp(), 48962);
  const profiles = new ProfileService(new ProfileRepository(database.runtimePool));
  await profiles.getProfile({ applicationId, applicationUserId: learnerId });
  await profiles.getProfile({ applicationId, applicationUserId: adminId });
  const scope = [applicationId, learnerId],
    now = new Date().toISOString();
  await profiles.patchProfile(
    { applicationId, applicationUserId: learnerId },
    {
      timezone: 'Asia/Jerusalem',
      languages: [{ languageCode: 'en', selfAssessedLevel: 'A1' }],
      interests: ['Travel'],
    },
  );
  await database.adminPool.query(
    `INSERT INTO core.oauth_identities(application_id,application_user_id,provider,provider_subject,provider_email) VALUES($1,$2,'google','fixture-only-subject','learner-google@example.test')`,
    scope,
  );
  await database.adminPool.query(
    `INSERT INTO core.auth_sessions(application_id,application_user_id,refresh_token_hash,expires_at) VALUES($1,$2,'fixture-only-hash',now()+interval '1 day')`,
    scope,
  );
  await database.adminPool.query(
    `INSERT INTO product_gotit.user_gamification(application_id,application_user_id,total_xp,current_level,current_streak_days,longest_streak_days) VALUES($1,$2,325,2,3,7)`,
    scope,
  );
  await database.adminPool.query(
    `INSERT INTO product_gotit.user_daily_activity(application_id,application_user_id,activity_date,practice_seconds,attempts,correct_attempts,xp_earned) VALUES($1,$2,'2026-10-15',420,12,10,125),($1,$2,'2026-10-16',240,8,6,200)`,
    scope,
  );
  for (let i = 0; i < 30; i++)
    await database.adminPool.query(
      `INSERT INTO product_gotit.practice_sessions(application_id,application_user_id,session_type,status,started_at,duration_seconds,attempt_count,correct_count,xp_earned) VALUES($1,$2,'flashcards','completed',now()-make_interval(days=>$3::int),480,8,6,10)`,
      [...scope, i],
    );
  await database.adminPool.query(
    `INSERT INTO product_gotit.private_lesson_sessions(id,application_id,application_user_id,target_language_code,level,topic,teacher_voice,speech_rate,planned_duration_seconds,actual_duration_seconds,status) VALUES($3,$1,$2,'en','A1','Travel introduction','female','slow',300,245,'completed')`,
    [...scope, randomUUID()],
  );
  await database.adminPool.query(
    `INSERT INTO product_gotit.xp_events(application_id,application_user_id,source_type,xp_amount,reason_code) VALUES($1,$2,'practice',125,'fixture_practice')`,
    scope,
  );
  await database.adminPool.query(
    `INSERT INTO product_gotit.ai_usage_events(application_id,application_user_id,operation,operation_id,provider,model,input_tokens,output_tokens,cached_input_tokens,status) VALUES($1,$2,'reading',gen_random_uuid(),'openai','fixture-model',1200,350,400,'completed'),($1,$2,'lesson-live',gen_random_uuid(),'openai','fixture-realtime',NULL,NULL,NULL,'unmeasured')`,
    scope,
  );
  const courseId = randomUUID(),
    course = {
      kind: 'course',
      id: courseId,
      revision: 0,
      createdAt: now,
      preferences,
      approvedPreferences: preferences,
      preferencesApprovedAt: now,
      ready: true,
      messages: [],
      suggestions: [],
      versions: [{ version: 1, preferences, plan, createdAt: now }],
      activeVersion: 1,
      draftVersion: null,
      evidence: [
        {
          lessonId: randomUUID(),
          version: 1,
          unitKey: plan.units[0]!.key,
          lessonIndex: 0,
          covered: true,
          independent: true,
          recordedAt: now,
        },
      ],
    };
  await database.adminPool.query(
    `INSERT INTO product_gotit.learning_documents(application_id,application_user_id,id,kind,revision,document) VALUES($1,$2,$3,'course',0,$4::jsonb)`,
    [...scope, courseId, JSON.stringify(course)],
  );
  const coreClient = new CoreAuthClient({
    baseUrl: 'http://127.0.0.1:48962',
    applicationKey: 'gotit',
    timeoutMs: 3000,
  });
  const generator = new FixtureGenerator();
  const productAdmin = new ProductAdminService(
    database.runtimePool,
    coreClient,
    profiles,
    DEFAULT_LEARNING_POLICY,
    generator,
  );
  const product = createProductApp({
    logger: createLogger('silent'),
    checkDatabase: async () => {
      await database.runtimePool.query('SELECT 1');
    },
    coreAuthClient: coreClient,
    profileService: profiles,
    adminService: productAdmin,
    courseService: new CourseService(
      new PostgresLearningDocumentStore(database.runtimePool),
      profiles,
      generator,
    ),
    enforcePaidEntitlements: false,
  });
  await listen(product, 48963);
  const adminPath = process.env.ADMIN_CONSOLE_PATH ?? resolve('../gotit-admin');
  const [{ createApp: createAdminApp }, { readConfig }] = await Promise.all([
    import(pathToFileURL(resolve(adminPath, 'server/app.mjs')).href),
    import(pathToFileURL(resolve(adminPath, 'server/config.mjs')).href),
  ]);
  const gateway = createAdminApp(
    readConfig({
      NODE_ENV: 'test',
      PUBLIC_APP_ORIGIN: 'http://127.0.0.1:48967',
      CORE_API_URL: 'http://127.0.0.1:48962',
      GOTIT_API_URL: 'http://127.0.0.1:48963',
      GOOGLE_CLIENT_ID: '',
    }),
    { distDir: resolve(adminPath, 'dist'), logger: { error() {} } },
  );
  // Fixture helper only. Codes refer solely to this disposable test administrator.
  const preview = express();
  preview.post('/fixture/shutdown', (_req, res) => {
    res.json({ status: 'closing' });
    void dispose().finally(() => process.exit());
  });
  preview.get('/fixture/otp', (_req, res) =>
    res.json({ code: totpCode(fixtureSecret, Math.floor(Date.now() / 30000)) }),
  );
  preview.use(gateway);
  await listen(preview, 48967);
  console.log(
    'Disposable admin preview: http://127.0.0.1:48967 (admin@example.test / fixture-only). Core 48962, Product 48963. All data is isolated and destroyed on shutdown.',
  );
} catch (error) {
  await dispose();
  throw error;
}
