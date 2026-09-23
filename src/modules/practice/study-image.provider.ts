export type StudyImageInput = {
  sourceText: string;
  translationText: string;
  sourceLanguageCode: string;
  translationLanguageCode: string;
  context: string | null;
};

export type GeneratedStudyImage = {
  data: Buffer;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  kind: 'generated' | 'stock';
  provider: string;
  sourceUrl: string | null;
  creator: string | null;
};

export interface StudyImageProvider {
  readonly id: string;
  generate(input: StudyImageInput): Promise<GeneratedStudyImage | null>;
}

export class FallbackStudyImageProvider implements StudyImageProvider {
  readonly id: string;

  constructor(private readonly providers: StudyImageProvider[]) {
    if (!providers.length) throw new Error('At least one study image provider is required');
    this.id = `hybrid:v1:${providers.map((provider) => provider.id).join('+')}`;
  }

  async generate(input: StudyImageInput) {
    for (const provider of this.providers) {
      const image = await provider.generate(input);
      if (image) return image;
    }
    return null;
  }
}
