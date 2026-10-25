import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';

test(
  'settings migration down/up preserves legacy consent and delivery audit',
  { timeout: 150_000 },
  async () => {
    const db = await createTestDatabase();
    try {
      const app = randomUUID(),
        user = randomUUID();
      await db.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,'settings-migration','Settings')",
        [app],
      );
      await db.adminPool.query(
        'INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,$3)',
        [user, app, 'migration@example.test'],
      );
      await new ProfileService(new ProfileRepository(db.runtimePool)).getProfile({
        applicationId: app,
        applicationUserId: user,
      });
      await db.adminPool.query(
        'INSERT INTO product_gotit.notification_preferences(application_id,application_user_id,practice_email,weekly_email) VALUES($1,$2,true,true)',
        [app, user],
      );
      for (const status of ['pending', 'sent']) {
        await db.adminPool.query(
          `INSERT INTO product_gotit.notification_deliveries(id,application_id,application_user_id,kind,channel,occurrence_key,subject,body,status)
        VALUES($1,$2,$3,'weekly','email',$4,'Weekly','Progress',$4)`,
          [randomUUID(), app, user, status],
        );
      }
      const last = (
        await db.adminPool.query(
          'SELECT name FROM gotit_migrations.pgmigrations ORDER BY id DESC LIMIT 1',
        )
      ).rows[0].name;
      assert.equal(last, '1792645000000_settings-profile-and-reminders');
      await db.migrate('down');
      assert.deepEqual(
        (
          await db.adminPool.query(
            'SELECT status FROM product_gotit.notification_deliveries ORDER BY status',
          )
        ).rows.map((r) => r.status),
        ['sent', 'suppressed'],
      );
      assert.equal(
        (
          await db.adminPool.query(
            'SELECT practice_email FROM product_gotit.notification_preferences',
          )
        ).rows[0].practice_email,
        true,
      );
      await db.migrate('up');
      const preferences = (
        await db.adminPool.query(
          'SELECT practice_email,weekly_email,reminder_minute,quiet_enabled FROM product_gotit.notification_preferences',
        )
      ).rows[0];
      assert.deepEqual(preferences, {
        practice_email: true,
        weekly_email: false,
        reminder_minute: 0,
        quiet_enabled: false,
      });
      assert.equal(
        (
          await db.adminPool.query(
            'SELECT count(*)::int n FROM product_gotit.notification_deliveries',
          )
        ).rows[0].n,
        2,
      );
    } finally {
      await db.dispose();
    }
  },
);
