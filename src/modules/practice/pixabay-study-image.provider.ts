import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../shared/errors/app-error.js';
import type {
  GeneratedStudyImage,
  StudyImageInput,
  StudyImageProvider,
} from './study-image.provider.js';
import { literalStudyImageBrief } from './study-image.provider.js';

const hitSchema = z.object({
  id: z.number().int().positive(),
  pageURL: z.url().max(2_000),
  webformatURL: z.url().max(2_000),
  tags: z.string().max(1_000),
  user: z.string().max(200),
  likes: z.number().int().nonnegative().default(0),
  imageType: z.enum(['photo', 'illustration', 'vector']).optional(),
});
const searchSchema = z.object({
  hits: z.array(hitSchema).max(20),
  totalHits: z.number().int().nonnegative().optional(),
});
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

const isolationTokens = new Set([
  'isolated',
  'cutout',
  'transparent',
  'object',
  'icon',
  'illustration',
  'vector',
  'white',
]);

function rank(hits: PixabayHit[], input: StudyImageInput) {
  const visual = input.visual ?? literalStudyImageBrief(input);
  const includeGroups = visual.includeTags.map((tag) => tokens(tag)).filter((group) => group.size);
  const excludedTokens = tokens(visual.excludeTags.join(' '));
  return hits
    .map((hit) => {
      const tagTokens = tokens(hit.tags);
      const matchingGroups = includeGroups.filter((group) =>
        [...group].every((token) => tagTokens.has(token)),
      );
      const subjectOverlap = matchingGroups.reduce((total, group) => total + group.size, 0);
      const excludedOverlap = [...excludedTokens].filter((token) => tagTokens.has(token)).length;
      const isolationOverlap = [...isolationTokens].filter((token) => tagTokens.has(token)).length;
      if (!subjectOverlap || excludedOverlap) return null;
      return {
        hit,
        score:
          subjectOverlap * 25 +
          isolationOverlap * 12 +
          (hit.imageType === 'vector' ? 10 : hit.imageType === 'illustration' ? 6 : 0) +
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
  readonly id = 'pixabay:v2-isolated';
  private readonly cache = new Map<
    string,
    { expiresAt: number; hits: PixabayHit[]; total: number }
  >();
  private readonly pending = new Map<string, Promise<GeneratedStudyImage | null>>();

  constructor(
    private readonly apiKey: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async generate(raw: StudyImageInput): Promise<GeneratedStudyImage | null> {
    if (raw.stockSelection) {
      const selected = this.verifySelection(raw.stockSelection, raw.scope?.applicationId);
      return selected ? this.download(selected) : null;
    }
    const input = {
      ...raw,
      sourceText: bounded(raw.sourceText, 100),
    };
    if (!input.sourceText) return null;
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          input.visual ?? literalStudyImageBrief(input),
          input.excludeSourceUrls ?? [],
        ]),
      )
      .digest('hex');
    const existing = this.pending.get(key);
    if (existing) return existing;
    const work = this.find(input).finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }

  private async find(input: StudyImageInput): Promise<GeneratedStudyImage | null> {
    const visual = input.visual ?? literalStudyImageBrief(input);
    const hits = (
      await Promise.all(visual.searchQueries.slice(0, 3).map((query) => this.search(query)))
    ).flatMap((result) => result.hits);
    const uniqueHits = [...new Map(hits.map((hit) => [hit.id, hit])).values()];
    for (const hit of rank(uniqueHits, { ...input, visual })
      .filter((hit) => !input.excludeSourceUrls?.includes(hit.pageURL))
      .slice(0, 3)) {
      const image = await this.download(hit);
      if (image) return image;
    }
    return null;
  }

  async candidates(query: string, applicationId: string, page = 1) {
    const { hits, total } = await this.search(query, page, true);
    return {
      data: hits.map((hit) => ({
        id: hit.id,
        previewUrl: hit.webformatURL,
        sourceUrl: hit.pageURL,
        creator: hit.user,
        tags: hit.tags,
        selection: this.signSelection(hit, applicationId),
      })),
      total,
    };
  }
  private signSelection(hit: PixabayHit, applicationId: string) {
    const data = Buffer.from(
      JSON.stringify({ hit, applicationId, expires: Date.now() + SEARCH_TTL_MS }),
    ).toString('base64url');
    return `${data}.${createHmac('sha256', this.apiKey)
      .update('gotit-stock-selection:' + data)
      .digest('base64url')}`;
  }
  private verifySelection(value: string, applicationId?: string): PixabayHit | null {
    try {
      const [data, signature, extra] = value.split('.');
      if (!data || !signature || extra || !applicationId) return null;
      const expected = createHmac('sha256', this.apiKey)
        .update('gotit-stock-selection:' + data)
        .digest();
      const actual = Buffer.from(signature, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
      if (
        payload.applicationId !== applicationId ||
        !Number.isFinite(payload.expires) ||
        payload.expires < Date.now()
      )
        return null;
      const hit = hitSchema.parse(payload.hit);
      return allowedPixabayUrl(hit.pageURL, true) && allowedPixabayUrl(hit.webformatURL)
        ? hit
        : null;
    } catch {
      return null;
    }
  }
  private async search(subject: string, page = 1, gallery = false) {
    const base = normalized(subject).slice(0, 80);
    const query = bounded(gallery || /\bisolated\b/u.test(base) ? base : `${base} isolated`, 100);
    if (!query) return { hits: [], total: 0 };
    const cacheKey = JSON.stringify([query, page, gallery]);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const url = new URL('https://pixabay.com/api/');
    url.search = new URLSearchParams({
      key: this.apiKey,
      q: query,
      image_type: 'all',
      safesearch: 'true',
      order: 'popular',
      ...(gallery ? {} : { colors: 'transparent' }),
      page: String(page),
      min_width: '400',
      min_height: '400',
      per_page: '20',
    }).toString();
    try {
      const response = await this.request(url, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error('Pixabay search failed');
      const body = await response.text();
      if (body.length > 250_000) throw new Error('Pixabay response too large');
      const parsed = searchSchema.safeParse(JSON.parse(body));
      if (!parsed.success) throw new Error('Invalid Pixabay response');
      const hits = parsed.data.hits.filter(
        (hit) => allowedPixabayUrl(hit.pageURL, true) && allowedPixabayUrl(hit.webformatURL, false),
      );
      if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!);
      const result = {
        expiresAt: Date.now() + SEARCH_TTL_MS,
        hits,
        total: parsed.data.totalHits ?? hits.length,
      };
      this.cache.set(cacheKey, result);
      return result;
    } catch {
      if (gallery)
        throw new AppError(
          503,
          'STOCK_SEARCH_UNAVAILABLE',
          'Pixabay search is unavailable. Please retry.',
        );
      return { hits: [], total: 0 };
    }
  }

  private async download(hit: PixabayHit): Promise<GeneratedStudyImage | null> {
    try {
      const response = await this.request(hit.webformatURL, {
        redirect: 'error',
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
