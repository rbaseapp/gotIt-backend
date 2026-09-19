import assert from 'node:assert/strict';
import test from 'node:test';

import { PracticeService } from '../src/modules/practice/practice.service.js';

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
