import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import type { ProfileScope } from '../../src/modules/profile/profile.types.js';
import { PostgresPrivateLessonProficiencyStore } from '../../src/modules/private-lessons/private-lesson.proficiency.js';
import type { PrivateLessonPlan } from '../../src/modules/private-lessons/private-lesson.prompt.js';
import { PostgresPrivateLessonJournal } from '../../src/modules/private-lessons/private-lesson.repository.js';
import { privateLessonReportSchema } from '../../src/modules/private-lessons/private-lesson.summary.js';
import { createTestDatabase } from '../helpers/postgres.js';

test(
  'private lesson proficiency accumulates skill evidence before changing the effective level',
  { timeout: 150_000 },
  async () => {
    const database = await createTestDatabase();
    try {
      const scope: ProfileScope = {
        applicationId: randomUUID(),
        applicationUserId: randomUUID(),
      };
      await database.adminPool.query(
        `INSERT INTO core.applications(id,key,name) VALUES($1,'gotit','GotIt')`,
        [scope.applicationId],
      );
      await database.adminPool.query(
        `INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,'level@example.test')`,
        [scope.applicationUserId, scope.applicationId],
      );
      const repository = new ProfileRepository(database.runtimePool);
      const profiles = new ProfileService(repository);
      await repository.ensureAndGet(scope, PROFILE_DEFAULTS);
      await profiles.patchProfile(scope, {
        languages: [{ languageCode: 'en', selfAssessedLevel: 'A2' }],
      });
      const journal = new PostgresPrivateLessonJournal(database.runtimePool);
      const proficiency = new PostgresPrivateLessonProficiencyStore(database.runtimePool);

      const record = async (score: number, performanceScore = 85) => {
        const lesson = plan();
        await journal.create(scope, lesson);
        await proficiency.recordLessonEvidence(scope, lesson, report(score, performanceScore));
        return lesson;
      };

      const first = await record(55);
      let profile = await profiles.getProfile(scope);
      let english = profile.languages.find((language) => language.languageCode === 'en')!;
      assert.equal(english.effectiveLevel, 'A2');
      assert.equal(english.systemEstimatedLevel, null);
      assert.equal(english.assessmentEvidenceCount, 1);
      assert.equal(english.skillEstimates?.length, 5);

      await proficiency.recordLessonEvidence(scope, first, report(55, 85));
      profile = await profiles.getProfile(scope);
      english = profile.languages.find((language) => language.languageCode === 'en')!;
      assert.equal(english.assessmentEvidenceCount, 1, 'a retried lesson is idempotent');

      await record(55);
      profile = await profiles.getProfile(scope);
      english = profile.languages.find((language) => language.languageCode === 'en')!;
      assert.equal(english.systemEstimatedLevel, 'B1');
      assert.equal(english.effectiveLevel, 'B1');
      assert.deepEqual(english.estimatedLevelRange, { from: 'B1', to: 'B2' });
      assert.equal(english.calibrationTarget, 'B2');

      await record(0, 25);
      await record(0, 25);
      profile = await profiles.getProfile(scope);
      english = profile.languages.find((language) => language.languageCode === 'en')!;
      assert.equal(english.effectiveLevel, 'B1', 'two poor lessons cannot downgrade a level');

      await record(0, 25);
      profile = await profiles.getProfile(scope);
      english = profile.languages.find((language) => language.languageCode === 'en')!;
      assert.equal(english.effectiveLevel, 'A1');
    } finally {
      await database.dispose();
    }
  },
);

function plan(): PrivateLessonPlan {
  return {
    id: randomUUID(),
    durationSeconds: 300,
    targetLanguageCode: 'en',
    supportLanguageCode: 'he',
    lessonMode: 'standard',
    level: 'B1',
    topic: 'open conversation',
    grammarFocus: null,
    focusAreas: ['speaking', 'vocabulary', 'grammar', 'fluency', 'listening'],
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
}

function report(score: number, performanceScore: number) {
  const skill = {
    score,
    level: score < 28 ? ('A1' as const) : ('B1' as const),
    feedback: 'Calibrated independent evidence.',
    confidence: 0.8,
    evidenceQuality: 'strong' as const,
    highestTestedLevel: 'B1' as const,
    evidenceCount: 3,
    dimensions: {
      accuracy: performanceScore,
      independence: 90,
      range: 80,
      complexity: 75,
      consistency: performanceScore,
    },
    evidence: [
      {
        learnerQuote: 'I explained my opinion independently.',
        observation: 'Independent extended response.',
        independent: true,
      },
    ],
  };
  return privateLessonReportSchema.parse({
    summary: 'Calibrated lesson.',
    assessment: {
      overallLevel: 'B1',
      levelRange: { from: 'B1', to: 'B1' },
      confidence: 'high',
      evidenceSufficient: true,
      calibrationTarget: 'B2',
      basis: 'Broad independent evidence.',
      lessonPerformance: {
        taskLevel: 'B1',
        score: performanceScore,
        result: performanceScore >= 70 ? 'successful' : 'developing',
        evidenceQuality: 'strong',
        independence: 90,
      },
      skills: {
        speaking: skill,
        vocabulary: skill,
        grammar: skill,
        fluency: skill,
        comprehension: skill,
      },
    },
    roadmapProgress: null,
    strengths: [],
    corrections: [],
    grammarPoints: [],
    vocabulary: [],
    newWordSuggestions: [],
    nextLessonPlan: 'Continue calibration.',
    recommendedReviewItemIds: [],
  });
}
