import type { ProfileDefaults } from './profile.types.js';

export const PROFILE_DEFAULTS: ProfileDefaults = {
  defaultTranslationLanguage: null,
  timezone: 'UTC',
  dailyGoal: {
    type: 'items',
    value: 20,
  },
  defaultNewItemsPerDay: 10,
  translationMethodPreference: 'auto',
};
