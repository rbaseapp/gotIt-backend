import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';
import pg from 'pg';
import { CurriculumStore } from '../src/modules/curriculum/curriculum.store.js';
import { CurriculumService } from '../src/modules/curriculum/curriculum.service.js';
import { OpenAiCourseGenerator } from '../src/modules/courses/course.provider.js';
import { ProfileRepository } from '../src/modules/profile/profile.repository.js';
import { ProfileService } from '../src/modules/profile/profile.service.js';
import { PrivateLessonService } from '../src/modules/private-lessons/private-lesson.service.js';
import { PostgresPrivateLessonJournal } from '../src/modules/private-lessons/private-lesson.repository.js';
import { lexicon } from '../src/modules/curriculum/curriculum.content.js';

// Explicit paid-provider acceptance with synthetic learner data and a disposable local DB.
// No production/DEV database writes and no microphone capture are performed by this script.
if (!process.argv.includes('--dev-provider-acceptance'))
  throw Error('Explicit provider acceptance flag required');
const configPath = process.env.GOTIT_C1_DEV_ENV_FILE,
  metadataPath = process.env.GOTIT_C1_REHEARSAL_METADATA;
if (!configPath || !metadataPath)
  throw Error('Explicit DEV config and local rehearsal metadata paths required');
const config = parse(readFileSync(configPath));
const identity = new URL(config.DATABASE_URL!);
if (
  identity.hostname !== 'dpg-dar6fkp7lnhs73a7mspg-a.frankfurt-postgres.render.com' ||
  identity.pathname !== '/gotit_dev'
)
  throw Error('DEV configuration identity mismatch');
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
  port: string;
  container: string;
};
if (
  metadata.container !== 'gotit-english-c1-rehearsal-20261021' ||
  !/^\d{2,5}$/u.test(metadata.port)
)
  throw Error('Local rehearsal metadata mismatch');
const apiKey = config.OPENAI_API_KEY ?? config.OPENAI_REALTIME_API_KEY;
if (!apiKey) throw Error('DEV text provider is not configured');
const pool = new pg.Pool({
  connectionString: `postgresql://postgres@127.0.0.1:${metadata.port}/gotit_dev`,
});
const model = config.OPENAI_PRIVATE_LESSON_MODEL ?? 'gpt-6-sol';
const transcriptionModel = config.OPENAI_REALTIME_TRANSCRIPTION_MODEL ?? 'gpt-4o-mini-transcribe';
const diagnosticFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: { code?: string; param?: string; type?: string } } | null;
    console.log(
      JSON.stringify({
        providerErrorCode: body?.error?.code,
        providerParameter: body?.error?.param,
        providerType: body?.error?.type,
      }),
    );
  }
  return response;
};
const generator = new OpenAiCourseGenerator(
  apiKey,
  model,
  transcriptionModel,
  diagnosticFetch,
  undefined,
  {
    logger: {
      warn: (fields: unknown) => {
        console.log(JSON.stringify(fields));
      },
    },
  },
);
const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
try {
  await pool.query(
    "INSERT INTO core.applications(id,key,name) VALUES($1,$2,'Synthetic curriculum provider acceptance')",
    [scope.applicationId, randomUUID()],
  );
  await pool.query(
    "INSERT INTO core.application_users(application_id,id,email,role,email_verified_at) VALUES($1,$2,$3,'user',now())",
    [scope.applicationId, scope.applicationUserId, `${randomUUID()}@example.test`],
  );
  await pool.query(
    "UPDATE product_gotit.structured_program_versions SET visible=true WHERE program_id='english-zero-c1'",
  );
  const profiles = new ProfileService(new ProfileRepository(pool)),
    store = new CurriculumStore(pool);
  const service = new CurriculumService(store, profiles, generator, {
    apiKey,
    fetchImpl: fetch,
    consume: async () => {},
  });
  await service.enroll(scope, { eventId: randomUUID(), minutes: 10, literacy: 'starting' });
  await service.expose(scope, {
    eventId: randomUUID(),
    revision: (await service.get(scope)).revision,
    targetIds: lexicon.targets
      .filter((target) => target.unit === 'P01')
      .slice(0, 6)
      .map((target) => target.id),
  });
  const teacher = await service.teacherTurn(scope, {
    eventId: randomUUID(),
    revision: (await service.get(scope)).revision,
    lessonId: 'P01-L1',
    answer: 'אני רוצה ללמוד לברך באנגלית. אפשר להתחיל בצעד קטן?',
  });
  assert.ok(teacher.feedback.length > 0);
  console.log('Authored text-teacher provider schema accepted');
  await pool.query(
    "UPDATE product_gotit.structured_program_enrollments SET state=jsonb_set(state,'{activeSeconds}','1800'::jsonb),revision=revision+1 WHERE application_id=$1 AND application_user_id=$2",
    [scope.applicationId, scope.applicationUserId],
  );
  const reading = await service.generateArticle(scope, {
    eventId: randomUUID(),
    revision: (await service.get(scope)).revision,
  });
  assert.equal(reading.status, 'ready');
  assert.ok(reading.attempt?.question?.hasAudio);
  console.log('Dose-gated reading and editorial review accepted');
  const pronunciation = await service.teachingAudio(scope, {
    kind: 'phonics',
    id: 'F01',
    index: 0,
  });
  assert.ok(pronunciation.audioBase64.length > 100);
  const audio = await service.teachingAudio(scope, { kind: 'target', id: 'P01-T01', index: 0 });
  const output = process.env.GOTIT_C1_ACCEPTANCE_OUTPUT;
  if (!output) throw Error('Output folder required');
  const mp3 = `${output}/synthetic-hello.mp3`,
    wav = `${output}/synthetic-hello.wav`;
  writeFileSync(mp3, Buffer.from(audio.audioBase64, 'base64'));
  writeFileSync(
    `${output}/synthetic-s-phoneme.mp3`,
    Buffer.from(pronunciation.audioBase64, 'base64'),
  );
  const converted = spawnSync(
    'C:/ffmpeg-8.0-essentials_build/bin/ffmpeg.exe',
    ['-y', '-i', mp3, '-ar', '16000', '-ac', '1', '-acodec', 'pcm_s16le', wav],
    { encoding: 'utf8', timeout: 30000 },
  );
  if (converted.status !== 0) throw Error('Synthetic audio conversion failed');
  const attempt = await service.start(scope, {
    eventId: randomUUID(),
    revision: (await service.get(scope)).revision,
    activityId: 'words:P01:recognition',
  });
  const transcribed = await service.transcribe(
    scope,
    attempt.id,
    0,
    readFileSync(wav).toString('base64'),
  );
  assert.ok(/hello/iu.test(transcribed.text));
  console.log('Synthetic word audio and owner-bound transcription accepted');
  const voice = new PrivateLessonService({
    curriculum: service,
    profiles,
    vocabulary: { learned: async () => ({ items: [] }) },
    apiKey: config.OPENAI_REALTIME_API_KEY ?? apiKey,
    model: config.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2.1',
    voice: config.OPENAI_REALTIME_VOICE ?? 'marin',
    transcriptionModel,
    journal: new PostgresPrivateLessonJournal(pool),
    lessonContentGenerator: generator,
    requestTimeoutMs: 30000,
  });
  const session = await voice.createSession(scope, {
    curriculumLessonId: 'P01-L1',
    targetLanguageCode: 'en',
    supportLanguageCode: 'he',
    requestedDurationMinutes: 5,
  });
  assert.ok(session.realtime.clientSecret.length > 0);
  assert.equal(session.lesson.curriculum?.lessonId, 'P01-L1');
  const result = {
    at: new Date().toISOString(),
    syntheticDataOnly: true,
    database: 'loopback-rehearsal',
    model,
    textTeacher: true,
    reading: true,
    editorialReview: true,
    audio: true,
    transcription: true,
    realtimeSessionCreation: true,
    microphoneConversationVerified: false,
    phonemeExpertListeningReview: false,
    readingWordCount: reading.text!.split(/\s+/u).length,
  };
  writeFileSync(`${output}/provider-acceptance.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(
    error instanceof Error ? `${error.name}: ${error.message}` : 'Provider acceptance failed',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
