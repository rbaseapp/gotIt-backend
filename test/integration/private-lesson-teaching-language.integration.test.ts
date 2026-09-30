import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { PostgresPrivateLessonJournal } from '../../src/modules/private-lessons/private-lesson.repository.js';
import { PostgresPrivateLessonRoadmapStore } from '../../src/modules/private-lessons/private-lesson.roadmap.js';
import type { PrivateLessonPlan } from '../../src/modules/private-lessons/private-lesson.prompt.js';
import { createTestDatabase } from '../helpers/postgres.js';

test(
  'explanation language survives saved preferences and a resumed lesson',
  { timeout: 150_000 },
  async () => {
    const database = await createTestDatabase();
    try {
      const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
      await database.adminPool.query(
        `INSERT INTO core.applications(id,key,name) VALUES($1,'gotit','GotIt')`,
        [scope.applicationId],
      );
      await database.adminPool.query(
        `INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,'teaching@example.test')`,
        [scope.applicationUserId, scope.applicationId],
      );
      await new ProfileRepository(database.runtimePool).ensureAndGet(scope, PROFILE_DEFAULTS);
      const preferences = new PostgresPrivateLessonRoadmapStore(database.runtimePool);
      const input = {
        targetLanguageCode: 'en',
        supportLanguageCode: 'he',
        lessonMode: 'standard' as const,
        teachingLanguage: 'support' as const,
        requestedDurationMinutes: 5 as const,
        teacherVoice: 'female' as const,
        speechRate: 'normal' as const,
        focusAreas: ['grammar' as const],
        customFocus: null,
        correctionMode: 'recast' as const,
        vocabularyMode: 'none' as const,
      };
      await preferences.savePreferenceValues(scope, input);
      assert.equal((await preferences.getPreferences(scope, 'en'))?.teachingLanguage, 'support');
      await preferences.savePreferenceValues(scope, { ...input, teachingLanguage: undefined });
      assert.equal(
        (await preferences.getPreferences(scope, 'en'))?.teachingLanguage,
        'support',
        'an older client must not erase the choice',
      );

      const lesson: PrivateLessonPlan = {
        id: randomUUID(),
        durationSeconds: 300,
        targetLanguageCode: 'en',
        supportLanguageCode: 'he',
        lessonMode: 'standard',
        teachingLanguage: 'support',
        level: 'B1',
        topic: 'past simple',
        grammarFocus: 'past simple',
        focusAreas: ['grammar'],
        customFocus: null,
        correctionMode: 'recast',
        vocabularyMode: 'none',
        teacherVoice: 'female',
        speechRate: 'normal',
        interests: [],
        targets: [],
        continuity: null,
        roadmap: null,
      };
      const journal = new PostgresPrivateLessonJournal(database.runtimePool);
      await journal.create(scope, lesson);
      assert.equal((await journal.get(scope, lesson.id))?.teachingLanguage, 'support');
    } finally {
      await database.dispose();
    }
  },
);
