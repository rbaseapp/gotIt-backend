import { PROFILE_DEFAULTS } from './profile.constants.js';
import type { ProfileRepository } from './profile.repository.js';
import type {
  GotItProfile,
  ProfilePatchInput,
  ProfileScope,
  ProfileServiceContract,
} from './profile.types.js';

export class ProfileService implements ProfileServiceContract {
  constructor(private readonly repository: ProfileRepository) {}

  async getProfile(scope: ProfileScope): Promise<GotItProfile> {
    return this.repository.ensureAndGet(scope, PROFILE_DEFAULTS);
  }

  async patchProfile(
    scope: ProfileScope,
    input: ProfilePatchInput,
  ): Promise<GotItProfile> {
    const normalized = normalizePatch(input);
    return this.repository.patch(scope, PROFILE_DEFAULTS, normalized);
  }
}

function normalizePatch(input: ProfilePatchInput): ProfilePatchInput {
  return {
    ...input,
    ...(input.defaultTranslationLanguage !== undefined
      ? {
          defaultTranslationLanguage:
            input.defaultTranslationLanguage === null
              ? null
              : canonicalizeLanguageCode(input.defaultTranslationLanguage),
        }
      : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone.trim() } : {}),
    ...(input.languages !== undefined
      ? {
          languages: input.languages.map((language) => ({
            languageCode: canonicalizeLanguageCode(language.languageCode),
            selfAssessedLevel: language.selfAssessedLevel,
          })),
        }
      : {}),
    ...(input.interests !== undefined
      ? {
          interests: input.interests.map((interest) =>
            interest.normalize('NFKC').replace(/\s+/gu, ' ').trim(),
          ),
        }
      : {}),
  };
}

function canonicalizeLanguageCode(value: string) {
  return Intl.getCanonicalLocales(value)[0] ?? value;
}
