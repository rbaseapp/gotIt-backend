import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  GeneratedStudyImage,
  StudyImageInput,
  StudyImageProvider,
} from './study-image.provider.js';

const hitSchema = z.object({
  id: z.number().int().positive(),
  pageURL: z.url().max(2_000),
  webformatURL: z.url().max(2_000),
  tags: z.string().max(1_000),
  user: z.string().max(200),
  likes: z.number().int().nonnegative().default(0),
});
const searchSchema = z.object({ hits: z.array(hitSchema).max(20) });
type PixabayHit = z.output<typeof hitSchema>;

const SEARCH_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_IMAGE_BYTES = 3_000_000;
const stopWords = new Set([
  'about',
  'after',
  'again',
  'also',
  'and',
  'are',
  'before',
  'but',
  'for',
  'from',
  'have',
  'into',
  'its',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'was',
  'were',
  'when',
  'where',
  'which',
  'with',
]);

function bounded(value: string, length: number) {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, length);
}

function normalized(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

function lexicalTokens(value: string) {
  return normalized(value)
    .split(' ')
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

function tokens(value: string) {
  const result = new Set<string>();
  for (const token of lexicalTokens(value)) {
    result.add(token);
    if (token.length > 4 && token.endsWith('ies')) result.add(`${token.slice(0, -3)}y`);
    else if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss'))
      result.add(token.slice(0, -1));
  }
  return result;
}

function rank(hits: PixabayHit[], subject: string, context: string | null) {
  const phrase = normalized(subject);
  const requiredSubjectOverlap = Math.max(1, lexicalTokens(subject).length);
  const subjectTokens = tokens(subject);
  const contextTokens = tokens(context ?? '');
  return hits
    .map((hit) => {
      const tagText = normalized(hit.tags);
      const tagTokens = tokens(hit.tags);
      const subjectOverlap = [...subjectTokens].filter((token) => tagTokens.has(token)).length;
      const exactSubject = Boolean(phrase) && ` ${tagText} `.includes(` ${phrase} `);
      if (!exactSubject && subjectOverlap < requiredSubjectOverlap) return null;
      const contextOverlap = [...contextTokens].filter((token) => tagTokens.has(token)).length;
      return {
        hit,
        score:
          (exactSubject ? 100 : 0) +
          subjectOverlap * 20 +
          Math.min(contextOverlap, 5) * 5 +
          Math.min(Math.log10(hit.likes + 1), 3) * 0.1,
      };
    })
    .filter((value): value is { hit: PixabayHit; score: number } => value !== null)
    .sort((left, right) => right.score - left.score)
    .map(({ hit }) => hit);
}

function allowedPixabayUrl(value: string, sourcePage = false) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    if (sourcePage) return url.hostname === 'pixabay.com' || url.hostname === 'www.pixabay.com';
    return url.hostname === 'pixabay.com' || url.hostname === 'cdn.pixabay.com';
  } catch {
    return false;
  }
}

function contentType(data: Buffer): GeneratedStudyImage['contentType'] | null {
  if (
    data.length >= 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return 'image/jpeg';
  return null;
}

async function boundedBody(response: Response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_IMAGE_BYTES || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_IMAGE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size,
  );
}

export class PixabayStudyImageProvider implements StudyImageProvider {
  readonly id = 'pixabay:v1';
  private readonly cache = new Map<string, { expiresAt: number; hits: PixabayHit[] }>();
  private readonly pending = new Map<string, Promise<GeneratedStudyImage | null>>();

  constructor(
    private readonly apiKey: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async generate(raw: StudyImageInput): Promise<GeneratedStudyImage | null> {
    const input = {
      ...raw,
      sourceText: bounded(raw.sourceText, 100),
      context: raw.context ? bounded(raw.context, 500) : null,
    };
    if (!input.sourceText) return null;
    const key = createHash('sha256')
      .update(JSON.stringify({ sourceText: input.sourceText, context: input.context }))
      .digest('hex');
    const existing = this.pending.get(key);
    if (existing) return existing;
    const work = this.find(input).finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }

  private async find(input: StudyImageInput): Promise<GeneratedStudyImage | null> {
    const hits = await this.search(input.sourceText);
    for (const hit of rank(hits, input.sourceText, input.context).slice(0, 3)) {
      const image = await this.download(hit);
      if (image) return image;
    }
    return null;
  }

  private async search(subject: string) {
    const query = normalized(subject).slice(0, 100);
    if (!query) return [];
    const cached = this.cache.get(query);
    if (cached && cached.expiresAt > Date.now()) return cached.hits;
    const url = new URL('https://pixabay.com/api/');
    url.search = new URLSearchParams({
      key: this.apiKey,
      q: query,
      image_type: 'all',
      orientation: 'horizontal',
      safesearch: 'true',
      order: 'popular',
      min_width: '640',
      min_height: '360',
      per_page: '10',
    }).toString();
    try {
      const response = await this.request(url, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) return [];
      const body = await response.text();
      if (body.length > 250_000) return [];
      const parsed = searchSchema.safeParse(JSON.parse(body));
      if (!parsed.success) return [];
      const hits = parsed.data.hits.filter(
        (hit) => allowedPixabayUrl(hit.pageURL, true) && allowedPixabayUrl(hit.webformatURL, false),
      );
      this.cache.set(query, { expiresAt: Date.now() + SEARCH_TTL_MS, hits });
      return hits;
    } catch {
      return [];
    }
  }

  private async download(hit: PixabayHit): Promise<GeneratedStudyImage | null> {
    try {
      const response = await this.request(hit.webformatURL, {
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok || !allowedPixabayUrl(response.url || hit.webformatURL)) return null;
      const data = await boundedBody(response);
      if (!data) return null;
      const detected = contentType(data);
      if (!detected) return null;
      return {
        data,
        contentType: detected,
        kind: 'stock',
        provider: 'Pixabay',
        sourceUrl: hit.pageURL,
        creator: hit.user || null,
      };
    } catch {
      return null;
    }
  }
}
