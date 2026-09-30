import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { CoreAuthClient } from '../src/shared/core/core-auth.client.js';
import { createLogger } from '../src/shared/logger/logger.js';
import { validateOrigins } from '../src/shared/middleware/cors.js';
function fixture(
  allowed = true,
  unavailable = false,
  realtimeCallGuard?: Parameters<typeof createApp>[0]['realtimeCallGuard'],
) {
  let authCalls = 0;
  const app = createApp({
    logger: createLogger('silent'),
    checkDatabase: async () => {},
    corsOrigins: [
      'https://web.example.test',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    ],
    coreAuthClient: new CoreAuthClient({
      baseUrl: 'https://core.example.test',
      applicationKey: 'gotit',
      timeoutMs: 100,
      fetchImpl: async () => {
        authCalls++;
        return Response.json({
          user: {
            id: '11111111-1111-4111-8111-111111111111',
            applicationId: '22222222-2222-4222-8222-222222222222',
          },
        });
      },
    }),
    profileService: {
      getProfile: async () => ({
        defaultSourceLanguage: null,
        defaultTranslationLanguage: null,
        timezone: 'UTC',
        dailyGoal: { type: 'items', value: 20 },
        defaultNewItemsPerDay: 10,
        translationMethodPreference: 'auto',
        languages: [],
        interests: [],
      }),
      patchProfile: async () => {
        throw new Error();
      },
    },
    rateLimiter: {
      consume: async () => {
        if (unavailable) throw new Error('private limiter details');
        return { allowed, retryAfter: 60 };
      },
    },
    realtimeCallGuard,
  });
  return { app, authCalls: () => authCalls };
}
test('one-use voice ticket route accepts SDP while ordinary authenticated routes remain available', async () => {
  const events: string[] = [];
  const f = fixture(true, false, {
    async connect(ticket, sdp) {
      events.push(`connect:${ticket}:${sdp}`);
      return 'v=0\r\no=provider\r\n';
    },
    async end(ticket) {
      events.push(`end:${ticket}`);
    },
  });
  const ticket = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const response = await request(f.app)
    .post('/api/v1/realtime/connect')
    .set('Authorization', `Bearer ${ticket}`)
    .set('Content-Type', 'application/sdp')
    .send('v=0\r\no=browser\r\n')
    .expect(200);
  assert.equal(response.text, 'v=0\r\no=provider\r\n');
  await request(f.app)
    .post('/api/v1/realtime/end')
    .set('Authorization', `Bearer ${ticket}`)
    .expect(204);
  await request(f.app)
    .post('/api/v1/realtime/connect')
    .set('Content-Type', 'application/sdp')
    .send('v=0\r\n')
    .expect(401);
  assert.deepEqual(events, [`connect:${ticket}:v=0\r\no=browser\r\n`, `end:${ticket}`]);
  assert.equal(f.authCalls(), 0);
  await request(f.app).get('/api/v1/profile').set('Authorization', 'Bearer fake').expect(200);
});
test('exact CORS origins permit authenticated requests and preflight; foreign/null origins, headers and methods are rejected before auth', async () => {
  const f = fixture();
  await request(f.app)
    .options('/api/v1/profile')
    .set('Origin', 'https://web.example.test')
    .set('Access-Control-Request-Method', 'PATCH')
    .set('Access-Control-Request-Headers', 'Authorization, Content-Type, Idempotency-Key')
    .expect(204);
  assert.equal(f.authCalls(), 0);
  const response = await request(f.app)
    .get('/api/v1/profile')
    .set('Origin', 'https://web.example.test')
    .set('Authorization', 'Bearer fake')
    .expect(200);
  assert.equal(response.headers['access-control-allow-origin'], 'https://web.example.test');
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
  assert.equal(f.authCalls(), 1);
  for (const origin of ['null', 'https://web.example.test.evil.test', 'https://evil.test'])
    await request(f.app).get('/api/v1/profile').set('Origin', origin).expect(403);
  await request(f.app)
    .options('/api/v1/profile')
    .set('Origin', 'https://web.example.test')
    .set('Access-Control-Request-Method', 'TRACE')
    .expect(403);
  await request(f.app)
    .options('/api/v1/profile')
    .set('Origin', 'https://web.example.test')
    .set('Access-Control-Request-Method', 'GET')
    .set('Access-Control-Request-Headers', 'X-Forged-Scope')
    .expect(403);
  assert.equal(f.authCalls(), 1);
  for (const origin of [
    '*',
    'null',
    'https://web.example.test/path',
    'https://user:password@web.example.test',
  ])
    assert.throws(() => validateOrigins([origin]));
});
test('same-origin browser requests are allowed without duplicating the backend URL in CORS_ORIGINS', async () => {
  const f = fixture();
  const response = await request(f.app)
    .get('/api/v1/profile')
    .set('Host', 'backend.example.test')
    .set('Origin', 'https://backend.example.test')
    .set('Authorization', 'Bearer fake')
    .expect(200);
  assert.equal(response.headers['access-control-allow-origin'], 'https://backend.example.test');
  assert.equal(f.authCalls(), 1);
});
test('rate limit rejection has retry guidance and correlation before auth; liveness stays reachable', async () => {
  const f = fixture(false);
  const response = await request(f.app)
    .get('/api/v1/profile')
    .set('Authorization', 'Bearer fake')
    .expect(429);
  assert.equal(response.headers['retry-after'], '60');
  assert.ok(response.body.requestId);
  assert.equal(f.authCalls(), 0);
  await request(f.app).get('/health').expect(200);
  const unavailable = await request(fixture(true, true).app).get('/api/v1/profile').expect(500);
  assert.ok(!JSON.stringify(unavailable.body).includes('private limiter details'));
});
