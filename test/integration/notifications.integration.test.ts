import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { NotificationRepository } from '../../src/modules/notifications/notification.repository.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { createTestDatabase } from '../helpers/postgres.js';

test(
  'notification preferences, timezone schedule and delivery uniqueness in PostgreSQL',
  { timeout: 150_000 },
  async () => {
    const db = await createTestDatabase();
    try {
      const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
      await db.adminPool.query(
        `INSERT INTO core.applications(id,key,name) VALUES($1,'gotit','GotIt')`,
        [scope.applicationId],
      );
      await db.adminPool.query(
        `INSERT INTO core.application_users(id,application_id,email,email_verified_at)
        VALUES($1,$2,'learner@example.test',now())`,
        [scope.applicationUserId, scope.applicationId],
      );
      const profiles = new ProfileService(new ProfileRepository(db.runtimePool));
      await profiles.getProfile(scope);
      await profiles.patchProfile(scope, { timezone: 'Asia/Jerusalem' });
      const repository = new NotificationRepository(db.runtimePool);
      await repository.patchPreferences(
        scope,
        { practiceEmail: true, practicePush: true, reminderHour: 18 },
        'learner@example.test',
      );
      await repository.addSubscription(scope, {
        endpoint: 'https://push.example.test/device',
        keys: { p256dh: 'public', auth: 'secret' },
      });
      await db.runtimePool.query(
        `INSERT INTO product_gotit.learning_items
        (application_id,application_user_id,source_text,normalized_source_text,
         source_language_code,translation_language_code,item_type,next_review_at)
        VALUES($1,$2,'word','word','en','he','word',$3)`,
        [scope.applicationId, scope.applicationUserId, '2026-09-30T14:00:00Z'],
      );
      assert.equal(await repository.queuePractice(new Date('2026-09-30T14:59:00Z')), 0);
      assert.equal(await repository.queuePractice(new Date('2026-09-30T15:05:00Z')), 2);
      assert.equal(await repository.queuePractice(new Date('2026-09-30T15:30:00Z')), 0);
      const rows = await db.runtimePool.query(
        `SELECT channel,occurrence_key FROM product_gotit.notification_deliveries
        WHERE application_id=$1 AND application_user_id=$2 ORDER BY channel`,
        [scope.applicationId, scope.applicationUserId],
      );
      assert.deepEqual(rows.rows, [
        { channel: 'email', occurrence_key: '2026-09-30' },
        { channel: 'push', occurrence_key: '2026-09-30' },
      ]);
      const first = await repository.claim(new Date('2026-09-30T15:05:00Z'));
      assert.ok(first);
      await repository.finish(first!.id, 'sent');
      const second = await repository.claim(new Date('2026-09-30T15:05:00Z'));
      assert.ok(second);
      assert.notEqual(second!.channel, first!.channel);
      await repository.patchPreferences(
        scope,
        second!.channel === 'push' ? { practicePush: false } : { practiceEmail: false },
        'learner@example.test',
      );
      assert.equal(await repository.allowed(second!), false);
      await repository.finish(second!.id, 'uncertain', 'PREFERENCE_DISABLED');
      assert.equal(await repository.claim(new Date('2026-09-30T15:05:00Z')), undefined);
      await profiles.patchProfile(scope, { timezone: 'Europe/Berlin' });
      await repository.patchPreferences(
        scope,
        { practiceEmail: true, practicePush: true, reminderHour: 2 },
        'learner@example.test',
      );
      assert.equal(await repository.queuePractice(new Date('2026-10-25T00:30:00Z')), 2);
      assert.equal(await repository.queuePractice(new Date('2026-10-25T01:30:00Z')), 0);
      await repository.patchPreferences(
        scope,
        { systemEmail: true, systemPush: true },
        'learner@example.test',
      );
      assert.equal(
        await repository.queueSystem(scope, 'course:ready:1', 'Course ready', 'Open GotIt'),
        2,
      );
      assert.equal(
        await repository.queueSystem(scope, 'course:ready:1', 'Course ready', 'Open GotIt'),
        0,
      );
    } finally {
      await db.dispose();
    }
  },
);
