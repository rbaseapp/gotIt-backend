/** Explicit, bounded provider acceptance using synthetic content only. No database. */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  AdaptiveLessonPlanner,
  adaptivePlanDigest,
  lessonPlanningRequirements,
  adaptivePlanIssues,
} from '../src/modules/private-lessons/private-lesson.planner.js';
import { OpenAiCourseGenerator } from '../src/modules/courses/course.provider.js';
import type { PrivateLessonPlan } from '../src/modules/private-lessons/private-lesson.prompt.js';
import { teacherStations } from '../src/modules/word-packs/teacher-stations.js';

if (process.env.GOTIT_CHECK_ADAPTIVE_PROVIDER !== '1') {
  throw new Error(
    'Set GOTIT_CHECK_ADAPTIVE_PROVIDER=1 to authorize this bounded paid provider check. It uses synthetic data and never accesses a database.',
  );
}
const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPENAI_REALTIME_API_KEY;
if (!apiKey) throw new Error('No configured provider credential is available');
const durationSeconds = Number(process.env.GOTIT_CHECK_ADAPTIVE_SECONDS ?? 600);
if (!Number.isInteger(durationSeconds) || durationSeconds < 60 || durationSeconds > 1200)
  throw new Error('Choose 60-1200 seconds');
const plan: PrivateLessonPlan = {
  id: randomUUID(),
  interactionProtocol: 'adaptive-v1',
  durationSeconds,
  targetLanguageCode: 'en',
  supportLanguageCode: 'he',
  lessonMode: 'absolute_beginner',
  teachingLanguage: 'support',
  level: 'A1',
  topic: 'Requesting a drink politely',
  grammarFocus: null,
  focusAreas: ['speaking', 'vocabulary'],
  customFocus: null,
  correctionMode: 'recast',
  vocabularyMode: 'none',
  teacherVoice: 'female',
  speechRate: 'slow',
  interests: [],
  targets: [],
  continuity: null,
  wordPack: {
    packId: randomUUID(),
    title: 'Requesting a drink politely',
    moduleNumber: 1,
    targetLanguageCode: 'en',
    supportLanguageCode: 'he',
    level: 'A1',
    station: 'supported',
    introduced: 10,
    completed: 10,
    total: 10,
    teacherStations: teacherStations(10, 10),
    words: [
      ['hello', 'שלום'],
      ['please', 'בבקשה'],
      ['thank you', 'תודה'],
      ['yes', 'כן'],
      ['no', 'לא'],
      ['water', 'מים'],
      ['coffee', 'קפה'],
      ['tea', 'תה'],
      ['milk', 'חלב'],
      ['bread', 'לחם'],
    ].map(([sourceText, translationText]) => ({
      sourceText: sourceText!,
      translationText: translationText!,
      introduced: true,
      exampleText: null,
      learningItemId: null,
    })),
  },
};
const lessonId = process.env.GOTIT_CHECK_ADAPTIVE_LESSON_ID;
if (lessonId) {
  const data = JSON.parse(
    await readFile(new URL('../assets/english-zero-c1/curriculum.json', import.meta.url), 'utf8'),
  );
  const lesson = data.lessons.find((value: { id: string }) => value.id === lessonId);
  if (!lesson) throw new Error('Choose an existing authored lesson');
  const unit = data.units.find((value: { id: string }) => value.id === lesson.unit);
  plan.wordPack = null;
  plan.topic = lesson.title_he;
  plan.grammarFocus = unit.grammar_he;
  plan.level = lesson.band === 'Pre-A1' ? 'A1' : lesson.band;
  plan.lessonMode = ['Pre-A1', 'A1'].includes(lesson.band) ? 'absolute_beginner' : 'standard';
  plan.curriculum = {
    lessonId,
    version: 'provider-check',
    cursor: 0,
    title: lesson.title_he,
    script: lesson.teacher_script,
    branches: lesson.branches,
  };
}
const started = Date.now();
const model = process.env.OPENAI_PRIVATE_LESSON_MODEL ?? 'gpt-6-sol';
const generator = new OpenAiCourseGenerator(
  apiKey,
  model,
  process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL ?? 'gpt-4o-mini-transcribe',
  fetch,
  undefined,
  { logger: { warn: (fields) => console.error(JSON.stringify(fields)) } },
);
try {
  const checkedGenerator = {
    async generate<T>(...args: Parameters<typeof generator.generate<T>>) {
      const startedAt = Date.now();
      const result = await generator.generate<T>(...args);
      console.error(
        JSON.stringify({
          operation: args[2],
          elapsedMs: Date.now() - startedAt,
          ...(args[2] === 'private_lesson_plan'
            ? {
                issues: adaptivePlanIssues(
                  plan,
                  result as import('../src/modules/private-lessons/private-lesson.planner.js').AdaptivePlan,
                ),
              }
            : {}),
          ...(args[2] === 'private_lesson_plan_review' ? { review: result } : {}),
        }),
      );
      return result;
    },
  };
  const curriculum = await new AdaptiveLessonPlanner(checkedGenerator).prepare(
    { applicationId: randomUUID(), applicationUserId: randomUUID() },
    plan,
    'guided',
  );
  console.log(
    JSON.stringify({
      status: 'passed',
      synthetic: true,
      lessonId: lessonId ?? null,
      model,
      elapsedMs: Date.now() - started,
      durationSeconds,
      planDigest: adaptivePlanDigest(curriculum),
      requirements: lessonPlanningRequirements(plan),
      activities: curriculum.activities.length,
      kinds: [...new Set(curriculum.activities.map((item) => item.kind))],
      routes: Object.fromEntries(
        ['core', 'support', 'extension'].map((route) => [
          route,
          curriculum.activities.filter((item) => item.route === route).length,
        ]),
      ),
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      synthetic: true,
      model,
      elapsedMs: Date.now() - started,
      code: error && typeof error === 'object' && 'code' in error ? error.code : 'CHECK_FAILED',
    }),
  );
  process.exitCode = 1;
}
