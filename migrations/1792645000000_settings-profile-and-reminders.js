export const up = (pgm) =>
  pgm.sql(`
 ALTER TABLE product_gotit.user_profiles
   ADD COLUMN display_name varchar(80),
   ADD COLUMN avatar_data text CHECK (avatar_data IS NULL OR octet_length(avatar_data)<=180000);
 ALTER TABLE product_gotit.notification_preferences
   ADD COLUMN enabled boolean NOT NULL DEFAULT true,
   ADD COLUMN reminder_minute smallint NOT NULL DEFAULT 0 CHECK(reminder_minute BETWEEN 0 AND 59),
   ADD COLUMN reminder_days smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}' CHECK(reminder_days <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
   ADD COLUMN quiet_enabled boolean NOT NULL DEFAULT false,
   ADD COLUMN quiet_start smallint NOT NULL DEFAULT 1320 CHECK(quiet_start BETWEEN 0 AND 1439),
   ADD COLUMN quiet_end smallint NOT NULL DEFAULT 420 CHECK(quiet_end BETWEEN 0 AND 1439),
   ADD COLUMN streak_email boolean NOT NULL DEFAULT false,
   ADD COLUMN streak_push boolean NOT NULL DEFAULT false,
   ADD COLUMN weekly_email boolean NOT NULL DEFAULT false,
   ADD COLUMN weekly_push boolean NOT NULL DEFAULT false;
 ALTER TABLE product_gotit.notification_deliveries DROP CONSTRAINT notification_deliveries_kind_check;
 ALTER TABLE product_gotit.notification_deliveries ADD CONSTRAINT notification_deliveries_kind_check CHECK(kind IN ('practice','system','streak','weekly'));
`);
export const down = (pgm) =>
  pgm.sql(`
 UPDATE product_gotit.notification_deliveries SET status='suppressed',last_error_code='FEATURE_ROLLED_BACK' WHERE kind IN ('streak','weekly') AND status IN ('pending','failed');
 ALTER TABLE product_gotit.notification_preferences DROP COLUMN enabled,DROP COLUMN reminder_minute,DROP COLUMN reminder_days,DROP COLUMN quiet_enabled,DROP COLUMN quiet_start,DROP COLUMN quiet_end,DROP COLUMN streak_email,DROP COLUMN streak_push,DROP COLUMN weekly_email,DROP COLUMN weekly_push;
 ALTER TABLE product_gotit.user_profiles DROP COLUMN display_name,DROP COLUMN avatar_data;
`);
