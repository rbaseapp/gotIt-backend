import { createHash } from 'node:crypto';

export type StudyImageInput = {
  sourceText: string;
  translationText: string;
  sourceLanguageCode: string;
  translationLanguageCode: string;
  context: string | null;
  visual?: StudyImageVisualBrief;
};

export type StudyImageVisualBrief = {
  senseKey: string;
  subject: string;
  visualDescription: string;
  searchQueries: string[];
  includeTags: string[];
  excludeTags: string[];
};

export type GeneratedStudyImage = {
  data: Buffer;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  kind: 'generated' | 'stock';
  provider: string;
  sourceUrl: string | null;
  creator: string | null;
  visual?: StudyImageVisualBrief;
};

export interface StudyImageProvider {
  readonly id: string;
  generate(input: StudyImageInput): Promise<GeneratedStudyImage | null>;
}

export interface StudyImageBriefResolver {
  readonly id: string;
  resolve(input: Omit<StudyImageInput, 'visual'>): Promise<StudyImageVisualBrief | null>;
}

function bounded(value: string, length: number) {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, length);
}

export function literalStudyImageBrief(input: StudyImageInput): StudyImageVisualBrief {
  const source = bounded(input.sourceText, 100);
  const translation = bounded(input.translationText, 160);
  return {
    senseKey: `literal.${createHash('sha256')
      .update(`${source.toLocaleLowerCase()}\n${translation.toLocaleLowerCase()}`)
      .digest('hex')
      .slice(0, 24)}`,
    subject: `${source} — ${translation}`,
    visualDescription: `one isolated, immediately recognizable depiction of ${source}, specifically meaning ${translation}`,
    searchQueries: [`${source} isolated`],
    includeTags: [source],
    excludeTags: [],
  };
}

export class FallbackStudyImageProvider implements StudyImageProvider {
  readonly id: string;

  constructor(
    private readonly providers: StudyImageProvider[],
    private readonly resolver?: StudyImageBriefResolver,
  ) {
    if (!providers.length) throw new Error('At least one study image provider is required');
    const policy = [resolver?.id ?? 'literal', ...providers.map((provider) => provider.id)].join(
      '+',
    );
    this.id = `hybrid:v2-isolated:${createHash('sha256')
      .update(policy)
      .digest('hex')
      .slice(0, 24)}`;
  }

  async generate(input: StudyImageInput) {
    const visual =
      input.visual ??
      (await this.resolver?.resolve({
        sourceText: input.sourceText,
        translationText: input.translationText,
        sourceLanguageCode: input.sourceLanguageCode,
        translationLanguageCode: input.translationLanguageCode,
        context: input.context,
      })) ??
      literalStudyImageBrief(input);
    const resolved = { ...input, visual };
    for (const provider of this.providers) {
      const image = await provider.generate(resolved);
      if (image) return { ...image, visual };
    }
    return null;
  }
}
