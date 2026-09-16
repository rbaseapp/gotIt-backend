import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../shared/database/transaction.js';
import { AppError } from '../../shared/errors/app-error.js';
import { scopeValues, itemSnapshot, itemNotFound } from '../library/library.repository.js';
import type { ProfileScope, ProfileServiceContract } from '../profile/profile.types.js';
import type { PracticeService } from '../practice/practice.service.js';
import { fingerprint } from '../enrichment/selection-proof.js';
import {
  generatedReadingSchema,
  readingInputSchema,
  type ReadingInput,
  type ReadingGenerator,
  type ReadingTarget,
} from './reading.validation.js';

const targetSchema = z
  .object({
    id: z.uuid(),
    sourceText: z.string().max(4000),
    translationText: z.string().max(8000),
    translationLanguageCode: z.string().max(64),
    partOfSpeech: z.string().max(800).nullable(),
    snapshotHash: z.string().length(64),
    occurrenceCount: z.number().int().min(1).max(12000),
    ranges: z
      .array(z.object({ start: z.number().int().min(0), end: z.number().int().min(1) }).strict())
      .max(12000),
  })
  .strict();
const ticketSchema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    applicationId: z.uuid(),
    applicationUserId: z.uuid(),
    expiresAt: z.number().int(),
    input: readingInputSchema,
    topic: z.string().max(4000),
    effectiveLevel: z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']).nullable(),
    content: generatedReadingSchema,
    providerName: z.string().max(100),
    providerModel: z.string().max(200).nullable(),
    targets: z.array(targetSchema).min(1).max(20),
  })
  .strict();
const missing = () => new AppError(404, 'NOT_FOUND', 'Reading content not found');
export class ReadingService {
  private readonly key: Buffer | undefined;
  constructor(
    private readonly pool: Pool,
    private readonly profiles: ProfileServiceContract,
    private readonly practice: PracticeService,
    private readonly generator?: ReadingGenerator,
    secret?: string,
    private readonly now: () => number = Date.now,
  ) {
    this.key = secret
      ? createHash('sha256').update(`gotit-reading-v1:${secret}`).digest()
      : undefined;
  }
  get available() {
    return Boolean(this.generator && this.key);
  }
  async preview(scope: ProfileScope, input: ReadingInput) {
    if (!this.generator || !this.key)
      throw new AppError(
        503,
        'READING_NOT_CONFIGURED',
        'Reading generation provider is unavailable',
      );
    const profile = await this.profiles.getProfile(scope),
      topic = input.topic ?? profile.interests.join(', ');
    if (!topic) throw new AppError(400, 'TOPIC_REQUIRED', 'Choose a topic or profile interests');
    const effectiveLevel =
      input.requestedLevel ??
      profile.languages.find((l) => l.languageCode === input.targetLanguageCode)?.effectiveLevel ??
      profile.languages.find((l) => l.languageCode === input.targetLanguageCode)
        ?.selfAssessedLevel ??
      null;
    const ids =
      input.learningItemIds ??
      (await this.practice.queue(scope, 20)).items
        .filter((i) => i.sourceLanguageCode === input.targetLanguageCode)
        .slice(0, 10)
        .map((i) => i.id as string);
    if (!ids.length) throw new AppError(409, 'NO_ELIGIBLE_ITEMS', 'No eligible reading targets');
    const targets: ReadingTarget[] = await withTransaction(
      this.pool,
      async (tx) => {
        const rows = (
          await tx.query(
            `SELECT li.*,ARRAY(SELECT translation_text FROM product_gotit.item_translations t WHERE t.application_id=li.application_id AND t.application_user_id=li.application_user_id AND t.learning_item_id=li.id AND t.is_current ORDER BY is_primary DESC,id) translations FROM product_gotit.learning_items li WHERE application_id=$1 AND application_user_id=$2 AND id=ANY($3::uuid[]) AND source_language_code=$4 AND user_status='active' AND deleted_at IS NULL ORDER BY id`,
            [...scopeValues(scope), ids, input.targetLanguageCode],
          )
        ).rows;
        if (rows.length !== ids.length) throw itemNotFound();
        return rows.map((r) => ({
          id: r.id,
          sourceText: r.source_text,
          translationText: r.translations[0],
          translationLanguageCode: r.translation_language_code,
          partOfSpeech: r.part_of_speech,
          snapshotHash: itemSnapshot(r, r.translations),
        }));
      },
      true,
    );
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 30000);
    let generated: Awaited<ReturnType<ReadingGenerator['generate']>>;
    try {
      generated = await Promise.race([
        this.generator.generate({ ...input, topic, effectiveLevel, targets }, controller.signal),
        new Promise<never>((_resolve, reject) =>
          controller.signal.addEventListener('abort', () => reject(new Error('Reading deadline')), {
            once: true,
          }),
        ),
      ]);
    } catch {
      throw new AppError(
        503,
        'READING_UNAVAILABLE',
        'Reading generation is temporarily unavailable',
      );
    } finally {
      clearTimeout(timer);
    }
    const parsedContent = generatedReadingSchema
      .extend({ providerModel: z.string().max(200).nullable() })
      .safeParse(generated);
    if (!parsedContent.success)
      throw new AppError(503, 'READING_UNAVAILABLE', 'Reading provider returned invalid content');
    const { providerModel, ...content } = parsedContent.data;
    const bound = targets.map((target) => {
      const ranges: { start: number; end: number }[] = [],
        points = [...content.bodyText],
        needle = [...target.sourceText];
      for (let index = 0; index <= points.length - needle.length; index++)
        if (needle.every((point, i) => point === points[index + i])) {
          ranges.push({ start: index, end: index + needle.length });
          index += needle.length - 1;
        }
      if (!ranges.length)
        throw new AppError(
          503,
          'READING_UNAVAILABLE',
          'Generated passage did not include all targets',
        );
      return { ...target, occurrenceCount: ranges.length, ranges };
    });
    const ticket = ticketSchema.parse({
      version: 1,
      id: randomUUID(),
      ...scope,
      expiresAt: this.now() + 15 * 60000,
      input,
      topic,
      effectiveLevel,
      content,
      providerName: this.generator.id,
      providerModel,
      targets: bound,
    });
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from('gotit-reading-v1'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(ticket), 'utf8'),
      cipher.final(),
    ]);
    if (ciphertext.length > 95000)
      throw new AppError(
        503,
        'READING_UNAVAILABLE',
        'Generated passage exceeds the publication limit',
      );
    return {
      reading: {
        id: ticket.id,
        ...content,
        contentType: input.contentType,
        targetLanguageCode: input.targetLanguageCode,
        effectiveLevel,
        targets: bound.map(({ snapshotHash, ...target }) => target),
      },
      publicationToken: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString(
        'base64url',
      ),
      expiresAt: new Date(ticket.expiresAt),
      provider: { name: ticket.providerName, model: ticket.providerModel },
    };
  }
  private decode(scope: ProfileScope, token: string) {
    try {
      if (!this.key || !/^[A-Za-z0-9_-]+$/u.test(token)) throw new Error();
      const bytes = Buffer.from(token, 'base64url');
      if (bytes.length < 29 || bytes.length > 95028) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from('gotit-reading-v1'));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const ticket = ticketSchema.parse(
        JSON.parse(
          Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
        ),
      );
      if (
        ticket.applicationId !== scope.applicationId ||
        ticket.applicationUserId !== scope.applicationUserId ||
        ticket.expiresAt <= this.now()
      )
        throw new Error();
      return ticket;
    } catch {
      throw new AppError(409, 'PUBLICATION_INVALID', 'Reading publication expired or is invalid');
    }
  }
  async open(scope: ProfileScope, key: string, token: string) {
    const hash = fingerprint({ publicationToken: token });
    return withTransaction(this.pool, async (tx) => {
      await tx.lock(['reading-open-event', ...scopeValues(scope), key]);
      const prior = (
        await tx.query(
          'SELECT request_hash,publication_receipt FROM product_gotit.generated_contents WHERE application_id=$1 AND application_user_id=$2 AND client_request_id=$3',
          [...scopeValues(scope), key],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== hash)
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Reading event key was reused');
        const receipt = z
          .object({
            id: z.uuid(),
            title: z.string(),
            bodyText: z.string(),
            targets: z.array(z.unknown()),
          })
          .passthrough()
          .safeParse(prior.publication_receipt);
        if (!receipt.success) throw new AppError(500, 'INTERNAL_ERROR', 'Invalid reading receipt');
        return { reading: receipt.data, replayed: true };
      }
      const ticket = this.decode(scope, token);
      await tx.lock(['reading-publication', ...scopeValues(scope), ticket.id]);
      if (
        (
          await tx.query(
            'SELECT id FROM product_gotit.generated_contents WHERE application_id=$1 AND application_user_id=$2 AND id=$3',
            [...scopeValues(scope), ticket.id],
          )
        ).rowCount
      )
        throw new AppError(409, 'PUBLICATION_OPENED', 'Reading publication was already opened');
      for (const target of [...ticket.targets].sort((a, b) => a.id.localeCompare(b.id))) {
        const item = (
          await tx.query(
            "SELECT * FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL AND user_status='active' FOR SHARE",
            [...scopeValues(scope), target.id],
          )
        ).rows[0];
        if (!item) throw itemNotFound();
        const translations = (
          await tx.query(
            'SELECT translation_text FROM product_gotit.item_translations WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND is_current ORDER BY is_primary DESC,id',
            [...scopeValues(scope), target.id],
          )
        ).rows.map((r) => r.translation_text);
        if (itemSnapshot(item, translations) !== target.snapshotHash)
          throw new AppError(
            409,
            'PUBLICATION_STALE',
            'Reading target changed; generate another passage',
          );
      }
      const reading = {
        id: ticket.id,
        ...ticket.content,
        topic: ticket.topic,
        contentType: ticket.input.contentType,
        targetLanguageCode: ticket.input.targetLanguageCode,
        effectiveLevel: ticket.effectiveLevel,
        provider: { name: ticket.providerName, model: ticket.providerModel },
        openedAt: new Date(this.now()).toISOString(),
        targets: ticket.targets.map(({ snapshotHash, ...target }) => target),
      };
      await tx.query(
        `INSERT INTO product_gotit.generated_contents(id,application_id,application_user_id,content_type,topic,target_language_code,requested_level,effective_level,length_preset,title,body_text,provider_name,provider_model,generation_parameters,client_request_id,opened_at,request_hash,publication_receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          ticket.id,
          ...scopeValues(scope),
          ticket.input.contentType,
          ticket.topic,
          ticket.input.targetLanguageCode,
          ticket.input.requestedLevel ?? null,
          ticket.effectiveLevel,
          ticket.input.lengthPreset,
          ticket.content.title,
          ticket.content.bodyText,
          ticket.providerName,
          ticket.providerModel,
          JSON.stringify({ input: ticket.input, targets: reading.targets }),
          key,
          reading.openedAt,
          hash,
          JSON.stringify(reading),
        ],
      );
      for (const target of ticket.targets)
        await tx.query(
          `INSERT INTO product_gotit.generated_content_items(application_id,application_user_id,generated_content_id,learning_item_id,selection_source,occurrence_count) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            ...scopeValues(scope),
            ticket.id,
            target.id,
            ticket.input.learningItemIds ? 'user' : 'smart',
            target.occurrenceCount,
          ],
        );
      return { reading, replayed: false };
    });
  }
  async list(scope: ProfileScope, limit: number, cursor?: string) {
    return withTransaction(
      this.pool,
      async (tx) => {
        const rows = (
          await tx.query(
            'SELECT id,title,topic,target_language_code AS "targetLanguageCode",content_type AS "contentType",effective_level AS "effectiveLevel",opened_at AS "openedAt" FROM product_gotit.generated_contents WHERE application_id=$1 AND application_user_id=$2 AND deleted_at IS NULL AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4',
            [...scopeValues(scope), cursor ?? null, limit + 1],
          )
        ).rows;
        return {
          items: rows.slice(0, limit),
          nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
        };
      },
      true,
    );
  }
  async detail(scope: ProfileScope, id: string) {
    return withTransaction(
      this.pool,
      async (tx) => {
        const row = (
          await tx.query(
            'SELECT * FROM product_gotit.generated_contents WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL',
            [...scopeValues(scope), id],
          )
        ).rows[0];
        if (!row) throw missing();
        if (!row.publication_receipt) {
          const targets = (
            await tx.query(
              `SELECT m.learning_item_id AS id,i.source_text AS "sourceText",m.occurrence_count AS "occurrenceCount" FROM product_gotit.generated_content_items m JOIN product_gotit.learning_items i ON i.application_id=m.application_id AND i.application_user_id=m.application_user_id AND i.id=m.learning_item_id WHERE m.application_id=$1 AND m.application_user_id=$2 AND m.generated_content_id=$3 ORDER BY m.learning_item_id LIMIT 100`,
              [...scopeValues(scope), id],
            )
          ).rows;
          return {
            id: row.id,
            title: row.title,
            bodyText: row.body_text,
            topic: row.topic,
            contentType: row.content_type,
            targetLanguageCode: row.target_language_code,
            effectiveLevel: row.effective_level,
            provider: { name: row.provider_name, model: row.provider_model },
            openedAt: row.opened_at,
            targets,
          };
        }
        return row.publication_receipt;
      },
      true,
    );
  }
  async remove(scope: ProfileScope, id: string) {
    return withTransaction(this.pool, async (tx) => {
      if (
        !(
          await tx.query(
            'UPDATE product_gotit.generated_contents SET deleted_at=now() WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL RETURNING id',
            [...scopeValues(scope), id],
          )
        ).rowCount
      )
        throw missing();
      return { id };
    });
  }
}
