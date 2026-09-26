import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { requireAdmin } from '../src/shared/middleware/require-role.js';
import { errorHandler } from '../src/shared/middleware/error-handler.js';

function appFor(role?: 'user' | 'admin') {
  const app = express();
  app.use((req, _res, next) => {
    req.id = 'request-id';
    if (role)
      req.gotitAuth = {
        applicationId: '11111111-1111-4111-8111-111111111111',
        applicationUserId: '22222222-2222-4222-8222-222222222222',
        role,
      };
    next();
  });
  app.get('/admin', requireAdmin, (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

test('admin-only middleware permits admins', async () => {
  assert.equal((await request(appFor('admin')).get('/admin')).status, 200);
});

test('admin-only middleware rejects regular users', async () => {
  const response = await request(appFor('user')).get('/admin');
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'FORBIDDEN');
});

test('admin-only middleware rejects missing authentication', async () => {
  const response = await request(appFor()).get('/admin');
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'UNAUTHORIZED');
});
