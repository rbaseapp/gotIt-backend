import type { Pool } from 'pg';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';

/**
 * Creates only the base profile row. Tests that roll migrations back to an older schema cannot use
 * ProfileRepository.ensureAndGet, because it also selects columns that later migrations add.
 */
export async function ensureProfileRow(
  pool: Pool,
  scope: { applicationId: string; applicationUserId: string },
) {
  const d = PROFILE_DEFAULTS;
  await pool.query(
    `INSERT INTO product_gotit.user_profiles (application_id,application_user_id,default_source_language,
       default_translation_language,timezone,daily_goal_type,daily_goal_value,default_new_items_per_day,
       translation_method_preference,learning_preferences,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
     ON CONFLICT (application_id,application_user_id) DO NOTHING`,
    [
      scope.applicationId,
      scope.applicationUserId,
      d.defaultSourceLanguage,
      d.defaultTranslationLanguage,
      d.timezone,
      d.dailyGoal.type,
      d.dailyGoal.value,
      d.defaultNewItemsPerDay,
      d.translationMethodPreference,
      JSON.stringify(d.learningPreferences),
    ],
  );
}
