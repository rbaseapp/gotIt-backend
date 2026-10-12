import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import type { Pool } from 'pg';
import {
  ProgramArtworkService,
  programArtworkInput,
} from '../src/modules/courses/program-artwork.service.js';
import { CourseService } from '../src/modules/courses/course.service.js';
import { AppError } from '../src/shared/errors/app-error.js';
import {
  MemoryLearningStore,
  courseFixture,
  profiles,
  scope,
  plan,
} from './helpers/course-fixtures.js';

async function setup() {
  const store = new MemoryLearningStore();
  const course = courseFixture();
  course.versions = [
    {
      version: 1,
      preferences: course.preferences,
      plan: structuredClone(plan),
      createdAt: course.createdAt,
    },
  ];
  course.activeVersion = 1;
  store.seed(course);
  const courses = new CourseService(store, profiles);
  const cached = new Map<string, Buffer>();
  let generated = 0,
    quotaCalls = 0,
    lastPrompt = '';
  let status = 200;
  const raster = await sharp({
    create: { width: 512, height: 512, channels: 4, background: '#28735f' },
  })
    .webp()
    .toBuffer();
  const pool = {
    query: async (sql: string, args: unknown[]) => {
      const key = sql.startsWith('SELECT')
        ? `${args[0]}:${args[1]}:${args[2]}`
        : `${args[0]}:${args[1]}:${args[2]}`;
      if (sql.startsWith('SELECT'))
        return { rows: cached.has(key) ? [{ image_data: cached.get(key) }] : [] };
      cached.set(key, args[4] as Buffer);
      return { rows: [{ image_data: args[4] }] };
    },
  } as unknown as Pick<Pool, 'query'>;
  const fetcher = (async (_url: string | URL | Request, options?: RequestInit) => {
    generated++;
    lastPrompt =
      options?.body instanceof FormData
        ? String(options.body.get('prompt'))
        : JSON.parse(String(options?.body)).prompt;
    return new Response(JSON.stringify({ data: [{ b64_json: raster.toString('base64') }] }), {
      status,
    });
  }) as typeof fetch;
  const service = new ProgramArtworkService(
    pool,
    courses,
    'fixture-only',
    'fixture-model',
    {
      consume: async () => {
        quotaCalls++;
      },
    },
    fetcher,
  );
  return {
    service,
    course,
    store,
    cached,
    calls: () => ({ generated, quotaCalls, lastPrompt }),
    fail: () => {
      status = 503;
    },
  };
}

test('artwork cache lookup never generates; generation is coalesced and durable across service requests', async () => {
  const { service, course, calls } = await setup();
  const input = { kind: 'course' as const, courseId: course.id };
  assert.equal((await service.artwork(scope, input, false)).image, null);
  assert.equal(calls().generated, 0);
  const results = await Promise.all([
    service.artwork(scope, input, true),
    service.artwork(scope, input, true),
  ]);
  assert.equal(calls().generated, 1);
  assert.equal(calls().quotaCalls, 1);
  assert.match(results[0].image!.dataUrl, /^data:image\/webp;base64,/u);
  assert.equal(results[0].image!.fingerprint, results[1].image!.fingerprint);
  assert.equal(
    (await service.artwork(scope, input, false)).image!.fingerprint,
    results[0].image!.fingerprint,
  );
});

test('course artwork enforces ownership before provider/cache work, and input cannot supply a prompt', async () => {
  const { service, course, calls } = await setup();
  await assert.rejects(
    service.artwork(
      { ...scope, applicationUserId: 'foreign' },
      { kind: 'course', courseId: course.id },
      true,
    ),
    (e: unknown) => e instanceof AppError && e.statusCode === 404,
  );
  assert.equal(calls().generated, 0);
  assert.equal(
    programArtworkInput.safeParse({ kind: 'course', courseId: course.id, prompt: 'override' })
      .success,
    false,
  );
  assert.equal(
    programArtworkInput.safeParse({ kind: 'mascot', languageCode: '<script>' }).success,
    false,
  );
});

test('content changes invalidate art but learning evidence does not; cache metadata contains no raw goal', async () => {
  const { service, course, store, cached } = await setup();
  const input = { kind: 'course' as const, courseId: course.id };
  const first = await service.artwork(scope, input, true);
  course.revision++;
  store.seed(course);
  assert.equal(
    (await service.artwork(scope, input, false)).image!.fingerprint,
    first.image!.fingerprint,
  );
  course.versions[0]!.plan.title = 'Travel in Spain';
  store.seed(course);
  assert.equal((await service.artwork(scope, input, false)).image, null);
  assert.ok([...cached.keys()].every((key) => !key.includes('Travel') && !key.includes(course.id)));
});

test('provider failures are explicit, never fabricate images, and permit a later retry', async () => {
  const { service, course, calls, fail } = await setup();
  fail();
  await assert.rejects(
    service.artwork(scope, { kind: 'course', courseId: course.id }, true),
    (e: unknown) => e instanceof AppError && e.code === 'PROGRAM_ARTWORK_UNAVAILABLE',
  );
  assert.equal(
    (await service.artwork(scope, { kind: 'course', courseId: course.id }, false)).image,
    null,
  );
  assert.equal(calls().generated, 1);
});

test('mascot uses the canonical raster and actual language, with separate language caches', async () => {
  const { service, calls } = await setup();
  const spanish = await service.artwork(scope, { kind: 'mascot', languageCode: 'es' }, true);
  assert.ok(calls().lastPrompt.includes('"targetLanguage":"es"'));
  assert.match(calls().lastPrompt, /flag/u);
  const arabic = await service.artwork(scope, { kind: 'mascot', languageCode: 'ar' }, true);
  assert.ok(calls().lastPrompt.includes('"flagCountryCode":"PS"'));
  assert.notEqual(spanish.image!.fingerprint, arabic.image!.fingerprint);
  await service.artwork(scope, { kind: 'mascot', languageCode: 'en' }, true);
  assert.ok(calls().lastPrompt.includes('"flagCountryCode":"GB"'));
  assert.ok(!calls().lastPrompt.includes('Palestinian'));
  await service.artwork(scope, { kind: 'mascot', languageCode: 'en-US' }, true);
  assert.ok(calls().lastPrompt.includes('"flagCountryCode":"US"'));
  assert.equal(calls().generated, 4);
});
