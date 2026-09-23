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
