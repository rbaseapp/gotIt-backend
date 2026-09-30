import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { CoreAuthClient } from '../src/shared/core/core-auth.client.js';
import { createLogger } from '../src/shared/logger/logger.js';

const identity = {
  applicationId: '11111111-1111-4111-8111-111111111111',
  applicationUserId: '22222222-2222-4222-8222-222222222222',
};

test('expired free accounts cannot save words or start practice sessions', async () => {
  let captureCalls = 0;
  let practiceCalls = 0;
  let wordPackCalls = 0;
  const coreAuthClient = {
    async validateAccessToken() {
      return identity;
    },
    async getBillingStatus() {
      return {
        tier: 'free',
        access: true,
        plan: { key: 'free', name: 'GotIt Free', kind: 'free' },
        entitlements: ['vocabulary.read', 'dashboard'],
        subscription: null,
        trial: {
          status: 'expired',
          startedAt: '2030-01-01T00:00:00.000Z',
          endsAt: '2030-01-15T00:00:00.000Z',
          daysRemaining: 0,
        },
      };
    },
  } as unknown as CoreAuthClient;
  const app = createApp({
    logger: createLogger('silent'),
    checkDatabase: async () => {},
    coreAuthClient,
    profileService: {} as never,
    captureService: {
      preview: async () => {
        captureCalls++;
        throw new Error('must not run');
      },
      save: async () => {
        captureCalls++;
        throw new Error('must not run');
      },
    } as never,
    practiceService: {
      createSession: async () => {
        practiceCalls++;
        throw new Error('must not run');
      },
    } as never,
    wordPackService: {
      add: async () => {
        wordPackCalls++;
        throw new Error('must not run');
      },
    } as never,
    enforcePaidEntitlements: true,
  });

  const capture = await request(app)
    .post('/api/v1/captures')
    .set('authorization', 'Bearer token')
    .send({});
  const practice = await request(app)
    .post('/api/v1/practice/sessions')
    .set('authorization', 'Bearer token')
    .send({});
  const wordPack = await request(app)
    .post('/api/v1/word-packs/30000000-0000-4000-8000-000000000001/add')
    .set('authorization', 'Bearer token')
    .send({});

  assert.equal(capture.status, 402);
  assert.equal(capture.body.error.code, 'SUBSCRIPTION_REQUIRED');
  assert.equal(practice.status, 402);
  assert.equal(practice.body.error.code, 'SUBSCRIPTION_REQUIRED');
  assert.equal(wordPack.status, 402);
  assert.equal(wordPack.body.error.code, 'SUBSCRIPTION_REQUIRED');
  assert.equal(captureCalls, 0);
  assert.equal(practiceCalls, 0);
  assert.equal(wordPackCalls, 0);
});

test('trial accounts can save words but cannot request AI translation', async () => {
  let previewCalls = 0;
  const coreAuthClient = {
    async validateAccessToken() {
      return identity;
    },
    async getBillingStatus() {
      return {
        tier: 'trial',
        access: true,
        plan: { key: 'pro-trial', name: 'GotIt trial', kind: 'paid' },
        entitlements: ['vocabulary.write'],
        subscription: null,
        trial: {
          status: 'active',
          startedAt: '2030-01-01T00:00:00.000Z',
          endsAt: '2030-01-15T00:00:00.000Z',
          daysRemaining: 6,
        },
      };
    },
  } as unknown as CoreAuthClient;
  const app = createApp({
    logger: createLogger('silent'),
    checkDatabase: async () => {},
    coreAuthClient,
    profileService: {} as never,
    captureService: {
      preview: async () => {
        previewCalls++;
        return {};
      },
    } as never,
    enforcePaidEntitlements: true,
  });

  const ai = await request(app)
    .post('/api/v1/captures/preview')
    .set('authorization', 'Bearer token')
    .send({ translationMethod: 'ai' });

  assert.equal(ai.status, 402);
  assert.equal(ai.body.error.code, 'SUBSCRIPTION_REQUIRED');
  assert.equal(ai.body.error.details.feature, 'translation.ai');
  assert.equal(previewCalls, 0);
});

test('base learning access does not grant AI or private lessons when add-ons are enforced', async () => {
  const granted = new Set<string>();
  const coreAuthClient = {
    async validateAccessToken() {
      return identity;
    },
    async getBillingStatus() {
      return {
        tier: 'paid',
        access: true,
        plan: { key: 'base', name: 'Base', kind: 'paid' },
        entitlements: ['vocabulary.write', 'practice.play'],
        subscription: null,
        trial: null,
      };
    },
  } as unknown as CoreAuthClient;
  const app = createApp({
    logger: createLogger('silent'),
    checkDatabase: async () => {},
    coreAuthClient,
    profileService: {} as never,
    addonAccess: {
      async status(_scope: unknown, kind: string) {
        return granted.has(kind)
          ? {
              cycleId: kind,
              packageKey: kind,
              startsAt: new Date().toISOString(),
              endsAt: new Date(Date.now() + 60_000).toISOString(),
              lessonLimit: null,
              lessonDurationSeconds: null,
              lessonsUsed: 0,
              lessonsRemaining: null,
            }
          : null;
      },
    } as never,
    readingService: { quotaStatus: async () => null } as never,
    privateLessonService: { getSetup: async () => ({ enabled: true }) } as never,
    enforcePaidEntitlements: true,
    enforceAddonEntitlements: true,
  });
  const auth = (path: string) => request(app).get(path).set('authorization', 'Bearer token');
  const reading = await auth('/api/v1/reading/quota');
  const lesson = await auth('/api/v1/private-lessons/setup?targetLanguageCode=en');
  assert.equal(reading.body.error.code, 'ADDON_REQUIRED');
  assert.equal(lesson.body.error.code, 'ADDON_REQUIRED');
  granted.add('ai');
  assert.equal((await auth('/api/v1/reading/quota')).status, 200);
  assert.equal((await auth('/api/v1/private-lessons/setup?targetLanguageCode=en')).status, 402);
  granted.add('private_lessons');
  assert.equal((await auth('/api/v1/private-lessons/setup?targetLanguageCode=en')).status, 200);
  const status = await auth('/api/v1/addons/status');
  assert.equal(status.body.enabled, true);
  assert.equal(status.body.privateLessons.packageKey, 'private_lessons');
});

test('disabled add-on rollout exposes its state without querying grants', async () => {
  const coreAuthClient = {
    async validateAccessToken() {
      return identity;
    },
    async getBillingStatus() {
      throw new Error('billing should not be queried');
    },
  } as unknown as CoreAuthClient;
  const app = createApp({
    logger: createLogger('silent'),
    checkDatabase: async () => {},
    coreAuthClient,
    profileService: {} as never,
    enforcePaidEntitlements: true,
  });
  const status = await request(app)
    .get('/api/v1/addons/status')
    .set('authorization', 'Bearer token');
  assert.equal(status.status, 200);
  assert.deepEqual(
    {
      enabled: status.body.enabled,
      ai: status.body.ai,
      privateLessons: status.body.privateLessons,
    },
    { enabled: false, ai: null, privateLessons: null },
  );
});
