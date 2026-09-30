import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  NotificationService,
  RetryableDeliveryError,
} from '../src/modules/notifications/notification.service.js';
import {
  eligibleChannels,
  practiceOccurrence,
} from '../src/modules/notifications/notification.policy.js';
import type {
  NotificationRepository,
  Delivery,
} from '../src/modules/notifications/notification.repository.js';
import type { ProfileServiceContract } from '../src/modules/profile/profile.types.js';
import { CoreAuthClient } from '../src/shared/core/core-auth.client.js';

const scope = {
  applicationId: '22222222-2222-4222-8222-222222222222',
  applicationUserId: '11111111-1111-4111-8111-111111111111',
};
const profile = {
  defaultSourceLanguage: null,
  defaultTranslationLanguage: null,
  timezone: 'Asia/Jerusalem',
  dailyGoal: { type: 'items' as const, value: 10 },
  defaultNewItemsPerDay: 5,
  translationMethodPreference: null,
  languages: [],
  interests: [],
};
const profiles: ProfileServiceContract = {
  getProfile: async () => profile,
  patchProfile: async () => profile,
};

test('practice reminders use profile local date and do not duplicate at DST fall-back', () => {
  assert.equal(
    practiceOccurrence(new Date('2026-10-25T00:30:00Z'), 'Europe/Berlin', 2),
    '2026-10-25',
  );
  assert.equal(
    practiceOccurrence(new Date('2026-10-25T01:30:00Z'), 'Europe/Berlin', 2),
    '2026-10-25',
  );
  assert.equal(
    practiceOccurrence(new Date('2026-03-29T01:30:00Z'), 'Europe/Berlin', 2),
    '2026-03-29',
  );
  assert.equal(practiceOccurrence(new Date('2026-09-30T14:30:00Z'), 'Asia/Jerusalem', 18), null);
});

test('channel eligibility respects each consent and available destination', () => {
  const preferences = {
    practiceEmail: true,
    practicePush: false,
    systemEmail: false,
    systemPush: true,
    reminderHour: 18,
  };
  assert.deepEqual(eligibleChannels('practice', preferences, true, true), ['email']);
  assert.deepEqual(eligibleChannels('practice', preferences, false, true), []);
  assert.deepEqual(eligibleChannels('system', preferences, true, true), ['push']);
  assert.deepEqual(eligibleChannels('system', preferences, true, false), []);
});

test('notification preference API validates consent and verified email from Core', async () => {
  const patches: unknown[] = [];
  const repository = {
    getPreferences: async () => ({
      practiceEmail: false,
      practicePush: false,
      systemEmail: false,
      systemPush: false,
      reminderHour: 18,
    }),
    patchPreferences: async (_scope: unknown, patch: unknown, email: unknown) => {
      patches.push({ patch, email });
      return patch;
    },
  } as unknown as NotificationRepository;
  const service = new NotificationService(repository, profiles, { email: async () => undefined });
  const coreAuthClient = new CoreAuthClient({
    baseUrl: 'https://core.example.test',
    applicationKey: 'gotit',
    timeoutMs: 1000,
    fetchImpl: async (_url, init) =>
      Response.json({
        user: {
          id: scope.applicationUserId,
          applicationId: scope.applicationId,
          email: 'learner@example.test',
          emailVerified: new Headers(init?.headers).get('authorization') === 'Bearer verified',
        },
      }),
  });
  const app = createApp({
    logger: pino({ enabled: false }),
    coreAuthClient,
    profileService: profiles,
    notificationService: service,
    checkDatabase: async () => undefined,
  });
  await request(app)
    .patch('/api/v1/notifications/preferences')
    .set('authorization', 'Bearer unverified')
    .send({ practiceEmail: true })
    .expect(409);
  await request(app)
    .patch('/api/v1/notifications/preferences')
    .set('authorization', 'Bearer verified')
    .send({ practiceEmail: true, reminderHour: 25 })
    .expect(400);
  await request(app)
    .patch('/api/v1/notifications/preferences')
    .set('authorization', 'Bearer verified')
    .send({ practiceEmail: true, reminderHour: 18 })
    .expect(200);
  await request(app)
    .post('/api/v1/notifications/push-subscriptions')
    .set('authorization', 'Bearer verified')
    .send({ endpoint: 'https://127.0.0.1/private', keys: { p256dh: 'x', auth: 'y' } })
    .expect(400);
  assert.deepEqual(patches, [
    { patch: { practiceEmail: true, reminderHour: 18 }, email: 'learner@example.test' },
  ]);
});

test('uncertain provider failure is not automatically retried', async () => {
  const states: string[] = [];
  let claimed = false;
  const delivery: Delivery = {
    id: 'delivery',
    ...{
      application_id: scope.applicationId,
      application_user_id: scope.applicationUserId,
      kind: 'practice',
      channel: 'email',
      occurrence_key: '2026-09-30',
      subject: 'Practice',
      body: 'Review now',
      attempts: 1,
      verified_email: 'learner@example.test',
    },
  };
  const repository = {
    expireLeases: async () => undefined,
    suppressStale: async () => undefined,
    queuePractice: async () => 0,
    claim: async () => (claimed ? undefined : ((claimed = true), delivery)),
    allowed: async () => true,
    finish: async (_id: string, status: string) => {
      states.push(status);
    },
  } as unknown as NotificationRepository;
  const service = new NotificationService(repository, profiles, {
    email: async () => {
      throw new Error('timeout');
    },
  });
  assert.deepEqual(await service.run(new Date('2026-09-30T15:00:00Z')), {
    queued: 0,
    processed: 1,
  });
  assert.deepEqual(states, ['uncertain']);
});

test('explicit provider rejection receives bounded retry time', async () => {
  const now = new Date('2026-09-30T15:00:00Z');
  let claimed = false;
  let finish: unknown;
  const delivery: Delivery = {
    id: 'delivery',
    application_id: scope.applicationId,
    application_user_id: scope.applicationUserId,
    kind: 'practice',
    channel: 'push',
    occurrence_key: '2026-09-30',
    subject: 'Practice',
    body: 'Review now',
    attempts: 2,
    verified_email: null,
  };
  const repository = {
    expireLeases: async () => undefined,
    suppressStale: async () => undefined,
    queuePractice: async () => 0,
    claim: async () => (claimed ? undefined : ((claimed = true), delivery)),
    allowed: async () => true,
    finish: async (_id: string, status: string, code: string, retryAt: Date) => {
      finish = { status, code, retryAt };
    },
  } as unknown as NotificationRepository;
  const service = new NotificationService(repository, profiles, {
    push: async () => {
      throw new RetryableDeliveryError('429');
    },
  });
  await service.run(now);
  assert.deepEqual(finish, {
    status: 'failed',
    code: 'PROVIDER_REJECTED',
    retryAt: new Date(now.getTime() + 4 * 60000),
  });
});
