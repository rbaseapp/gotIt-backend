import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CoreAuthClient } from '../src/shared/core/core-auth.client.js';
import { AppError } from '../src/shared/errors/app-error.js';

test('CoreAuthClient maps Core /auth/me user to trusted GotIt identity', async () => {
  let seenHeaders: Headers | undefined;

  const client = new CoreAuthClient({
    baseUrl: 'https://core.example.test',
    applicationKey: 'gotit',
    timeoutMs: 1000,
    fetchImpl: async (_input, init) => {
      seenHeaders = new Headers(init?.headers);

      return new Response(
        JSON.stringify({
          user: {
            id: '11111111-1111-4111-8111-111111111111',
            applicationId: '22222222-2222-4222-8222-222222222222',
            email: 'user@example.test',
            emailVerified: true,
            status: 'active',
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });

  const identity = await client.validateAccessToken('access-token', 'request-123');

  assert.deepEqual(identity, {
    applicationId: '22222222-2222-4222-8222-222222222222',
    applicationUserId: '11111111-1111-4111-8111-111111111111',
  });

  assert.equal(seenHeaders?.get('authorization'), 'Bearer access-token');
  assert.equal(seenHeaders?.get('x-application-key'), 'gotit');
  assert.equal(seenHeaders?.get('x-request-id'), 'request-123');
});

test('CoreAuthClient maps invalid Core token to 401', async () => {
  const client = new CoreAuthClient({
    baseUrl: 'https://core.example.test',
    applicationKey: 'gotit',
    timeoutMs: 1000,
    fetchImpl: async () => new Response(null, { status: 401 }),
  });

  await assert.rejects(
    () => client.validateAccessToken('bad-token'),
    (error: unknown) =>
      error instanceof AppError && error.statusCode === 401 && error.code === 'UNAUTHORIZED',
  );
});

test('CoreAuthClient fails closed when Core is unavailable', async () => {
  const client = new CoreAuthClient({
    baseUrl: 'https://core.example.test',
    applicationKey: 'gotit',
    timeoutMs: 1000,
    fetchImpl: async () => {
      throw new TypeError('network down');
    },
  });

  await assert.rejects(
    () => client.validateAccessToken('access-token'),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 503 &&
      error.code === 'CORE_AUTH_UNAVAILABLE',
  );
});

for (const status of [403, 404, 429, 500, 503]) {
  test(`CoreAuthClient maps Core ${status} without retrying`, async () => {
    let calls = 0;
    const client = new CoreAuthClient({
      baseUrl: 'https://core.example.test',
      applicationKey: 'gotit',
      timeoutMs: 100,
      fetchImpl: async () => {
        calls++;
        return new Response(null, { status });
      },
    });
    await assert.rejects(
      () => client.validateAccessToken('test-token'),
      (error: unknown) =>
        error instanceof AppError &&
        error.statusCode === (status === 403 ? 401 : 503) &&
        error.code === (status === 403 ? 'UNAUTHORIZED' : 'CORE_AUTH_UNAVAILABLE'),
    );
    assert.equal(calls, 1);
  });
}

for (const [description, body] of [
  ['malformed JSON', '{broken'],
  ['missing user', '{}'],
  [
    'invalid user ID',
    JSON.stringify({ user: { id: 'bad', applicationId: '22222222-2222-4222-8222-222222222222' } }),
  ],
  [
    'missing application scope',
    JSON.stringify({ user: { id: '11111111-1111-4111-8111-111111111111' } }),
  ],
  [
    'invalid application ID',
    JSON.stringify({ user: { id: '11111111-1111-4111-8111-111111111111', applicationId: 'bad' } }),
  ],
] as const) {
  test(`CoreAuthClient rejects ${description} with a fail-closed 503`, async () => {
    let calls = 0;
    const client = new CoreAuthClient({
      baseUrl: 'https://core.example.test',
      applicationKey: 'gotit',
      timeoutMs: 100,
      fetchImpl: async () => {
        calls++;
        return new Response(body, { status: 200 });
      },
    });
    await assert.rejects(
      () => client.validateAccessToken('test-token'),
      (error: unknown) =>
        error instanceof AppError &&
        error.statusCode === 503 &&
        error.code === 'CORE_AUTH_INVALID_RESPONSE',
    );
    assert.equal(calls, 1);
  });
}

test('CoreAuthClient aborts a timed-out dependency and does not retry', async () => {
  let calls = 0;
  const client = new CoreAuthClient({
    baseUrl: 'https://core.example.test',
    applicationKey: 'gotit',
    timeoutMs: 20,
    fetchImpl: async (_input, init) => {
      calls++;
      assert.ok(init?.signal);
      await delay(10_000, undefined, { signal: init.signal });
      throw new Error('Timeout did not abort');
    },
  });
  await assert.rejects(
    () => client.validateAccessToken('test-token'),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 503 &&
      error.code === 'CORE_AUTH_UNAVAILABLE',
  );
  assert.equal(calls, 1);
});
