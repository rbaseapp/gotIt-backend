import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { CoreAuthClient } from '../src/shared/core/core-auth.client.js';
import { createLogger } from '../src/shared/logger/logger.js';

function makeApp() {
  let logs = '';
  let authCalls = 0;
  const destination = new Writable({
    write(chunk, _encoding, done) {
      logs += chunk.toString();
      done();
    },
  });
  const app = createApp({
    logger: createLogger('info', destination),
    coreAuthClient: new CoreAuthClient({
      baseUrl: 'https://core.example.test',
      applicationKey: 'gotit',
      timeoutMs: 100,
      fetchImpl: async () => {
        authCalls++;
        return new Response(null, { status: 401 });
      },
    }),
    profileService: {
      getProfile: async () => {
        throw new Error('not used');
      },
      patchProfile: async () => {
        throw new Error('not used');
      },
    },
    checkDatabase: async () => undefined,
  });
  return { app, logs: () => logs, authCalls: () => authCalls };
}

test('malformed JSON gets a correlated 400 without logging its input or credentials', async () => {
  const fixture = makeApp();
  const response = await request(fixture.app)
    .patch('/api/v1/profile')
    .set('x-request-id', 'malformed-request')
    .set('authorization', 'Bearer private-test-token')
    .set('cookie', 'session=private-test-cookie')
    .set('content-type', 'application/json')
    .send('{"private-sentence": "private-context-marker", broken}')
    .expect(400);

  assert.deepEqual(response.body, {
    error: { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' },
    requestId: 'malformed-request',
  });
  assert.equal(response.headers['x-request-id'], 'malformed-request');
  assert.equal(fixture.authCalls(), 0);
  assert.ok(fixture.logs().includes('malformed-request'));
  for (const privateValue of [
    'private-test-token',
    'private-test-cookie',
    'private-context-marker',
  ]) {
    assert.ok(!fixture.logs().includes(privateValue), 'Private input must not enter logs');
  }
});

test('oversized JSON gets a correlated 413 before authentication', async () => {
  const fixture = makeApp();
  const response = await request(fixture.app)
    .patch('/api/v1/profile')
    .set('content-type', 'application/json')
    .send(JSON.stringify({ interests: ['x'.repeat(256 * 1024)] }))
    .expect(413);

  assert.equal(response.body.error.code, 'PAYLOAD_TOO_LARGE');
  assert.ok(response.body.requestId);
  assert.equal(response.headers['x-request-id'], response.body.requestId);
  assert.equal(fixture.authCalls(), 0);
  assert.ok(fixture.logs().includes(response.body.requestId));
});

test('unexpected errors retain a generic correlated 500 response', async () => {
  const failingApp = createApp({
    logger: createLogger('silent'),
    coreAuthClient: new CoreAuthClient({
      baseUrl: 'https://core.example.test',
      applicationKey: 'gotit',
      timeoutMs: 100,
      fetchImpl: async () =>
        Response.json({
          user: {
            id: '11111111-1111-4111-8111-111111111111',
            applicationId: '22222222-2222-4222-8222-222222222222',
          },
        }),
    }),
    profileService: {
      getProfile: async () => {
        throw new Error('private internal details');
      },
      patchProfile: async () => {
        throw new Error('unused');
      },
    },
    checkDatabase: async () => undefined,
  });
  const response = await request(failingApp)
    .get('/api/v1/profile')
    .set('authorization', 'Bearer test-token')
    .expect(500);
  assert.equal(response.body.error.code, 'INTERNAL_ERROR');
  assert.equal(response.body.error.message, 'Internal server error');
  assert.equal(response.headers['x-request-id'], response.body.requestId);
  assert.ok(!JSON.stringify(response.body).includes('private internal details'));
});
