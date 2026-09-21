import type { ProfileScope, ProfileServiceContract } from '../profile/profile.types.js';
import { EnrichmentRegistry } from '../enrichment/enrichment.registry.js';
import { SelectionProofs, captureIntentHash } from '../enrichment/selection-proof.js';
import type { ProviderFacts } from '../enrichment/enrichment.types.js';
import { CaptureRepository } from './capture.repository.js';
import type { PreviewInput, SaveInput } from './capture.validation.js';
import { AppError } from '../../shared/errors/app-error.js';

export class CaptureService {
  constructor(
    private readonly repository: CaptureRepository,
    private readonly profiles: ProfileServiceContract,
    private readonly enrichment = new EnrichmentRegistry(),
    private readonly proofs = new SelectionProofs(undefined),
  ) {}
  async preview(scope: ProfileScope, input: PreviewInput) {
    const profile = await this.profiles.getProfile(scope).catch(() => {
      throw new AppError(
        503,
        'CAPTURE_TEMPORARILY_UNAVAILABLE',
        'Capture profile database is temporarily unavailable',
      );
    });
    const sourceText = input.sourceText ?? input.selectedText;
    // Page metadata is untrusted context, not a translation preference. In particular,
    // a Hebrew UI may contain English text, so <html lang="he"> must never pin Google
    // to a Hebrew-to-Hebrew request.
    let sourceLanguageCode = input.sourceLanguageCode ?? profile.defaultSourceLanguage ?? null;
    let sourceLanguageResolution = input.sourceLanguageCode
      ? 'user'
      : profile.defaultSourceLanguage
        ? 'profile'
        : 'unresolved';
    const translationLanguageCode =
      input.translationLanguageCode ?? profile.defaultTranslationLanguage;
    // Equal source/target preferences cannot produce a translation. Fall back to
    // provider detection instead of sending Google an invalid he -> he pair.
    if (
      sourceLanguageCode &&
      translationLanguageCode &&
      new Intl.Locale(sourceLanguageCode).language ===
        new Intl.Locale(translationLanguageCode).language
    ) {
      sourceLanguageCode = null;
      sourceLanguageResolution = 'unresolved';
    }
    const providerShouldDetectSource = sourceLanguageCode === null;
    const method = input.translationMethod ?? profile.translationMethodPreference ?? 'auto';
    let runId: string | undefined;
    const enriched = translationLanguageCode
      ? await this.enrichment.enrich(
          method,
          {
            sourceText,
            sourceLanguageCode,
            translationLanguageCode,
            sentenceText: input.context?.sentenceText ?? null,
          },
          async (trace) => {
            runId = await this.repository.recordEnrichment(scope, trace, translationLanguageCode);
          },
        )
      : { status: 'needs_language_selection' as const };
    const candidates: Array<Record<string, unknown>> = [];
    if (enriched.status === 'succeeded') {
      sourceLanguageCode = enriched.output.sourceLanguageCode;
      if (providerShouldDetectSource) sourceLanguageResolution = 'provider';
      for (const candidate of enriched.output.candidates) {
        const facts: ProviderFacts = {
          providerName: enriched.provider.id,
          providerType: enriched.provider.kind,
          providerModel: enriched.profile.model,
          runId: runId!,
          candidate,
        };
        candidates.push({
          ...candidate,
          provenance: {
            providerName: facts.providerName,
            providerType: facts.providerType,
            providerModel: facts.providerModel,
            contextUsed: candidate.contextUsed,
          },
          selectionToken: this.proofs.issue(
            scope,
            {
              sourceText,
              sourceLanguageCode: sourceLanguageCode!,
              translationLanguageCode: translationLanguageCode!,
            },
            input.context?.sentenceText ?? null,
            facts,
          ),
        });
      }
    }
    const existingSenses =
      sourceLanguageCode && translationLanguageCode
        ? await this.repository.findCandidates(
            scope,
            sourceText,
            sourceLanguageCode,
            translationLanguageCode,
          )
        : { items: [], hasMore: false };
    return {
      sourceText,
      sourceLanguageCode,
      sourceLanguageResolution,
      translationLanguageCode,
      translationLanguageResolution: input.translationLanguageCode
        ? 'user'
        : translationLanguageCode
          ? 'profile'
          : 'unresolved',
      translationMethod: method,
      enrichment: {
        status: enriched.status,
        candidates,
        ...(enriched.status === 'unavailable'
          ? {
              warnings: [
                {
                  code: enriched.reason
                    ? `ENRICHMENT_${enriched.reason.toUpperCase()}`
                    : 'ENRICHMENT_UNAVAILABLE',
                },
              ],
            }
          : {}),
      },
      existingSenses,
      requiresManualTranslation: candidates.length === 0,
      requiresLanguageSelection: !sourceLanguageCode || !translationLanguageCode,
    };
  }
  async save(scope: ProfileScope, key: string, input: SaveInput) {
    const token = input.translation.selectionToken;
    const claim = token ? this.proofs.decode(token) : null;
    const hash = captureIntentHash(input, claim?.facts ?? null);
    return this.repository.save(scope, key, input, hash, () =>
      claim && token ? this.proofs.verify(token, claim, scope, input) : null,
    );
  }
  getDetail(scope: ProfileScope, id: string) {
    return this.repository.getDetail(scope, id);
  }
}
