import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProviderHttpError,
  providerFailureCode,
  readProviderJson,
} from '../src/modules/enrichment/providers/http.js';

test('provider HTTP failures retain only a safe actionable category', async () => {
  for (const [status, expected] of [
    [400, 'invalid_request'],
    [401, 'authentication'],
    [402, 'billing'],
    [403, 'permission'],
    [429, 'rate_limit'],
    [503, 'upstream'],
  ] as const) {
    await assert.rejects(
      () =>
        readProviderJson(
          new Response('private upstream body', { status }),
          new AbortController().signal,
        ),
      (error: unknown) => {
        assert.ok(error instanceof ProviderHttpError);
        assert.equal(error.status, status);
        assert.equal(providerFailureCode(error), expected);
        assert.equal(error.message.includes('private upstream body'), false);
        return true;
      },
    );
  }
});

test('provider 404 is treated as an inaccessible workspace or model', async () => {
  await assert.rejects(
    readProviderJson(new Response(null, { status: 404 }), new AbortController().signal),
    (error: unknown) => providerFailureCode(error) === 'permission',
  );
});
