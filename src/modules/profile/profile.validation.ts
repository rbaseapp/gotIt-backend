import { z } from 'zod';
import {
  CEFR_LEVELS,
  DAILY_GOAL_TYPES,
  TRANSLATION_METHODS,
} from './profile.types.js';

function canonicalLanguageCode(value: string) {
  try {
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
}

function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const languageCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => canonicalLanguageCode(value) !== null, {
    message: 'Invalid BCP-47 language code',
  });

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isValidTimeZone, {
    message: 'Invalid IANA timezone',
  });

const languageSchema = z
  .object({
    languageCode: languageCodeSchema,
    selfAssessedLevel: z.enum(CEFR_LEVELS).nullable(),
  })
  .strict();

export const profilePatchSchema = z
  .object({
    defaultTranslationLanguage: languageCodeSchema.nullable().optional(),
    timezone: timeZoneSchema.optional(),
    dailyGoal: z
      .object({
        type: z.enum(DAILY_GOAL_TYPES),
        value: z.number().int().positive().max(100_000),
      })
      .strict()
      .optional(),
    defaultNewItemsPerDay: z.number().int().min(0).max(10_000).optional(),
    translationMethodPreference: z.enum(TRANSLATION_METHODS).nullable().optional(),
    languages: z
      .array(languageSchema)
      .max(100)
      .superRefine((languages, context) => {
        const seen = new Set<string>();

        for (const [index, language] of languages.entries()) {
          const canonical = canonicalLanguageCode(language.languageCode)?.toLowerCase();

          if (canonical && seen.has(canonical)) {
            context.addIssue({
              code: 'custom',
              message: 'Duplicate languageCode',
              path: [index, 'languageCode'],
            });
          }

          if (canonical) {
            seen.add(canonical);
          }
        }
      })
      .optional(),
    interests: z
      .array(z.string().trim().min(1).max(100))
      .max(100)
      .superRefine((interests, context) => {
        const seen = new Set<string>();

        for (const [index, interest] of interests.entries()) {
          const normalized = interest.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();

          if (seen.has(normalized)) {
            context.addIssue({
              code: 'custom',
              message: 'Duplicate interest',
              path: [index],
            });
          }

          seen.add(normalized);
        }
      })
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one profile field must be provided',
  });
