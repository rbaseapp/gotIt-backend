import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { CURRICULUM_OUTPUT_SCHEMAS } from '../src/modules/curriculum/curriculum.service.js';
import {
  introduce,
  recallEvidence,
  REVIEW_DAYS,
  READING_DOSE,
  dailyPlan,
} from '../src/modules/curriculum/curriculum.policy.js';
import { content, lexicon, questionView } from '../src/modules/curriculum/curriculum.content.js';

test('authored zero-C1 content has all lessons, tasks and unique assessment forms', () => {
  assert.equal(content.units.length, 84);
  assert.equal(content.lessons.length, 168);
  assert.equal(
    content.lessons.reduce((sum, lesson) => sum + lesson.postlesson.length, 0),
    2016,
  );
  assert.equal(content.phonics.length, 24);
  assert.equal(content.unseen.length, 28);
  assert.equal(lexicon.targets.length, 3424);
  assert.equal(new Set(content.unseen.map((form) => form.passage_en)).size, 28);
  for (const lesson of content.lessons)
    assert.ok(content.units.some((unit) => unit.id === lesson.unit));
  const audio = content.lessons[0]!.postlesson.find((question) => question.audio_script_en)!;
  const view = questionView(audio, 'test');
  assert.equal(view.hasAudio, true);
  assert.ok(!JSON.stringify(view).includes('answer_en'));
  assert.ok(!JSON.stringify(view).includes('audio_script_en'));
});
test('new curriculum intervals start from previous successful recall; hints and immediate imitation do not advance', () => {
  assert.deepEqual(REVIEW_DAYS, [1, 3, 7, 14, 30, 60, 90]);
  const start = new Date('2026-01-01T12:00:00Z');
  let word = introduce(start);
  const input = {
    correct: true,
    assisted: false,
    dimension: 'recall' as const,
    timezone: 'Asia/Jerusalem',
    now: start,
  };
  word = recallEvidence(word, input);
  assert.equal(word.independentDays.length, 0);
  assert.equal(word.dimensions.recall, undefined);
  let when = new Date('2026-01-02T12:00:00Z');
  word = recallEvidence(word, { ...input, now: when });
  assert.equal(word.stage, 1);
  assert.equal(word.dueAt, '2026-01-05T12:00:00.000Z');
  const again = recallEvidence(word, { ...input, now: new Date('2026-01-02T18:00:00Z') });
  assert.equal(again.stage, 1);
  assert.equal(again.independentDays.length, 1);
  const hinted = recallEvidence(word, {
    ...input,
    assisted: true,
    now: new Date('2026-01-05T12:00:00Z'),
  });
  assert.equal(hinted.stage, 1);
  when = new Date('2026-01-05T12:00:00Z');
  word = recallEvidence(word, { ...input, now: when });
  assert.equal(word.stage, 2);
  assert.equal(word.dueAt, '2026-01-12T12:00:00.000Z');
  const failed = recallEvidence(word, {
    ...input,
    correct: false,
    now: new Date('2026-01-12T12:00:00Z'),
  });
  assert.equal(failed.stage, word.stage);
  assert.deepEqual(failed.independentDays, word.independentDays);
  assert.equal(failed.status, word.status);
});
test('daily budgets sum exactly and article doses differ by band', () => {
  for (const minutes of [10, 20, 30, 45, 60])
    assert.equal(
      dailyPlan(minutes).reduce((sum, part) => sum + part.minutes, 0),
      minutes,
    );
  assert.equal(READING_DOSE['Pre-A1'].min, 20);
  assert.equal(READING_DOSE.C1.max, 1200);
});
test('every generated assessment/reading schema closes nested objects for strict provider output', () => {
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      const keys = Object.keys(node.properties as object);
      assert.deepEqual([...(node.required as string[])].sort(), keys.sort());
    }
    Object.values(node).forEach(visit);
  };
  Object.values(CURRICULUM_OUTPUT_SCHEMAS).forEach((schema) =>
    visit(z.toJSONSchema(schema, { io: 'input' })),
  );
});
