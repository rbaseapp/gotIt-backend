import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrivateLessonService } from '../src/modules/private-lessons/private-lesson.service.js';
import { privateLessonInputSchema } from '../src/modules/private-lessons/private-lesson.validation.js';
import type { PrivateLessonWordPackContext } from '../src/modules/private-lessons/private-lesson.prompt.js';
import type { ProfileServiceContract } from '../src/modules/profile/profile.types.js';
import { AppError } from '../src/shared/errors/app-error.js';

const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
const unit: PrivateLessonWordPackContext = {
  packId: randomUUID(),
  title: 'طلب الماء',
  moduleNumber: 1,
  targetLanguageCode: 'ja',
  supportLanguageCode: 'ar',
  level: 'A1',
  station: 'supported',
  completed: 0,
  total: 50,
  words: [
    { sourceText: '水', translationText: 'ماء', exampleText: '水をください。', introduced: false },
  ],
};
const profiles: ProfileServiceContract = {
  getProfile: async () => ({
    defaultSourceLanguage: 'fr',
    defaultTranslationLanguage: 'de',
    timezone: 'UTC',
    dailyGoal: { type: 'items', value: 10 },
    defaultNewItemsPerDay: 10,
    translationMethodPreference: 'auto',
    languages: [],
    interests: [],
  }),
  patchProfile: async () => {
    throw new Error('unexpected profile update');
  },
};

test('a first-unit teacher lesson uses server-resolved words and language pair without claiming speaking readiness', async () => {
  let instructions = '';
  let vocabularyReads = 0;
  const service = new PrivateLessonService({
    apiKey: 'fixture',
    model: 'fixture',
    voice: 'fixture',
    transcriptionModel: 'fixture',
    profiles,
    vocabulary: {
      learned: async () => {
        vocabularyReads++;
        return { items: [] };
      },
    },
    wordPacks: {
      context: async (owner, id, station) => {
        assert.deepEqual(owner, scope);
        assert.equal(id, unit.packId);
        return { context: { ...unit, station }, targets: [] };
      },
    },
    fetchImpl: async (_url, input) => {
      instructions = JSON.parse(String(input?.body)).session.instructions;
      return Response.json({ value: 'ephemeral-fixture' });
    },
  });
  const session = await service.createSession(
    scope,
    privateLessonInputSchema.parse({
      packId: unit.packId,
      station: 'review',
      targetLanguageCode: 'en',
      requestedLevel: 'C2',
    }),
  );
  assert.equal(session.lesson.targetLanguageCode, 'ja');
  assert.equal(session.lesson.supportLanguageCode, 'ar');
  assert.equal(session.lesson.level, 'A1');
  assert.equal(session.lesson.lessonMode, 'absolute_beginner');
  assert.equal(session.lesson.wordPack?.station, 'review');
  assert.equal(session.lesson.wordPack?.completed, 0);
  assert.equal(session.lesson.roadmap, null);
  assert.equal(vocabularyReads, 0);
  assert.match(instructions, /水/u);
  assert.match(instructions, /not proof of speaking readiness/u);
  assert.ok(session.lesson.customFocus!.length <= 300);
});

test('unit and approved-course contexts cannot be forged or combined', () => {
  for (const input of [
    { packId: 'invalid' },
    { station: 'review' },
    { packId: unit.packId, courseId: randomUUID() },
  ])
    assert.equal(
      privateLessonInputSchema.safeParse({ targetLanguageCode: 'ja', ...input }).success,
      false,
    );
});

test('missing or inaccessible units fail before creating or charging a voice session', async () => {
  let providerCalls = 0;
  const service = new PrivateLessonService({
    apiKey: 'fixture',
    model: 'fixture',
    voice: 'fixture',
    transcriptionModel: 'fixture',
    profiles,
    vocabulary: { learned: async () => ({ items: [] }) },
    wordPacks: {
      context: async () => {
        throw new AppError(404, 'NOT_FOUND', 'Missing unit');
      },
    },
    fetchImpl: async () => {
      providerCalls++;
      return Response.json({ value: 'fixture' });
    },
  });
  await assert.rejects(
    service.createSession(scope, { targetLanguageCode: 'ja', packId: unit.packId }),
    (error) => error instanceof AppError && error.statusCode === 404,
  );
  assert.equal(providerCalls, 0);
});

test('a failed activity allocation removes its journal and releases all reservations', async () => {
  const effects: string[] = [];
  let id = '';
  const service = new PrivateLessonService({
    apiKey: 'fixture',
    model: 'fixture',
    voice: 'fixture',
    transcriptionModel: 'fixture',
    profiles,
    vocabulary: { learned: async () => ({ items: [] }) },
    journal: {
      list: async () => [],
      create: async (_owner: unknown, plan: { id: string }) => {
        id = plan.id;
        effects.push('journal');
      },
      remove: async (owner: unknown, lessonId: string) => {
        assert.deepEqual(owner, scope);
        assert.equal(lessonId, id);
        effects.push('remove');
        return true;
      },
    } as never,
    activities: {
      create: async () => {
        throw new Error('database unavailable');
      },
    } as never,
    minuteWallet: {
      reserve: async () => {
        effects.push('reserve');
      },
      release: async (lessonId: string) => {
        assert.equal(lessonId, id);
        effects.push('release');
      },
    } as never,
    realtimeCallGuard: {
      reserve: async () => 'fixture-ticket',
      cancel: async () => {
        effects.push('cancel');
      },
    } as never,
    fetchImpl: async () => Response.json({ value: 'fixture' }),
  });
  await assert.rejects(
    service.createSession(scope, { targetLanguageCode: 'ja' }, 'fixture-access'),
    (error) => error instanceof AppError && error.statusCode === 503,
  );
  assert.deepEqual(effects, ['reserve', 'journal', 'remove', 'cancel', 'release']);
});
