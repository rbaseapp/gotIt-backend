import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import type { CoreAuthClient } from '../src/shared/core/core-auth.client.js';
import { createRequireEntitlementMiddleware } from '../src/shared/middleware/require-entitlement.js';
import { errorHandler } from '../src/shared/middleware/error-handler.js';

function appWith(entitlements: string[]) {
  const core = {
    async getBillingStatus() {
      return { tier: entitlements.length ? 'paid' : 'free', access: true,
        plan: { key: entitlements.length ? 'pro' : 'free', name: 'Plan', kind: entitlements.length ? 'paid' : 'free' },
        entitlements, subscription: null };
    },
  } as unknown as CoreAuthClient;
  const app = express();
  app.use((req, _res, next) => { req.id = 'request-id'; req.gotitCoreAccessToken = 'token'; next(); });
  app.get('/premium', createRequireEntitlementMiddleware(core, 'reading.ai'), (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

test('premium middleware allows an entitled subscriber', async () => {
  const response = await request(appWith(['reading.ai'])).get('/premium');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
});

test('premium middleware fails closed for a free account', async () => {
  const response = await request(appWith([])).get('/premium');
  assert.equal(response.status, 402);
  assert.equal(response.body.error.code, 'SUBSCRIPTION_REQUIRED');
});
