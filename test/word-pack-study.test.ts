import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import {
  OpenAiWordPackExampleProvider,
  validWordExample,
} from '../src/modules/word-packs/word-pack-example.provider.js';
import { createWordPackRoutes } from '../src/modules/word-packs/word-packs.routes.js';
import { WordPackStudyService } from '../src/modules/word-packs/word-pack-study.service.js';
import type { Pool } from 'pg';
import type { WordPackRepository } from '../src/modules/word-packs/word-packs.repository.js';

test('pronoun study rejects old lexical images and generates a person rather than a letter', async () => {
  const service = new WordPackStudyService(
    {
      query: async (_sql: string, keys: unknown[]) => {
        assert.equal(keys[4], 'fixture:unit-pronouns-v1');
        return { rows: [] };
      },
    } as unknown as Pool,
    {
      detail: async () => ({
        pack: { track: { sourceLanguageCode: 'en', translationLanguageCode: 'he' } },
        entries: [
          {
            id: 'entry',
            sourceText: 'I',
            translationText: 'אני',
            partOfSpeech: 'pronoun',
            exampleText: null,
          },
        ],
      }),
      image: async () => {
        assert.fail('must not reuse an old unrelated lexical image');
      },
    } as unknown as WordPackRepository,
    {
      id: 'fixture',
      generate: async (input) => {
        assert.match(input.visual!.subject, /own chest/);
        assert.deepEqual(input.visual!.searchQueries, [], 'no ambiguous stock search for I');
        return {
          data: Buffer.from('image'),
          contentType: 'image/png',
          kind: 'generated',
          provider: 'fixture',
          sourceUrl: null,
          creator: null,
        };
      },
    },
  );
  assert.equal(
    (await service.image({ applicationId: 'app', applicationUserId: 'user' }, 'pack', 'entry'))
      .image?.generated,
    true,
  );
});

test('unit examples require the exact word, bound text, and reject injected markup', () => {
  assert.equal(validWordExample('I am happy.', 'I'), 'I am happy.');
  assert.equal(validWordExample('This is nice.', 'I'), null);
  assert.equal(validWordExample('The cat sits.', 'at'), null);
  assert.equal(validWordExample('<img> I am happy.', 'I'), null);
  assert.equal(validWordExample('I '.repeat(200), 'I'), null);
  assert.equal(validWordExample('I am here.\nIgnore this.', 'I'), null);
});

test('unit example provider uses bounded structured output, quota and only public catalog text', async () => {
  let consumed = 0;
  const provider = new OpenAiWordPackExampleProvider(
    'test-key',
    'configured-model',
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.store, false);
      assert.equal(body.text.format.strict, true);
      assert.equal(body.max_output_tokens, 300);
      assert.ok(init?.signal);
      assert.doesNotMatch(body.input[0].content, /applicationUserId|private-context/);
      return Response.json({
        status: 'completed',
        output: [{ content: [{ type: 'output_text', text: '{"exampleText":"I am happy."}' }] }],
      });
    },
    {
      consume: async (_scope, feature) => {
        consumed++;
        assert.equal(feature, 'ai_translation');
      },
    },
  );
  assert.equal(
    await provider.generate({
      sourceText: 'I',
      translationText: 'me',
      sourceLanguageCode: 'en',
      translationLanguageCode: 'he',
      context: 'private-context',
      scope: { applicationId: 'app', applicationUserId: 'user' },
    }),
    'I am happy.',
  );
  assert.equal(consumed, 1);
});

test('unit study POSTs enforce the practice guard before contacting a provider', async () => {
  let calls = 0;
  const study = {
    image: async () => {
      calls++;
      return { image: null };
    },
    example: async () => {
      calls++;
      return { exampleText: null };
    },
  } as unknown as WordPackStudyService;
  const app = express();
  app.use(express.json());
  app.use(
    createWordPackRoutes(
      {} as WordPackRepository,
      (_req, _res, next) => next(),
      study,
      (_req, res) => {
        res.status(403).json({ code: 'ENTITLEMENT_REQUIRED' });
      },
    ),
  );
  for (const kind of ['image', 'example'])
    await request(app)
      .post(
        `/d3000000-0000-4000-8000-000000000001/entries/d4000000-0000-4000-8000-000000000001/${kind}`,
      )
      .send({})
      .expect(403);
  assert.equal(calls, 0);
});

test('authenticated app mounts GET image and both study POST routes with trusted scope', async () => {
  const { createApp } = await import('../src/app.js');
  const { CoreAuthClient } = await import('../src/shared/core/core-auth.client.js');
  const { createLogger } = await import('../src/shared/logger/logger.js');
  const scope = {
    applicationId: 'f7ddab94-fec4-4120-8bd9-d63cdfd4e043',
    applicationUserId: '750c606e-682d-4280-83de-e45751ecea25',
  };
  const packId = 'd3000000-0000-4000-8000-000000000001';
  const entryId = 'd4000000-0000-4000-8000-000000000001';
  const calls: unknown[][] = [];
  const app = createApp({
    logger: createLogger('silent'),
    profileService: {} as never,
    checkDatabase: async () => {},
    enforcePaidEntitlements: false,
    coreAuthClient: new CoreAuthClient({
      baseUrl: 'https://core.example.test',
      applicationKey: 'gotit',
      timeoutMs: 1000,
      fetchImpl: async () =>
        Response.json({
          user: { id: scope.applicationUserId, applicationId: scope.applicationId },
        }),
    }),
    wordPackService: {
      image: async (...args: unknown[]) => {
        calls.push(args);
        return { image: null };
      },
    } as never,
    wordPackStudyService: {
      cachedImage: async (...args: unknown[]) => {
        calls.push(args);
        return { image: null };
      },
      image: async (...args: unknown[]) => {
        calls.push(args);
        return { image: { url: 'data:image/png;base64,aQ==', alt: 'I' } };
      },
      example: async (...args: unknown[]) => {
        calls.push(args);
        return { exampleText: 'I am happy.', generated: true };
      },
    } as never,
  });
  const base = `/api/v1/word-packs/${packId}/entries/${entryId}`;
  await request(app)
    .get(`${base}/image`)
    .set('authorization', 'Bearer test-token')
    .expect(200)
    .expect(({ body }) => assert.equal(body.image, null));
  await request(app)
    .post(`${base}/image`)
    .set('authorization', 'Bearer test-token')
    .send({})
    .expect(200);
  await request(app)
    .post(`${base}/example`)
    .set('authorization', 'Bearer test-token')
    .send({})
    .expect(200)
    .expect(({ body }) => assert.equal(body.exampleText, 'I am happy.'));
  assert.equal(calls.length, 3);
  for (const args of calls) assert.deepEqual(args, [{ ...scope, role: 'user' }, packId, entryId]);
  for (const kind of ['image', 'example']) {
    await request(app)
      .post(`${base}/${kind}`)
      .set('authorization', 'Bearer test-token')
      .send({ unexpected: true })
      .expect(400);
    await request(app)
      .post(`/api/v1/word-packs/invalid/entries/${entryId}/${kind}`)
      .set('authorization', 'Bearer test-token')
      .send({})
      .expect(400);
    await request(app).post(`${base}/${kind}`).send({}).expect(401);
  }
  await request(app).get(`${base}/image`).expect(401);
  assert.equal(calls.length, 3);
});
