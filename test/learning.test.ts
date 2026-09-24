import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LEARNING_POLICY as policy,
  decideProgress,
  calendarDay,
  previousDay,
  levelForXp,
  xpAwardForDailyTotal,
  projectOverallMastery,
} from '../src/modules/learning/learning.policy.js';
import { scoreAnswer, type AnswerSpec } from '../src/modules/practice/practice.scoring.js';
import { attemptSchema, exercisesSchema } from '../src/modules/practice/practice.validation.js';
import { validateWav } from '../src/modules/speech/speech.service.js';
const exerciseId = '11111111-1111-4111-8111-111111111111';
test('learning uses active recall evidence, then promotes learned words to established retention', () => {
  const now = new Date('2026-09-15T12:00:00Z'),
    evidence = {
      totalScoredAttempts: 3,
      activeRecallSuccesses: 2,
      activeRecallCalendarDays: 2,
      activeRecallMasteryScore: 100,
    },
    learned = decideProgress(
      policy,
      evidence,
      { status: 'reviewing', stage: 1, masterySource: null },
      100,
      now,
      [100, 100],
      true,
    );
  assert.equal(learned.status, 'mastered');
  assert.equal(learned.stage, 2);
  assert.equal(learned.retentionLevel, 'learned');
  assert.equal(learned.masteryRequirements.needsTypedRecall, false);
  assert.equal(learned.nextReviewAt.getTime() - now.getTime(), 7 * 86400000);

  const sameDay = decideProgress(
    policy,
    evidence,
    { status: 'reviewing', stage: 1, masterySource: null },
    100,
    now,
    [100, 100],
    true,
    false,
  );
  assert.equal(sameDay.stage, 1);
  assert.equal(sameDay.status, 'reviewing');
  assert.equal(sameDay.masteryRequirements.needsTypedRecall, true);

  assert.equal(
    decideProgress(
      policy,
      { ...evidence, activeRecallCalendarDays: 1 },
      { status: 'reviewing', stage: 1, masterySource: null },
      100,
      now,
      [100, 100],
      true,
    ).status,
    'reviewing',
  );

  const established = decideProgress(
    policy,
    evidence,
    { status: 'mastered', stage: 3, masterySource: 'system' },
    100,
    now,
    [100, 100, 100],
    true,
  );
  assert.equal(established.stage, 4);
  assert.equal(established.retentionLevel, 'established');
  assert.equal(established.nextReviewAt.getTime() - now.getTime(), 60 * 86400000);

  assert.equal(
    decideProgress(
      policy,
      evidence,
      { status: 'mastered', stage: 4, masterySource: 'system' },
      0,
      now,
      [100, 100, 0],
      true,
    ).status,
    'mastered',
  );
  assert.equal(
    decideProgress(
      policy,
      evidence,
      { status: 'mastered', stage: 4, masterySource: 'system' },
      0,
      now,
      [100, 0, 0],
      true,
    ).status,
    'reviewing',
  );
  assert.equal(calendarDay(new Date('2026-09-15T22:00:00Z'), 'Asia/Jerusalem'), '2026-09-16');
  assert.equal(previousDay('2024-03-01'), '2024-02-29');
  assert.equal(levelForXp(99), 1);
  assert.equal(levelForXp(100), 2);
  assert.equal(xpAwardForDailyTotal(10, 0, 200, 25), 10);
  assert.equal(xpAwardForDailyTotal(10, 195, 200, 25), 6);
  assert.equal(xpAwardForDailyTotal(10, 200, 200, 25), 3);
  assert.equal(xpAwardForDailyTotal(3, 200, 200, 25), 1);
  assert.equal(xpAwardForDailyTotal(10, 200, 200, 0), 0);
});
test('typed scoring normalizes Unicode, recognizes accepted variants, treats typos and hints as partial, and validates answer mode', () => {
  const spec: AnswerSpec = {
    kind: 'typed',
    accepted: ['Hello', 'Hi'],
    skills: [{ skill: 'recall', weight: 1 }],
  };
  const attempt = (answerText: string, hintsUsed = 0) =>
    attemptSchema.parse({ exerciseId, answerText, hintsUsed });
  assert.equal(scoreAnswer(spec, attempt('ＨＥＬＬＯ')).score, 100);
  assert.equal(scoreAnswer(spec, attempt('helo')).score, 70);
  assert.equal(scoreAnswer(spec, attempt('hi')).score, 100);
  assert.equal(scoreAnswer(spec, attempt('hello', 1)).result, 'partially_correct');
  assert.throws(() => scoreAnswer(spec, attemptSchema.parse({ exerciseId, selfRating: 'easy' })));
});
test('remedial exercise requests accept a unique bounded item subset', () => {
  assert.deepEqual(
    exercisesSchema.parse({ count: 1, learningItemIds: [exerciseId] }).learningItemIds,
    [exerciseId],
  );
  assert.throws(() =>
    exercisesSchema.parse({ count: 1, learningItemIds: [exerciseId, exerciseId] }),
  );
});
test('overall mastery reflects attempted skills without treating untried skills as failures', () => {
  const evidence = [
    {
      skillType: 'recognition' as const,
      masteryScore: 100,
      confidence: 0.03,
      attemptCount: 1,
      successCount: 1,
      failureCount: 0,
      calendarDays: 1,
    },
    {
      skillType: 'recall' as const,
      masteryScore: 0,
      confidence: 0,
      attemptCount: 0,
      successCount: 0,
      failureCount: 0,
      calendarDays: 0,
    },
  ];
  assert.equal(projectOverallMastery(policy, evidence), 100);
  assert.equal(
    projectOverallMastery(policy, [
      evidence[0]!,
      { ...evidence[1]!, attemptCount: 1, failureCount: 1 },
    ]),
    40,
  );
});
test('WAV validation rejects malformed lengths, channels, formats and excessive duration', () => {
  const data = 3200,
    audio = Buffer.alloc(44 + data);
  audio.write('RIFF', 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(data, 40);
  assert.equal(validateWav(audio).durationSeconds, 0.1);
  const stereo = Buffer.from(audio);
  stereo.writeUInt16LE(2, 22);
  assert.throws(() => validateWav(stereo));
  assert.throws(() => validateWav(audio.subarray(0, audio.length - 1)));
  assert.throws(() => validateWav(Buffer.alloc(500001)));
});
