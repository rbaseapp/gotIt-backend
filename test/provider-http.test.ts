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

test('provider safely distinguishes workspace and model access failures', async () => {
  for (const [status, message, expected] of [
    [404, 'Workspace `wrkspc_private` not found.', 'workspace'],
    [400, 'anthropic-workspace-id is required for this API key.', 'workspace'],
    [404, 'The requested model does not exist or you do not have access to it.', 'model_access'],
  ] as const) {
    await assert.rejects(
      readProviderJson(
        Response.json({ error: { type: 'not_found_error', message } }, { status }),
        new AbortController().signal,
      ),
      (error: unknown) => {
        assert.ok(error instanceof ProviderHttpError);
        assert.equal(providerFailureCode(error), expected);
        assert.equal(error.message.includes(message), false);
        return true;
      },
    );
  }
});
