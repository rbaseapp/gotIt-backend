import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nextSmartLearningExercise,
  PracticeService,
  smartLearningSequence,
  answerWordLengths,
} from '../src/modules/practice/practice.service.js';

test('typed answers expose word boundaries without exposing their letters', () => {
  assert.deepEqual(answerWordLengths('take it easy'), [4, 2, 4]);
  assert.deepEqual(answerWordLengths('  multiple   spaces  '), [8, 6]);
});

test('smart learning follows the staged path required for every word', () => {
  assert.deepEqual(
    smartLearningSequence(['recognition', 'recall', 'listening', 'spelling', 'pronunciation']),
    ['matching', 'flashcards', 'pronunciation', 'recall', 'listening_spelling'],
  );
});

test('smart learning skips unavailable activities without starting with recall', () => {
  assert.deepEqual(smartLearningSequence(['recognition', 'recall', 'spelling']), [
    'matching',
    'flashcards',
    'recall',
  ]);
  assert.deepEqual(smartLearningSequence(['recognition', 'recall'], false), [
    'flashcards',
    'recall',
  ]);
});

test('smart learning advances only after each earlier activity was mastered', () => {
  const skills = ['recognition', 'recall', 'listening', 'spelling', 'pronunciation'] as const;

  assert.equal(nextSmartLearningExercise([...skills], []), 'matching');
  assert.equal(
    nextSmartLearningExercise([...skills], ['recall', 'listening_spelling']),
    'matching',
  );
  assert.equal(nextSmartLearningExercise([...skills], ['matching', 'flashcards']), 'pronunciation');
  assert.equal(
    nextSmartLearningExercise([...skills], ['matching', 'flashcards', 'pronunciation']),
    'recall',
  );
  assert.equal(
    nextSmartLearningExercise([...skills], ['matching', 'flashcards', 'pronunciation', 'recall']),
    'listening_spelling',
  );
});

test('speech skills are enabled by default and remain gated by provider support', () => {
  const profiles = { async getProfile() {} };
  const available = new PracticeService(
    {} as never,
    profiles as never,
    undefined,
    (language) => language === 'en',
  );
  const unavailable = new PracticeService({} as never, profiles as never);
  const profile = {} as never;

  assert.deepEqual(available.availableSkills(profile, 'en'), [
    'recognition',
    'recall',
    'listening',
    'spelling',
    'pronunciation',
  ]);
  assert.deepEqual(unavailable.availableSkills(profile, 'en'), [
    'recognition',
    'recall',
    'spelling',
  ]);
});

test('learning queue uses a non-reserved translation alias and maps it to the response', async () => {
  let queueSql = '';
  const client = {
    async query(input: string | { text: string }) {
      const sql = typeof input === 'string' ? input : input.text;
      if (sql.includes('WITH candidates AS')) {
        queueSql = sql;
        return {
          rows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              source_text: 'learn',
              source_language_code: 'en',
              translation_language_code: 'he',
              primary_translation: 'ללמוד',
              learning_status: 'new',
              next_review_at: null,
              queue_score: '65',
            },
          ],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
  };
  const profiles = {
    async getProfile() {
      return {
        timezone: 'UTC',
        defaultNewItemsPerDay: 10,
        learningPreferences: { enabledSkills: ['recognition', 'recall', 'spelling'] },
      };
    },
  };
  const service = new PracticeService(pool as never, profiles as never);

  const result = await service.queue(
    {
      applicationId: '22222222-2222-4222-8222-222222222222',
      applicationUserId: '33333333-3333-4333-8333-333333333333',
    },
    10,
  );

  assert.match(queueSql, /\) primary_translation,/u);
  assert.doesNotMatch(queueSql, /\) primary,/u);
  assert.equal(result.items[0]?.primaryTranslation, 'ללמוד');
});
