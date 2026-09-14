import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabasePool } from '../../shared/database/pool.js';
import type {
  CefrLevel,
  GotItProfile,
  ProfileDefaults,
  ProfilePatchInput,
  ProfileScope,
  TranslationMethodPreference,
  DailyGoalType,
} from './profile.types.js';

type ProfileRow = {
  default_translation_language: string | null;
  timezone: string;
  daily_goal_type: DailyGoalType;
  daily_goal_value: number;
  default_new_items_per_day: number;
  translation_method_preference: TranslationMethodPreference | null;
};

type LanguageRow = {
  language_code: string;
  self_assessed_level: CefrLevel | null;
  system_estimated_level: CefrLevel | null;
  effective_level: CefrLevel | null;
  system_confidence: string | number | null;
  last_evaluated_at: Date | string | null;
};

type InterestRow = {
  name: string;
};

export class ProfileRepository {
  constructor(private readonly pool: DatabasePool) {}

  async ensureAndGet(
    scope: ProfileScope,
    defaults: ProfileDefaults,
  ): Promise<GotItProfile> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await this.ensureProfile(client, scope, defaults);
      const profile = await this.loadProfile(client, scope);
      await client.query('COMMIT');
      return profile;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async patch(
    scope: ProfileScope,
    defaults: ProfileDefaults,
    patch: ProfilePatchInput,
  ): Promise<GotItProfile> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await this.ensureProfile(client, scope, defaults);

      const currentResult = await client.query<ProfileRow>(
        `
          SELECT
            default_translation_language,
            timezone,
            daily_goal_type,
            daily_goal_value,
            default_new_items_per_day,
            translation_method_preference
          FROM product_gotit.user_profiles
          WHERE application_id = $1
            AND application_user_id = $2
          FOR UPDATE
        `,
        [scope.applicationId, scope.applicationUserId],
      );

      const current = currentResult.rows[0];

      if (!current) {
        throw new Error('GotIt profile was not created');
      }

      await client.query(
        `
          UPDATE product_gotit.user_profiles
          SET
            default_translation_language = $3,
            timezone = $4,
            daily_goal_type = $5,
            daily_goal_value = $6,
            default_new_items_per_day = $7,
            translation_method_preference = $8,
            updated_at = NOW()
          WHERE application_id = $1
            AND application_user_id = $2
        `,
        [
          scope.applicationId,
          scope.applicationUserId,
          patch.defaultTranslationLanguage !== undefined
            ? patch.defaultTranslationLanguage
            : current.default_translation_language,
          patch.timezone ?? current.timezone,
          patch.dailyGoal?.type ?? current.daily_goal_type,
          patch.dailyGoal?.value ?? current.daily_goal_value,
          patch.defaultNewItemsPerDay ?? current.default_new_items_per_day,
          patch.translationMethodPreference !== undefined
            ? patch.translationMethodPreference
            : current.translation_method_preference,
        ],
      );

      if (patch.languages !== undefined) {
        await this.replaceUserLanguagePreferences(client, scope, patch.languages);
      }

      if (patch.interests !== undefined) {
        await this.replaceInterests(client, scope, patch.interests);
      }

      const profile = await this.loadProfile(client, scope);
      await client.query('COMMIT');
      return profile;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureProfile(
    client: PoolClient,
    scope: ProfileScope,
    defaults: ProfileDefaults,
  ) {
    await client.query(
      `
        INSERT INTO product_gotit.user_profiles (
          application_id,
          application_user_id,
          default_translation_language,
          timezone,
          daily_goal_type,
          daily_goal_value,
          default_new_items_per_day,
          translation_method_preference,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        ON CONFLICT (application_id, application_user_id) DO NOTHING
      `,
      [
        scope.applicationId,
        scope.applicationUserId,
        defaults.defaultTranslationLanguage,
        defaults.timezone,
        defaults.dailyGoal.type,
        defaults.dailyGoal.value,
        defaults.defaultNewItemsPerDay,
        defaults.translationMethodPreference,
      ],
    );
  }

  private async replaceUserLanguagePreferences(
    client: PoolClient,
    scope: ProfileScope,
    languages: NonNullable<ProfilePatchInput['languages']>,
  ) {
    const languageCodes = languages.map((language) => language.languageCode);

    if (languageCodes.length === 0) {
      await client.query(
        `
          UPDATE product_gotit.user_language_proficiencies
          SET self_assessed_level = NULL,
              updated_at = NOW()
          WHERE application_id = $1
            AND application_user_id = $2
        `,
        [scope.applicationId, scope.applicationUserId],
      );
    } else {
      await client.query(
        `
          UPDATE product_gotit.user_language_proficiencies
          SET self_assessed_level = NULL,
              updated_at = NOW()
          WHERE application_id = $1
            AND application_user_id = $2
            AND NOT (language_code = ANY($3::text[]))
        `,
        [scope.applicationId, scope.applicationUserId, languageCodes],
      );
    }

    for (const language of languages) {
      await client.query(
        `
          INSERT INTO product_gotit.user_language_proficiencies (
            id,
            application_id,
            application_user_id,
            language_code,
            self_assessed_level,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
          ON CONFLICT (application_id, application_user_id, language_code)
          DO UPDATE SET
            self_assessed_level = EXCLUDED.self_assessed_level,
            updated_at = NOW()
        `,
        [
          randomUUID(),
          scope.applicationId,
          scope.applicationUserId,
          language.languageCode,
          language.selfAssessedLevel,
        ],
      );
    }

    await client.query(
      `
        DELETE FROM product_gotit.user_language_proficiencies
        WHERE application_id = $1
          AND application_user_id = $2
          AND self_assessed_level IS NULL
          AND system_estimated_level IS NULL
          AND effective_level IS NULL
          AND system_confidence IS NULL
          AND last_evaluated_at IS NULL
      `,
      [scope.applicationId, scope.applicationUserId],
    );
  }

  private async replaceInterests(
    client: PoolClient,
    scope: ProfileScope,
    interests: NonNullable<ProfilePatchInput['interests']>,
  ) {
    await client.query(
      `
        DELETE FROM product_gotit.user_interests
        WHERE application_id = $1
          AND application_user_id = $2
      `,
      [scope.applicationId, scope.applicationUserId],
    );

    for (const interest of interests) {
      await client.query(
        `
          INSERT INTO product_gotit.user_interests (
            id,
            application_id,
            application_user_id,
            name,
            normalized_name,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, NOW())
        `,
        [
          randomUUID(),
          scope.applicationId,
          scope.applicationUserId,
          interest,
          normalizeInterest(interest),
        ],
      );
    }
  }

  private async loadProfile(
    client: PoolClient,
    scope: ProfileScope,
  ): Promise<GotItProfile> {
    const [profileResult, languagesResult, interestsResult] = await Promise.all([
      client.query<ProfileRow>(
        `
          SELECT
            default_translation_language,
            timezone,
            daily_goal_type,
            daily_goal_value,
            default_new_items_per_day,
            translation_method_preference
          FROM product_gotit.user_profiles
          WHERE application_id = $1
            AND application_user_id = $2
        `,
        [scope.applicationId, scope.applicationUserId],
      ),
      client.query<LanguageRow>(
        `
          SELECT
            language_code,
            self_assessed_level,
            system_estimated_level,
            effective_level,
            system_confidence,
            last_evaluated_at
          FROM product_gotit.user_language_proficiencies
          WHERE application_id = $1
            AND application_user_id = $2
          ORDER BY language_code ASC
        `,
        [scope.applicationId, scope.applicationUserId],
      ),
      client.query<InterestRow>(
        `
          SELECT name
          FROM product_gotit.user_interests
          WHERE application_id = $1
            AND application_user_id = $2
          ORDER BY normalized_name ASC
        `,
        [scope.applicationId, scope.applicationUserId],
      ),
    ]);

    const row = profileResult.rows[0];

    if (!row) {
      throw new Error('GotIt profile not found');
    }

    return {
      defaultTranslationLanguage: row.default_translation_language,
      timezone: row.timezone,
      dailyGoal: {
        type: row.daily_goal_type,
        value: row.daily_goal_value,
      },
      defaultNewItemsPerDay: row.default_new_items_per_day,
      translationMethodPreference: row.translation_method_preference,
      languages: languagesResult.rows.map((language) => ({
        languageCode: language.language_code,
        selfAssessedLevel: language.self_assessed_level,
        systemEstimatedLevel: language.system_estimated_level,
        effectiveLevel: language.effective_level,
        systemConfidence:
          language.system_confidence === null ? null : Number(language.system_confidence),
        lastEvaluatedAt:
          language.last_evaluated_at === null
            ? null
            : new Date(language.last_evaluated_at).toISOString(),
      })),
      interests: interestsResult.rows.map((interest) => interest.name),
    };
  }
}

function normalizeInterest(value: string) {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}
