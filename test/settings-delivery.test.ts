import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotificationSender } from '../src/modules/notifications/notification.providers.js';
test('Resend delivery uses a stable idempotency key and the configured DEV learning link', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return new Response('{}', { status: 200 });
  };
  try {
    const sender = createNotificationSender(
      {
        resendApiKey: 'test-fixture',
        emailFrom: 'support@example.test',
        appUrl: 'https://gotit-dev.rbaseapp.com',
      },
      {} as never,
    );
    await sender.email!(
      'learner@example.test',
      'Review',
      'Vocabulary is ready',
      'owner:practice:day',
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://api.resend.com/emails');
    assert.equal(new Headers(calls[0]!.init.headers).get('Idempotency-Key'), 'owner:practice:day');
    assert.match(
      JSON.parse(String(calls[0]!.init.body)).text,
      /https:\/\/gotit-dev.rbaseapp.com\/learn/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
