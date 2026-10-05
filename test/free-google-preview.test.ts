import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { CaptureService } from '../src/modules/capture/capture.service.js';
import type { CaptureRepository } from '../src/modules/capture/capture.repository.js';
import { EnrichmentRegistry } from '../src/modules/enrichment/enrichment.registry.js';
import { GoogleCloudTranslationProvider } from '../src/modules/enrichment/providers/google-cloud.js';
import { SelectionProofs } from '../src/modules/enrichment/selection-proof.js';
import type { ProfileServiceContract } from '../src/modules/profile/profile.types.js';
import { CoreAuthClient } from '../src/shared/core/core-auth.client.js';
import { createLogger } from '../src/shared/logger/logger.js';

test('free Google preview reaches the provider without granting AI or vocabulary writes', async () => {
  const scope = {
    applicationId: '11111111-1111-4111-8111-111111111111',
    applicationUserId: '22222222-2222-4222-8222-222222222222',
  };
  let providerCalls = 0;
  let billingCalls = 0;
  let traceCalls = 0;
  const coreAuthClient = new CoreAuthClient({
    baseUrl: 'https://core.example.test',
    applicationKey: 'gotit',
    timeoutMs: 1000,
    fetchImpl: async (url, init) => {
      if (new Headers(init?.headers).get('authorization') !== 'Bearer free-token')
        return new Response(null, { status: 401 });
      if (String(url).endsWith('/auth/me'))
        return Response.json({
          user: { id: scope.applicationUserId, applicationId: scope.applicationId, role: 'user' },
        });
      billingCalls++;
      return Response.json({
        tier: 'free',
        access: true,
        plan: { key: 'free', name: 'Free', kind: 'free' },
        entitlements: ['vocabulary.read', 'dashboard'],
        subscription: null,
        trial: {
          status: 'expired',
          startedAt: '2026-01-01T00:00:00Z',
          endsAt: '2026-01-15T00:00:00Z',
          daysRemaining: 0,
        },
      });
    },
  });
  const google = new GoogleCloudTranslationProvider('synthetic-key', {}, async (_url, init) => {
    providerCalls++;
    assert.deepEqual(JSON.parse(init?.body as string), {
      q: ['commandeered'],
      source: 'en',
      target: 'he',
      format: 'text',
    });
    return Response.json({ data: { translations: [{ translatedText: 'הוחרם' }] } });
  });
  const profiles = {
    getProfile: async () => ({
      defaultSourceLanguage: 'en',
      defaultTranslationLanguage: 'he',
      translationMethodPreference: 'ai',
    }),
  } as unknown as ProfileServiceContract;
  const repository = {
    findCandidates: async (actualScope: unknown) => {
      assert.deepEqual(actualScope, { ...scope, role: 'user' });
      return { items: [], hasMore: false };
    },
    recordEnrichment: async () => {
      traceCalls++;
      return '33333333-3333-4333-8333-333333333333';
    },
    save: async () => {
      throw new Error('Free preview must not grant save');
    },
  } as unknown as CaptureRepository;
  const app = createApp({
    logger: createLogger('silent'),
    checkDatabase: async () => {},
    coreAuthClient,
    profileService: profiles,
    captureService: new CaptureService(
      repository,
      profiles,
      new EnrichmentRegistry(
        [google],
        [{ id: 'google', providerId: google.id, model: null, timeoutMs: 1000 }],
        { dictionary: { profiles: ['google'], timeoutMs: 1000 } },
      ),
      new SelectionProofs('s'.repeat(32)),
    ),
    enforcePaidEntitlements: true,
    enforceAddonEntitlements: true,
    addonAccess: {
      status: async () => {
        throw new Error('Google must not require an AI add-on');
      },
    } as never,
  });
  const input = { selectedText: 'commandeered', translationMethod: 'dictionary' };
  const preview = await request(app)
    .post('/api/v1/captures/preview')
    .set('Authorization', 'Bearer free-token')
    .send(input);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.preview.enrichment.status, 'succeeded');
  assert.equal(preview.body.preview.enrichment.candidates[0].text, 'הוחרם');
  assert.equal(preview.body.preview.enrichment.candidates[0].provenance.providerName, google.id);
  assert.ok(preview.body.preview.enrichment.candidates[0].selectionToken);
  assert.equal(billingCalls, 0);
  assert.equal(providerCalls, 1);
  assert.equal(traceCalls, 1);

  for (const translationMethod of ['ai', 'auto', undefined]) {
    const blocked = await request(app)
      .post('/api/v1/captures/preview')
      .set('Authorization', 'Bearer free-token')
      .send({ selectedText: 'commandeered', translationMethod });
    assert.equal(blocked.status, 402);
    assert.equal(blocked.body.error.code, 'SUBSCRIPTION_REQUIRED');
  }
  const save = await request(app)
    .post('/api/v1/captures')
    .set('Authorization', 'Bearer free-token')
    .send(input);
  assert.equal(save.status, 402);
  assert.equal(save.body.error.code, 'SUBSCRIPTION_REQUIRED');
  for (const token of [undefined, 'invalid-token']) {
    const call = request(app).post('/api/v1/captures/preview');
    if (token) call.set('Authorization', `Bearer ${token}`);
    assert.equal((await call.send(input)).status, 401);
  }
  const invalid = await request(app)
    .post('/api/v1/captures/preview')
    .set('Authorization', 'Bearer free-token')
    .send({ ...input, selectedText: '' });
  assert.equal(invalid.status, 400);
  assert.equal(providerCalls, 1);
  assert.equal(traceCalls, 1);
});
