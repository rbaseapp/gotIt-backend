import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { CoreAuthClient } from '../src/shared/core/core-auth.client.js';
import { createLogger } from '../src/shared/logger/logger.js';

test('unit history GET routes accept packId, forward trusted ownership and retain strict validation', async () => {
  const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
  const packId = randomUUID();
  const calls: unknown[][] = [];
  const app = createApp({
    logger: createLogger('silent'),
    profileService: {} as never,
    checkDatabase: async () => {},
    enforcePaidEntitlements: false,
    coreAuthClient: new CoreAuthClient({
      baseUrl: 'https://core.example.test',
      applicationKey: 'gotit',
      timeoutMs: 1000,
      fetchImpl: async () =>
        Response.json({
          user: { id: scope.applicationUserId, applicationId: scope.applicationId },
        }),
    }),
    practiceService: {
      sessions: async (...args: unknown[]) => {
        calls.push(args);
        return { items: [], nextCursor: null, totalCount: 0 };
      },
    } as never,
    privateLessonService: {
      listSessions: async (...args: unknown[]) => {
        calls.push(args);
        return { lessons: [] };
      },
    } as never,
  });
  for (const path of ['/practice/sessions', '/private-lessons']) {
    await request(app)
      .get(`/api/v1${path}?limit=50&packId=${packId}`)
      .set('authorization', 'Bearer test-token')
      .expect(200);
    await request(app)
      .get(`/api/v1${path}?limit=50&packId=invalid`)
      .set('authorization', 'Bearer test-token')
      .expect(400);
    await request(app)
      .get(`/api/v1${path}?limit=50&packId=${packId}&unexpected=1`)
      .set('authorization', 'Bearer test-token')
      .expect(400);
    await request(app).get(`/api/v1${path}?limit=50&packId=${packId}`).expect(401);
  }
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call[0], { ...scope, role: 'user' });
    assert.equal(call[1], 50);
    assert.ok(call.includes(packId));
  }
});
