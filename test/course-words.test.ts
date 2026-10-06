import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { CourseService } from '../src/modules/courses/course.service.js';
import { AppError } from '../src/shared/errors/app-error.js';
import {
  MemoryLearningStore,
  courseFixture,
  plan,
  preferences,
  profiles,
  scope,
} from './helpers/course-fixtures.js';

test('course vocabulary resolves only an owned active version and its approved language pair', async () => {
  const store = new MemoryLearningStore();
  const course = courseFixture();
  course.activeVersion = 1;
  course.versions = [
    {
      version: 1,
      plan,
      preferences: { ...preferences, targetLanguageCode: 'es', supportLanguageCode: 'ar' },
      createdAt: new Date().toISOString(),
    },
  ];
  const calls: unknown[] = [];
  const service = new CourseService(store, profiles, undefined, undefined, {
    resolve: async (...input) => {
      calls.push(input);
      return [{ sourceText: 'agua', choices: [] }];
    },
  });
  await store.save(scope, course, null, randomUUID(), 'create');
  const result = await service.unitWords(scope, course.id, plan.units[0]!.key);
  assert.equal(result.targetLanguageCode, 'es');
  assert.equal(result.supportLanguageCode, 'ar');
  assert.deepEqual(calls, [[scope, plan.units[0]!.vocabulary, 'es', 'ar']]);
  await assert.rejects(
    service.unitWords({ ...scope, applicationUserId: randomUUID() }, course.id, plan.units[0]!.key),
    (e) => e instanceof AppError && e.statusCode === 404,
  );
  await assert.rejects(
    service.unitWords(scope, course.id, 'unknown-unit'),
    (e) => e instanceof AppError && e.statusCode === 404,
  );
  assert.equal(calls.length, 1, 'invalid and foreign units never query vocabulary');
});
