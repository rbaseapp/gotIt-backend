import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { CoreAuthClient } from '../src/shared/core/core-auth.client.js';
import { createLogger } from '../src/shared/logger/logger.js';

test('HTTP logs remove Authorization and Cookie while preserving request correlation', async () => {
  let logs = '';
  const logger = createLogger(
    'info',
    new Writable({
      write(chunk, _encoding, done) {
        logs += chunk.toString();
        done();
      },
    }),
  );
  const app = createApp({
    logger,
    coreAuthClient: new CoreAuthClient({
      baseUrl: 'https://core.example.test',
      applicationKey: 'gotit',
      timeoutMs: 100,
      fetchImpl: async () => new Response(null, { status: 401 }),
    }),
    profileService: {
      getProfile: async () => {
        throw new Error('unused');
      },
      patchProfile: async () => {
        throw new Error('unused');
      },
    },
    checkDatabase: async () => undefined,
  });

  await request(app)
    .get('/health')
    .set('x-request-id', 'redaction-request')
    .set('authorization', 'Bearer sensitive-log-test-token')
    .set('cookie', 'session=sensitive-log-test-cookie')
    .expect(200);

  assert.ok(logs.includes('redaction-request'));
  assert.ok(!logs.includes('sensitive-log-test-token'));
  assert.ok(!logs.includes('sensitive-log-test-cookie'));
  const entries = logs
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(entries.some((entry) => entry.req?.method === 'GET' && entry.res?.statusCode === 200));
  for (const entry of entries) {
    assert.equal(entry.req?.headers?.authorization, undefined);
    assert.equal(entry.req?.headers?.cookie, undefined);
  }
});

test('logger removes Set-Cookie from response metadata without dropping other headers', () => {
  let logs = '';
  const logger = createLogger(
    'info',
    new Writable({
      write(chunk, _encoding, done) {
        logs += chunk.toString();
        done();
      },
    }),
  );
  logger.info(
    {
      res: {
        headers: {
          'set-cookie': ['session=sensitive-response-cookie'],
          'x-request-id': 'response-id',
        },
      },
    },
    'Response metadata',
  );
  const entry = JSON.parse(logs);
  assert.equal(entry.res.headers['set-cookie'], undefined);
  assert.equal(entry.res.headers['x-request-id'], 'response-id');
  assert.ok(!logs.includes('sensitive-response-cookie'));
});
