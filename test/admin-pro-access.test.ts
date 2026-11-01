import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresMinuteWallet } from '../src/modules/private-lessons/minute-wallet.js';
import { ReadingService } from '../src/modules/reading/reading.service.js';
import { AppError } from '../src/shared/errors/app-error.js';
const scope = {
  applicationId: '11111111-1111-4111-8111-111111111111',
  applicationUserId: '22222222-2222-4222-8222-222222222222',
  role: 'admin' as const,
};
test('admin tutor balance is explicitly unlimited without creating or spending purchased minute grants', async () => {
  const unavailable = async () => {
    throw new Error('Must not query grants for admin');
  };
  const wallet = new PostgresMinuteWallet({ connect: unavailable } as never, {
    getMinuteGrants: unavailable,
  });
  assert.deepEqual(await wallet.balance(scope, 'token'), {
    secondsTotal: 0,
    secondsUsed: 0,
    secondsRemaining: 0,
    expiresAt: null,
    unlimited: true,
  });
  for (let i = 0; i < 50; i++) await wallet.reserve(scope, 'lesson-' + i, 1200, 'token');
  await assert.rejects(
    wallet.reserve(scope, 'invalid', 0, 'token'),
    (e: any) => e.code === 'PRIVATE_LESSON_DURATION_INVALID',
  );
  await assert.rejects(
    wallet.balance({ ...scope, role: 'user' }, 'token'),
    /Must not query grants/,
  );
});
test('admin reading has no finite quota and bypasses exhausted allowance before real generation', async () => {
  let quotaCalls = 0,
    generations = 0;
  const id = '33333333-3333-4333-8333-333333333333';
  const client = {
    query: async (q: string | { text: string }) =>
      (typeof q === 'string' ? q : q.text).includes('FROM product_gotit.learning_items')
        ? {
            rows: [
              {
                id,
                source_text: 'station',
                source_language_code: 'en',
                translation_language_code: 'he',
                user_status: 'active',
                deleted_at: null,
                learning_revision: 1,
                part_of_speech: 'noun',
                translations: ['station'],
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 },
    release() {},
  };
  const exhausted = async () => {
    quotaCalls++;
    throw new AppError(429, 'AI_MONTHLY_LIMIT_REACHED', 'Exhausted allowance');
  };
  const service = new ReadingService(
    { connect: async () => client } as never,
    { getProfile: async () => ({ languages: [], interests: [] }) } as never,
    {} as never,
    {
      id: 'fixture',
      generate: async () => {
        generations++;
        return {
          title: 'A station',
          bodyText: 'The station is a warm place where my family meets before we travel together.',
          providerModel: 'fixture',
        };
      },
    },
    's'.repeat(32),
    Date.now,
    { status: exhausted, reserve: exhausted, release: exhausted },
  );
  assert.equal(await service.quotaStatus(scope), null);
  const input = {
    topic: 'station',
    targetLanguageCode: 'en',
    contentType: 'article' as const,
    lengthPreset: 'short' as const,
    learningItemIds: [id],
  };
  const result = await service.preview(scope, input);
  assert.ok(result.publicationToken);
  assert.equal(quotaCalls, 0);
  assert.equal(generations, 1);
  await assert.rejects(service.preview({ ...scope, role: 'user' }, input), /Exhausted allowance/);
  assert.equal(generations, 1);
});
