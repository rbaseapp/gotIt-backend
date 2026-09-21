import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { CoreAuthClient } from '../src/shared/core/core-auth.client.js';
import type {
  GotItProfile,
  ProfilePatchInput,
  ProfileScope,
  ProfileServiceContract,
} from '../src/modules/profile/profile.types.js';

const logger = pino({ enabled: false });
const identity = {
  applicationId: '22222222-2222-4222-8222-222222222222',
  applicationUserId: '11111111-1111-4111-8111-111111111111',
};

function makeCoreAuthClient() {
  return new CoreAuthClient({
    baseUrl: 'https://core.example.test',
    applicationKey: 'gotit',
    timeoutMs: 1000,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          user: {
            id: identity.applicationUserId,
            applicationId: identity.applicationId,
            email: 'user@example.test',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });
}

const baseProfile: GotItProfile = {
  defaultSourceLanguage: null,
  defaultTranslationLanguage: null,
  timezone: 'UTC',
  dailyGoal: { type: 'items', value: 20 },
  defaultNewItemsPerDay: 10,
  translationMethodPreference: 'auto',
  languages: [],
  interests: [],
};

function makeApp(profileService: ProfileServiceContract) {
  return createApp({
    logger,
    coreAuthClient: makeCoreAuthClient(),
    profileService,
    checkDatabase: async () => undefined,
  });
}

test('GET /api/v1/profile requires authentication', async () => {
  const profileService: ProfileServiceContract = {
    getProfile: async () => baseProfile,
    patchProfile: async () => baseProfile,
  };

  const response = await request(makeApp(profileService)).get('/api/v1/profile').expect(401);
  assert.equal(response.body.error.code, 'UNAUTHORIZED');
});

test('GET /api/v1/profile uses trusted Core identity', async () => {
  let seenScope: ProfileScope | undefined;

  const profileService: ProfileServiceContract = {
    getProfile: async (scope) => {
      seenScope = scope;
      return baseProfile;
    },
    patchProfile: async () => baseProfile,
  };

  const response = await request(makeApp(profileService))
    .get('/api/v1/profile')
    .set('authorization', 'Bearer valid-token')
    .expect(200);

  assert.deepEqual(seenScope, identity);
  assert.deepEqual(response.body.profile, baseProfile);
});

test('PATCH /api/v1/profile rejects client-supplied authorization scope', async () => {
  const profileService: ProfileServiceContract = {
    getProfile: async () => baseProfile,
    patchProfile: async () => baseProfile,
  };

  const response = await request(makeApp(profileService))
    .patch('/api/v1/profile')
    .set('authorization', 'Bearer valid-token')
    .send({
      applicationUserId: '33333333-3333-4333-8333-333333333333',
      timezone: 'UTC',
    })
    .expect(400);

  assert.equal(response.body.error.code, 'VALIDATION_ERROR');
});

test('PATCH /api/v1/profile forwards validated patch with trusted scope', async () => {
  let seenScope: ProfileScope | undefined;
  let seenPatch: ProfilePatchInput | undefined;

  const updated: GotItProfile = {
    ...baseProfile,
    defaultSourceLanguage: 'en',
    defaultTranslationLanguage: 'he',
    timezone: 'Asia/Jerusalem',
    interests: ['technology'],
  };

  const profileService: ProfileServiceContract = {
    getProfile: async () => baseProfile,
    patchProfile: async (scope, patch) => {
      seenScope = scope;
      seenPatch = patch;
      return updated;
    },
  };

  const response = await request(makeApp(profileService))
    .patch('/api/v1/profile')
    .set('authorization', 'Bearer valid-token')
    .send({
      defaultSourceLanguage: 'EN',
      defaultTranslationLanguage: 'he',
      timezone: 'Asia/Jerusalem',
      interests: ['technology'],
    })
    .expect(200);

  assert.deepEqual(seenScope, identity);
  assert.deepEqual(seenPatch, {
    defaultSourceLanguage: 'EN',
    defaultTranslationLanguage: 'he',
    timezone: 'Asia/Jerusalem',
    interests: ['technology'],
  });
  assert.deepEqual(response.body.profile, updated);
});
