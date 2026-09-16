import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LEARNING_POLICY as policy,
  decideProgress,
  projectEvidence,
  calendarDay,
  previousDay,
  levelForXp,
} from '../src/modules/learning/learning.policy.js';
import { scoreAnswer, type AnswerSpec } from '../src/modules/practice/practice.scoring.js';
import { attemptSchema } from '../src/modules/practice/practice.validation.js';
import { validateWav } from '../src/modules/speech/speech.service.js';
const exerciseId = '11111111-1111-4111-8111-111111111111';
test('mastery requires all enabled skills, calendar evidence and mature review; same-day review and one failure cannot fake transitions', () => {
  const evidence = ['recognition', 'recall', 'spelling'].map((skillType) => ({
      skillType: skillType as 'recall',
      ...projectEvidence([100, 100, 100], 2),
    })),
    now = new Date('2026-09-15T12:00:00Z');
  assert.equal(
    decideProgress(
      policy,
      evidence,
      ['recognition', 'recall', 'spelling'],
      { status: 'reviewing', stage: 3, masterySource: null },
      100,
      now,
      [100, 100, 100],
    ).status,
    'mastered',
  );
  assert.equal(
    decideProgress(
      policy,
      evidence,
      ['recognition', 'recall', 'spelling', 'pronunciation'],
      { status: 'reviewing', stage: 3, masterySource: null },
      100,
      now,
      [100, 100, 100],
    ).status,
    'reviewing',
  );
  const same = decideProgress(
    policy,
    evidence,
    ['recognition', 'recall', 'spelling'],
    { status: 'reviewing', stage: 3, masterySource: null },
    100,
    now,
    [100, 100, 100],
    false,
  );
  assert.equal(same.stage, 3);
  assert.equal(same.status, 'reviewing');
  assert.equal(same.nextReviewAt.getTime() - now.getTime(), 14 * 86400000);
  assert.equal(
    decideProgress(
      policy,
      evidence,
      ['recall'],
      { status: 'mastered', stage: 4, masterySource: 'system' },
      0,
      now,
      [100, 100, 0],
    ).status,
    'mastered',
  );
  assert.equal(
    decideProgress(
      policy,
      evidence,
      ['recall'],
      { status: 'mastered', stage: 4, masterySource: 'system' },
      0,
      now,
      [100, 0, 0],
    ).status,
    'reviewing',
  );
  assert.equal(calendarDay(new Date('2026-09-15T22:00:00Z'), 'Asia/Jerusalem'), '2026-09-16');
  assert.equal(previousDay('2024-03-01'), '2024-02-29');
  assert.equal(levelForXp(99), 1);
  assert.equal(levelForXp(100), 2);
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
