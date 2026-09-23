import { z } from 'zod';

const resultSchema = z.object({
  title: z.string().max(1000).nullable().optional(),
  thumbnail: z.string().url().max(3000),
  creator: z.string().max(1000).nullable().optional(),
  creator_url: z.string().url().max(3000).nullable().optional(),
  license: z.string().max(100).nullable().optional(),
  license_version: z.string().max(100).nullable().optional(),
  license_url: z.string().url().max(3000).nullable().optional(),
  foreign_landing_url: z.string().url().max(3000),
  mature: z.boolean().optional(),
});

const responseSchema = z.object({ results: z.array(resultSchema).max(3) });

export type StudyImage = {
  url: string;
  alt: string;
  creator: string | null;
  creatorUrl: string | null;
  license: string | null;
  licenseUrl: string | null;
  sourceUrl: string;
};

export interface StudyImageProvider {
  find(query: string): Promise<StudyImage | null>;
}

type CacheEntry = { expiresAt: number; value: StudyImage | null };

function safePublicUrl(value: string | null | undefined, requiredHost?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (requiredHost && url.hostname !== requiredHost) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export class OpenverseImageProvider implements StudyImageProvider {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async find(rawQuery: string): Promise<StudyImage | null> {
    const query = rawQuery.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, 200);
    if (!query) return null;
    const key = query.toLocaleLowerCase();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    let value: StudyImage | null = null;
    try {
      const endpoint = new URL('https://api.openverse.org/v1/images/');
      endpoint.searchParams.set('q', query);
      endpoint.searchParams.set('page_size', '3');
      endpoint.searchParams.set('mature', 'false');
      endpoint.searchParams.set('license_type', 'commercial');
      const response = await this.request(endpoint, {
        headers: { 'User-Agent': 'GotIt/0.1 (language-learning image lookup)' },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > 500_000) return null;
      const body = await response.text();
      if (body.length > 500_000) return null;
      const parsed = responseSchema.safeParse(JSON.parse(body));
      if (!parsed.success) return null;
      const result = parsed.data.results.find(
        (candidate) =>
          candidate.mature !== true &&
          safePublicUrl(candidate.thumbnail, 'api.openverse.org') &&
          safePublicUrl(candidate.foreign_landing_url),
      );
      if (result) {
        const license = [result.license?.toUpperCase(), result.license_version]
          .filter(Boolean)
          .join(' ');
        value = {
          url: safePublicUrl(result.thumbnail, 'api.openverse.org')!,
          alt: (result.title || query).slice(0, 300),
          creator: result.creator?.slice(0, 200) || null,
          creatorUrl: safePublicUrl(result.creator_url),
          license: license || null,
          licenseUrl: safePublicUrl(result.license_url),
          sourceUrl: safePublicUrl(result.foreign_landing_url)!,
        };
      }
    } catch {
      value = null;
    } finally {
      clearTimeout(timer);
    }

    if (this.cache.size >= 500) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { expiresAt: this.now() + 24 * 60 * 60 * 1000, value });
    return value;
  }
}
