import test from 'node:test';
import assert from 'node:assert/strict';
import { unitContentSchema } from '../src/modules/admin/admin.unit-content.js';
import { currentWordStage, teacherStations } from '../src/modules/word-packs/teacher-stations.js';
import { buildUnitLearningPath } from '../src/modules/word-packs/unit-learning-path.js';
import { unitFixture } from './helpers/unit-path-fixtures.js';
import { unitHistoryFixture } from './helpers/unit-path-fixtures.js';
import { profiles, scope } from './helpers/course-fixtures.js';
import { PrivateLessonService } from '../src/modules/private-lessons/private-lesson.service.js';
import { privateLessonInputSchema } from '../src/modules/private-lessons/private-lesson.validation.js';

const entries = Array.from({ length: 50 }, (_, i) => ({
  id: crypto.randomUUID(),
  sourceText: `word${i}`,
  translationText: `meaning${i}`,
  exampleText: null,
}));
const settings = {
  supported: { requiredWords: 8, durationMinutes: 7 },
  midpoint: { requiredWords: 30, durationMinutes: 9 },
  review: { requiredWords: 50, durationMinutes: 12 },
};

test('authored nonstandard duration reaches the actual session and provider contract', async () => {
  const unit = unitFixture(8);
  unit.teacherStations = teacherStations(50, 8, settings);
  const history = unitHistoryFixture([]);
  let instructions = '';
  const service = new PrivateLessonService({
    apiKey: 'fixture',
    model: 'fixture',
    voice: 'marin',
    transcriptionModel: 'fixture',
    profiles,
    vocabulary: { learned: async () => ({ items: [] }) },
    mapWordPacks: { lessonUnit: async () => structuredClone(unit) },
    wordPacks: {
      context: async (_scope, _id, station) => ({
        context: { ...structuredClone(unit), station },
        targets: [],
      }),
    },
    journal: history.journal,
    courses: history.courses,
    fetchImpl: async (_url, init) => {
      instructions = JSON.parse(String(init?.body)).session.instructions;
      return Response.json({ value: 'fixture-only' });
    },
  });
  const result = await service.createSession(
    scope,
    privateLessonInputSchema.parse({
      packId: unit.packId,
      targetLanguageCode: 'en',
      station: 'supported',
    }),
  );
  assert.equal(result.lesson.durationSeconds, 420);
  assert.match(instructions, /"durationSeconds": 420/);
});

test('authored thresholds drive actual word batches and station availability while preserving prerequisites', () => {
  assert.deepEqual(currentWordStage(50, 8, settings), { start: 8, end: 30 });
  const stations = teacherStations(50, 8, settings);
  assert.equal(stations[0]!.durationMinutes, 7);
  assert.equal(stations[0]!.available, true);
  assert.equal(stations[1]!.available, false);
  const unit = unitFixture(50);
  unit.teacherStations = teacherStations(50, 50, settings);
  const path = buildUnitLearningPath(unit, [], []);
  assert.equal(path.stations[0]!.available, true);
  assert.equal(path.stations[1]!.available, false);
  assert.equal(path.stations[1]!.lockReason, 'previous_preparation');
});

test('station authoring rejects reversed thresholds, incomplete final scope, invalid duration and client authority', () => {
  const content = { title: 'Unit', entries, materials: {}, stationSettings: settings };
  assert.equal(unitContentSchema.safeParse(content).success, true);
  for (const patch of [
    { midpoint: { requiredWords: 7, durationMinutes: 5 } },
    { review: { requiredWords: 49, durationMinutes: 10 } },
    { supported: { requiredWords: 8, durationMinutes: 0 } },
    { supported: { requiredWords: 8, durationMinutes: 5, completed: true } },
  ])
    assert.equal(
      unitContentSchema.safeParse({ ...content, stationSettings: { ...settings, ...patch } })
        .success,
      false,
    );
  // Historical and ordinary short word packs remain valid without authored settings.
  assert.equal(
    unitContentSchema.safeParse({ title: 'Short unit', entries: entries.slice(0, 2) }).success,
    true,
  );
});
