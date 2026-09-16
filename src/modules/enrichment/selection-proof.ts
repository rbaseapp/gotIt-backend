import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ProfileScope } from '../profile/profile.types.js';
import {
  candidateSchema,
  languageSchema,
  textSchema,
  uuidSchema,
  type SaveInput,
} from '../capture/capture.validation.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { ProviderFacts } from './enrichment.types.js';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export const fingerprint = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export const factsSchema = z
  .object({
    providerName: textSchema(100),
    providerType: z.enum(['translation_api', 'dictionary', 'ai']),
    providerModel: textSchema(200).nullable(),
    runId: uuidSchema,
    candidate: candidateSchema,
  })
  .strict();
const claimSchema = z
  .object({
    version: z.literal(1),
    applicationId: uuidSchema,
    applicationUserId: uuidSchema,
    sourceText: textSchema(500),
    sourceLanguageCode: languageSchema,
    translationLanguageCode: languageSchema,
    sentenceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    facts: factsSchema,
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type SelectionClaim = z.output<typeof claimSchema>;
const invalid = () =>
  new AppError(400, 'ENRICHMENT_SELECTION_INVALID', 'Invalid enrichment selection');

export class SelectionProofs {
  constructor(
    private readonly secret: string | undefined,
    private readonly now = Date.now,
  ) {
    if (secret !== undefined && Buffer.byteLength(secret) < 32)
      throw new Error('Enrichment signing secret must contain at least 32 bytes');
  }
  issue(
    scope: ProfileScope,
    input: Pick<SelectionClaim, 'sourceText' | 'sourceLanguageCode' | 'translationLanguageCode'>,
    sentenceText: string | null,
    facts: ProviderFacts,
  ): string {
    if (!this.secret) throw new Error('Enrichment signing is not configured');
    const claim = claimSchema.parse({
      version: 1,
      applicationId: scope.applicationId,
      applicationUserId: scope.applicationUserId,
      sourceText: input.sourceText,
      sourceLanguageCode: input.sourceLanguageCode,
      translationLanguageCode: input.translationLanguageCode,
      sentenceHash: fingerprint(sentenceText),
      facts,
      expiresAt: this.now() + 600_000,
    });
    const payload = Buffer.from(canonicalJson(claim)).toString('base64url');
    const token = `${payload}.${this.sign(payload)}`;
    if (token.length > 65536) throw invalid();
    return token;
  }
  /** Untrusted decoding is used only to compare an already committed own receipt. */
  decode(token: string): SelectionClaim {
    if (token.length > 65536 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(token))
      throw invalid();
    try {
      return claimSchema.parse(
        JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')),
      );
    } catch {
      throw invalid();
    }
  }
  verify(
    token: string,
    claim: SelectionClaim,
    scope: ProfileScope,
    input: SaveInput,
  ): ProviderFacts {
    if (!this.secret) throw invalid();
    const [payload, signature] = token.split('.');
    const expected = Buffer.from(this.sign(payload!));
    const actual = Buffer.from(signature!);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid();
    if (
      claim.applicationId !== scope.applicationId ||
      claim.applicationUserId !== scope.applicationUserId ||
      claim.sourceText !== input.item.sourceText ||
      claim.sourceLanguageCode !== input.item.sourceLanguageCode ||
      claim.translationLanguageCode !== input.item.translationLanguageCode ||
      claim.sentenceHash !== fingerprint(input.context.sentenceText)
    )
      throw invalid();
    const candidate = claim.facts.candidate;
    if (
      candidate.text !== input.translation.text ||
      canonicalJson([...candidate.variants].sort()) !==
        canonicalJson([...input.translation.variants].sort()) ||
      candidate.partOfSpeech !== input.item.partOfSpeech ||
      candidate.phoneticText !== input.item.phoneticText ||
      candidate.phoneticScheme !== input.item.phoneticScheme
    )
      throw invalid();
    if (claim.expiresAt <= this.now())
      throw new AppError(
        400,
        'ENRICHMENT_SELECTION_EXPIRED',
        'Enrichment selection expired; request a new preview',
      );
    return claim.facts;
  }
  private sign(payload: string) {
    return createHmac('sha256', this.secret!).update(payload).digest('base64url');
  }
}

export function captureIntentHash(input: SaveInput, facts: ProviderFacts | null) {
  return fingerprint({
    item: input.item,
    context: input.context,
    senseDecision: input.senseDecision,
    translation: { text: input.translation.text, variants: [...input.translation.variants].sort() },
    facts: facts
      ? {
          ...facts,
          candidate: { ...facts.candidate, variants: [...facts.candidate.variants].sort() },
        }
      : null,
  });
}
