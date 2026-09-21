export const DAILY_GOAL_TYPES = ['items', 'minutes', 'attempts'] as const;
export type DailyGoalType = (typeof DAILY_GOAL_TYPES)[number];

export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

export const TRANSLATION_METHODS = ['auto', 'dictionary', 'ai'] as const;
export type TranslationMethodPreference = (typeof TRANSLATION_METHODS)[number];

export type ProfileScope = {
  applicationId: string;
  applicationUserId: string;
};

export type ProfileLanguage = {
  languageCode: string;
  selfAssessedLevel: CefrLevel | null;
  systemEstimatedLevel: CefrLevel | null;
  effectiveLevel: CefrLevel | null;
  systemConfidence: number | null;
  lastEvaluatedAt: string | null;
};

export type GotItProfile = {
  learningPreferences?: { enabledSkills: import('../learning/learning.policy.js').Skill[] };
  /** Null means that the translation provider must detect the source language. */
  defaultSourceLanguage: string | null;
  defaultTranslationLanguage: string | null;
  timezone: string;
  dailyGoal: {
    type: DailyGoalType;
    value: number;
  };
  defaultNewItemsPerDay: number;
  translationMethodPreference: TranslationMethodPreference | null;
  languages: ProfileLanguage[];
  interests: string[];
};

export type ProfilePatchInput = {
  learningPreferences?: { enabledSkills: import('../learning/learning.policy.js').Skill[] };
  defaultSourceLanguage?: string | null;
  defaultTranslationLanguage?: string | null;
  timezone?: string;
  dailyGoal?: {
    type: DailyGoalType;
    value: number;
  };
  defaultNewItemsPerDay?: number;
  translationMethodPreference?: TranslationMethodPreference | null;
  languages?: Array<{
    languageCode: string;
    selfAssessedLevel: CefrLevel | null;
  }>;
  interests?: string[];
};

export type ProfileDefaults = Pick<
  GotItProfile,
  | 'defaultTranslationLanguage'
  | 'defaultSourceLanguage'
  | 'timezone'
  | 'dailyGoal'
  | 'defaultNewItemsPerDay'
  | 'translationMethodPreference'
  | 'learningPreferences'
>;

export interface ProfileServiceContract {
  getProfile(scope: ProfileScope): Promise<GotItProfile>;
  patchProfile(scope: ProfileScope, input: ProfilePatchInput): Promise<GotItProfile>;
}
