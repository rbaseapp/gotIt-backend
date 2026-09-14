import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { CoreAuthClient } from '../src/shared/core/core-auth.client.js';

const logger = pino({ enabled: false });
const profileService = {
  getProfile: async () => { throw new Error('not used'); },
  patchProfile: async () => { throw new Error('not used'); },
};

const coreAuthClient = new CoreAuthClient({
  baseUrl: 'https://core.example.test',
  applicationKey: 'gotit',
  timeoutMs: 100,
  fetchImpl: async () => new Response('{}', { status: 500 }),
});

test('GET /health reports liveness and request ID', async () => {
  const app = createApp({
    logger,
    coreAuthClient,
    profileService,
    checkDatabase: async () => undefined,
  });

  const response = await request(app)
    .get('/health')
    .set('x-request-id', 'test-request-id')
    .expect(200);

  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.service, 'gotit-backend');
  assert.equal(response.body.requestId, 'test-request-id');
  assert.equal(response.headers['x-request-id'], 'test-request-id');
});

test('GET /ready returns 200 when PostgreSQL check succeeds', async () => {
  const app = createApp({
    logger,
    coreAuthClient,
    profileService,
    checkDatabase: async () => undefined,
  });

  const response = await request(app).get('/ready').expect(200);

  assert.equal(response.body.status, 'ready');
  assert.equal(response.body.dependencies.database, 'ok');
});

test('GET /ready fails safely when PostgreSQL is unavailable', async () => {
  const app = createApp({
    logger,
    coreAuthClient,
    profileService,
    checkDatabase: async () => {
      throw new Error('database unavailable');
    },
  });

  const response = await request(app).get('/ready').expect(503);

  assert.equal(response.body.error.code, 'NOT_READY');
  assert.equal(response.body.error.message, 'Service is not ready');
});
