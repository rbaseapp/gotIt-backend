import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenverseImageProvider } from '../src/modules/practice/openverse-image.provider.js';

test('Openverse study images use safe licensed results and cache normalized queries', async () => {
  let calls = 0;
  let requested = '';
  const provider = new OpenverseImageProvider(
    (async (input: URL | RequestInfo) => {
      calls++;
      requested = String(input);
      return new Response(
        JSON.stringify({
          results: [
            {
              title: 'Red apple',
              thumbnail: 'https://api.openverse.org/v1/images/image-id/thumb/',
              creator: 'Photographer',
              creator_url: 'https://example.test/creator',
              license: 'by',
              license_version: '4.0',
              license_url: 'https://creativecommons.org/licenses/by/4.0/',
              foreign_landing_url: 'https://example.test/apple',
              mature: false,
            },
          ],
        }),
      );
    }) as typeof fetch,
    () => 1000,
  );

  const first = await provider.find('  Apple  ');
  const second = await provider.find('apple');

  assert.equal(calls, 1);
  assert.match(requested, /q=Apple/u);
  assert.match(requested, /license_type=commercial/u);
  assert.equal(first?.alt, 'Red apple');
  assert.equal(first?.license, 'BY 4.0');
  assert.deepEqual(second, first);
});

test('Openverse study images fail closed for untrusted thumbnails', async () => {
  const provider = new OpenverseImageProvider(
    (async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: 'Wrong host',
              thumbnail: 'https://images.example.test/file.jpg',
              foreign_landing_url: 'https://example.test/source',
            },
          ],
        }),
      )) as typeof fetch,
  );

  assert.equal(await provider.find('apple'), null);
});
