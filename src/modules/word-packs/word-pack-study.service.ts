import type { Pool } from 'pg';
import type { ProfileScope } from '../profile/profile.types.js';
import type { WordPackRepository } from './word-packs.repository.js';
import type {
  StudyImageInput,
  StudyImageProvider,
  GeneratedStudyImage,
} from '../practice/study-image.provider.js';
import { literalStudyImageBrief } from '../practice/study-image.provider.js';
import { AppError } from '../../shared/errors/app-error.js';
import { validWordExample, type WordPackExampleProvider } from './word-pack-example.provider.js';

const pronounSubjects: Record<string, string> = {
  i: 'one person pointing to their own chest to identify themselves as the speaker',
  you: 'one friendly person pointing toward the viewer they are addressing',
  he: 'one man standing alone, the male person being referred to',
  she: 'one woman standing alone, the female person being referred to',
  it: 'one hand pointing to a single small object being referred to',
  we: 'two people together, one indicating themselves and their companion as a group',
  they: 'two people together, the other people being referred to',
};

function imageDto(image: GeneratedStudyImage, source: string) {
  if (
    !Buffer.isBuffer(image.data) ||
    !image.data.length ||
    image.data.length > 3_000_000 ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(image.contentType) ||
    !['generated', 'stock'].includes(image.kind) ||
    !image.provider ||
    (image.kind === 'stock' && !/^https:\/\//iu.test(image.sourceUrl ?? ''))
  )
    return null;
  return {
    url: `data:${image.contentType};base64,${image.data.toString('base64')}`,
    alt: source,
    generated: image.kind === 'generated',
    provider: image.provider,
    sourceUrl: image.sourceUrl,
    creator: image.creator,
  };
}

/** Catalog-only study must never install words, start sessions, or award progress. */
export class WordPackStudyService {
  private readonly examples = new Map<string, { value: string; expires: number }>();
  private readonly pendingExamples = new Map<string, Promise<string | null>>();
  private readonly pendingImages = new Map<string, Promise<ReturnType<typeof imageDto>>>();
  constructor(
    private readonly pool: Pool,
    private readonly packs: WordPackRepository,
    private readonly images?: StudyImageProvider,
    private readonly exampleProvider?: WordPackExampleProvider,
  ) {}

  private async input(
    scope: ProfileScope,
    packId: string,
    entryId: string,
  ): Promise<StudyImageInput> {
    const { pack, entries } = await this.packs.detail(scope, packId);
    const entry = entries.find((entry) => entry.id === entryId);
    if (!entry) throw new AppError(404, 'NOT_FOUND', 'Word pack entry not found');
    const pronoun = entry.sourceText.toLowerCase();
    const subject =
      pack.track.sourceLanguageCode === 'en' && entry.partOfSpeech === 'pronoun'
        ? pronounSubjects[pronoun]
        : undefined;
    return {
      sourceText: entry.sourceText,
      translationText: entry.translationText,
      sourceLanguageCode: pack.track.sourceLanguageCode,
      translationLanguageCode: pack.track.translationLanguageCode,
      context: entry.exampleText,
      scope,
      ...(subject
        ? {
            visual: {
              senseKey: `unit-pronoun-v1.${pronoun}`,
              subject,
              visualDescription: subject,
              searchQueries: [],
              includeTags: [],
              excludeTags: ['letters', 'numerals', 'seal', 'certificate', 'typography'],
            },
          }
        : {}),
    };
  }

  private key(input: StudyImageInput) {
    return JSON.stringify([
      input.sourceLanguageCode,
      input.sourceText,
      input.translationLanguageCode,
      input.translationText,
    ]);
  }

  async example(scope: ProfileScope, packId: string, entryId: string) {
    const input = await this.input(scope, packId, entryId);
    if (input.context) return { exampleText: input.context, generated: false };
    const key = this.key(input);
    const cached = this.examples.get(key);
    if (cached && cached.expires > Date.now())
      return { exampleText: cached.value, generated: true };
    if (!this.exampleProvider) return { exampleText: null, generated: false };
    let work = this.pendingExamples.get(key);
    if (!work) {
      work = this.exampleProvider
        .generate(input)
        .then((value) => {
          const example = validWordExample(value, input.sourceText);
          if (example) {
            if (this.examples.size >= 1000)
              this.examples.delete(this.examples.keys().next().value!);
            this.examples.set(key, { value: example, expires: Date.now() + 86_400_000 });
          }
          return example;
        })
        .finally(() => this.pendingExamples.delete(key));
      this.pendingExamples.set(key, work);
    }
    return { exampleText: await work, generated: true };
  }

  async image(scope: ProfileScope, packId: string, entryId: string) {
    const input = await this.input(scope, packId, entryId);
    const cached = input.visual ? { image: null } : await this.packs.image(scope, packId, entryId);
    if (cached.image || !this.images) return cached;
    const key = this.key(input);
    let work = this.pendingImages.get(key);
    if (!work) {
      work = this.imageOnce(input).finally(() => this.pendingImages.delete(key));
      this.pendingImages.set(key, work);
    }
    return { image: await work };
  }

  private async imageOnce(input: StudyImageInput) {
    const keys = [
      input.sourceLanguageCode,
      input.sourceText.normalize('NFKC').trim().toLowerCase(),
      input.translationLanguageCode,
      input.translationText.normalize('NFC'),
      this.images!.id + (input.visual ? ':unit-pronouns-v1' : ''),
    ];
    const cached = (
      await this.pool.query(
        `SELECT image_data,image_content_type,image_kind,image_provider,image_source_url,image_creator
      FROM product_gotit.study_image_assets WHERE source_language_code=$1 AND normalized_source_text=$2
      AND translation_language_code=$3 AND normalized_translation_text=$4 AND image_model=$5`,
        keys,
      )
    ).rows[0];
    if (cached) {
      const dto = imageDto(
        {
          data: cached.image_data,
          contentType: cached.image_content_type,
          kind: cached.image_kind,
          provider: cached.image_provider,
          sourceUrl: cached.image_source_url,
          creator: cached.image_creator,
        },
        input.sourceText,
      );
      if (dto) return dto;
    }
    const image = await this.images!.generate(input);
    if (!image || !imageDto(image, input.sourceText)) return null;
    const visual = image.visual ?? literalStudyImageBrief(input);
    await this.pool.query(
      `INSERT INTO product_gotit.study_image_assets
      (source_language_code,normalized_source_text,translation_language_code,normalized_translation_text,image_model,
      sense_key,visual_brief,image_data,image_content_type,image_kind,image_provider,image_source_url,image_creator)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(source_language_code,normalized_source_text,translation_language_code,normalized_translation_text,image_model)
      DO NOTHING`,
      [
        ...keys,
        visual.senseKey,
        visual,
        image.data,
        image.contentType,
        image.kind,
        image.provider,
        image.sourceUrl,
        image.creator,
      ],
    );
    return imageDto(image, input.sourceText);
  }
}
