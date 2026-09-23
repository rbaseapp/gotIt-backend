import assert from 'node:assert/strict';
import test from 'node:test';
import { PixabayStudyImageProvider } from '../src/modules/practice/pixabay-study-image.provider.js';
import { FallbackStudyImageProvider } from '../src/modules/practice/study-image.provider.js';

const input = {
  sourceText: 'bank',
  translationText: 'גדה',
  sourceLanguageCode: 'en',
  translationLanguageCode: 'he',
  context: 'We sat on the bank beside the river.',
};

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

test('Pixabay searches only for the term and uses context solely to rank matching results', async () => {
  const requests: URL[] = [];
  const provider = new PixabayStudyImageProvider('pixabay-secret', (async (value) => {
    const url = new URL(String(value));
    requests.push(url);
    if (url.hostname === 'pixabay.com')
      return Response.json({
        hits: [
          {
            id: 1,
            pageURL: 'https://pixabay.com/photos/bank-money-1/',
            webformatURL: 'https://cdn.pixabay.com/photo/bank-money.jpg',
            tags: 'bank, money, finance',
            user: 'MoneyPhotographer',
            likes: 1000,
          },
          {
            id: 2,
            pageURL: 'https://pixabay.com/photos/bank-river-2/',
            webformatURL: 'https://cdn.pixabay.com/photo/bank-river.jpg',
            tags: 'bank, river, water',
            user: 'RiverPhotographer',
            likes: 3,
          },
        ],
      });
    return new Response(jpeg, {
      headers: { 'content-type': 'image/jpeg', 'content-length': String(jpeg.length) },
    });
  }) as typeof fetch);

  const image = await provider.generate(input);

  assert.equal(requests[0]?.searchParams.get('q'), 'bank');
  assert.equal(requests[0]?.searchParams.get('safesearch'), 'true');
  assert.equal(requests[0]?.searchParams.has('context'), false);
  assert.equal(requests[1]?.href, 'https://cdn.pixabay.com/photo/bank-river.jpg');
  assert.equal(image?.kind, 'stock');
  assert.equal(image?.provider, 'Pixabay');
  assert.equal(image?.creator, 'RiverPhotographer');
  assert.equal(image?.sourceUrl, 'https://pixabay.com/photos/bank-river-2/');
  assert.equal(image?.contentType, 'image/jpeg');
});

test('Pixabay rejects unrelated results and the chain falls back to AI', async () => {
  const pixabay = new PixabayStudyImageProvider('pixabay-secret', (async () =>
    Response.json({
      hits: [
        {
          id: 3,
          pageURL: 'https://pixabay.com/photos/irrelevant-3/',
          webformatURL: 'https://cdn.pixabay.com/photo/irrelevant.jpg',
          tags: 'city, building, traffic',
          user: 'Example',
          likes: 10,
        },
      ],
    })) as typeof fetch);
  let fallbackCalls = 0;
  const fallback = {
    id: 'test-ai',
    generate: async () => {
      fallbackCalls++;
      return {
        data: jpeg,
        contentType: 'image/jpeg' as const,
        kind: 'generated' as const,
        provider: 'Test AI',
        sourceUrl: null,
        creator: null,
      };
    },
  };

  const image = await new FallbackStudyImageProvider([pixabay, fallback]).generate(input);

  assert.equal(fallbackCalls, 1);
  assert.equal(image?.kind, 'generated');
  assert.match(new FallbackStudyImageProvider([pixabay, fallback]).id, /^hybrid:v1:/u);
});

test('Pixabay accepts a singular tag for a plural vocabulary term', async () => {
  let downloaded = false;
  const provider = new PixabayStudyImageProvider('pixabay-secret', (async (value) => {
    const url = new URL(String(value));
    if (url.hostname === 'pixabay.com')
      return Response.json({
        hits: [
          {
            id: 4,
            pageURL: 'https://pixabay.com/photos/fertilizer-4/',
            webformatURL: 'https://cdn.pixabay.com/photo/fertilizer.jpg',
            tags: 'fertilizer, agriculture, soil, plant',
            user: 'Gardener',
            likes: 4,
          },
        ],
      });
    downloaded = true;
    return new Response(jpeg, { headers: { 'content-length': String(jpeg.length) } });
  }) as typeof fetch);

  const image = await provider.generate({
    ...input,
    sourceText: 'fertilizers',
    translationText: 'דשנים',
    context: 'Fertilizers and ceramics are among the industrial uses.',
  });

  assert.equal(downloaded, true);
  assert.equal(image?.kind, 'stock');
});

test('Pixabay rejects a partial tag match for a multi-word term', async () => {
  let downloadCalls = 0;
  const provider = new PixabayStudyImageProvider('pixabay-secret', (async (value) => {
    const url = new URL(String(value));
    if (url.hostname === 'pixabay.com')
      return Response.json({
        hits: [
          {
            id: 5,
            pageURL: 'https://pixabay.com/photos/coffee-5/',
            webformatURL: 'https://cdn.pixabay.com/photo/coffee.jpg',
            tags: 'coffee, cup, drink',
            user: 'Barista',
            likes: 500,
          },
        ],
      });
    downloadCalls++;
    return new Response(jpeg);
  }) as typeof fetch);

  const image = await provider.generate({
    ...input,
    sourceText: 'coffee table',
    translationText: 'שולחן קפה',
    context: 'The keys are on the coffee table.',
  });

  assert.equal(image, null);
  assert.equal(downloadCalls, 0);
});
