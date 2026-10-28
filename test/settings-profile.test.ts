import assert from 'node:assert/strict';
import test from 'node:test';
import { profilePatchSchema } from '../src/modules/profile/profile.validation.js';
import { preferencePatchSchema } from '../src/modules/notifications/notification.policy.js';
test('profile photos accept bounded PNG and reject SVG, remote URLs, forged image data and overlarge payloads', () => {
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZYsAAAAASUVORK5CYII=';
  assert.equal(
    profilePatchSchema.safeParse({ avatarData: png, displayName: ' Learner ' }).success,
    true,
  );
  for (const avatarData of [
    'data:image/svg+xml;base64,PHN2Zz4=',
    'https://example.test/image.png',
    'data:image/png;base64,YWJj',
    'data:image/jpeg;base64,' + 'a'.repeat(180000),
  ])
    assert.equal(profilePatchSchema.safeParse({ avatarData }).success, false);
  assert.equal(profilePatchSchema.safeParse({ avatarData: null }).success, true);
});
test('reminder API validates minute, weekday uniqueness and quiet-hour bounds', () => {
  assert.equal(
    preferencePatchSchema.safeParse({
      enabled: false,
      reminderMinute: 30,
      reminderDays: [0, 2],
      quietStart: 1320,
      quietEnd: 420,
      streakEmail: true,
      weeklyPush: true,
    }).success,
    true,
  );
  for (const patch of [
    { reminderMinute: 60 },
    { reminderDays: [1, 1] },
    { reminderDays: [7] },
    { quietStart: 1440 },
  ])
    assert.equal(preferencePatchSchema.safeParse(patch).success, false);
});
