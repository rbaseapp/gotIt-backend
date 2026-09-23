import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/shared/errors/app-error.js';
import {
  AI_TRIAL_LIMIT,
  AiMonthlyQuota,
  aiQuotaPolicyForTier,
} from '../src/modules/reading/ai-monthly-quota.js';

const scope = {
  applicationId: '11111111-1111-4111-8111-111111111111',
  applicationUserId: '22222222-2222-4222-8222-222222222222',
};

test('AI quota policy gives the whole trial one article and paid accounts four per month', () => {
  assert.deepEqual(aiQuotaPolicyForTier('trial'), { limit: 1, period: 'trial' });
  assert.deepEqual(aiQuotaPolicyForTier('paid'), { limit: 4, period: 'month' });
});

test('AI monthly quota reports the fourth successful reservation as exhausted', async () => {
  const queries: string[] = [];
  const quota = new AiMonthlyQuota({
    async query(query: string) {
      queries.push(query);
      return { rows: [{ generation_count: 4 }] };
    },
  } as never);

  const status = await quota.reserve(scope);
  assert.equal(status.limit, 4);
  assert.equal(status.used, 4);
  assert.equal(status.remaining, 0);
  assert.match(queries[0]!, /generation_count<\$4/u);
});

test('AI monthly quota rejects a fifth generation with reset guidance', async () => {
  let calls = 0;
  const quota = new AiMonthlyQuota({
    async query() {
      calls++;
      return calls === 1 ? { rows: [] } : { rows: [{ generation_count: 4 }] };
    },
  } as never);

  await assert.rejects(
    () => quota.reserve(scope),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 429 &&
      error.code === 'AI_MONTHLY_LIMIT_REACHED' &&
      (error.details as { remaining?: number }).remaining === 0,
  );
});

test('AI monthly quota limits a trial account to one generation', async () => {
  let calls = 0;
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const quota = new AiMonthlyQuota({
    async query(text: string, values?: unknown[]) {
      calls++;
      queries.push({ text, values });
      return calls === 1 ? { rows: [] } : { rows: [{ generation_count: 1 }] };
    },
  } as never);

  await assert.rejects(
    () => quota.reserve(scope, { limit: AI_TRIAL_LIMIT, period: 'trial' }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'AI_MONTHLY_LIMIT_REACHED' &&
      (error.details as { limit?: number }).limit === 1,
  );
  assert.equal(queries[0]?.values?.[2], 'trial');
  assert.equal(queries[0]?.values?.[3], 1);
  assert.match(queries[0]?.text ?? '', /DATE '1970-01-01'/u);
});

test('AI monthly quota releases a reservation when generation fails', async () => {
  let query = '';
  const quota = new AiMonthlyQuota({
    async query(value: string) {
      query = value;
      return { rows: [] };
    },
  } as never);

  await quota.release(scope);
  assert.match(query, /generation_count=GREATEST\(0,generation_count-1\)/u);
  assert.match(query, /changed\.generation_count=0/u);
});
