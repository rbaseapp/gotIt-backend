import type { ProfileDefaults } from './profile.types.js';

export const PROFILE_DEFAULTS: ProfileDefaults = {
  learningPreferences: {
    enabledSkills: ['recognition', 'recall', 'listening', 'spelling', 'pronunciation'],
  },
  defaultTranslationLanguage: null,
  timezone: 'UTC',
  dailyGoal: {
    type: 'items',
    value: 20,
  },
  defaultNewItemsPerDay: 10,
  translationMethodPreference: 'auto',
};
