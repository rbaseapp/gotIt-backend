import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { content, lessonById, unitById } from '../src/modules/curriculum/curriculum.content.js';
import { curriculumParticipants } from '../src/modules/curriculum/curriculum.participants.js';

test('introduction corrections rename the unit and both lessons without changing published identities', () => {
  const original = JSON.parse(readFileSync('assets/english-zero-c1/curriculum.json', 'utf8'));
  assert.equal(unitById.get('P01')!.title_he, 'שלום, מציגים את עצמנו');
  assert.notEqual(unitById.get('P01')!.title_he, original.units[0].title_he);
  assert.deepEqual(
    content.units.map((unit) => unit.id),
    original.units.map((unit: { id: string }) => unit.id),
  );
  assert.deepEqual(
    content.lessons.map((lesson) => lesson.id),
    original.lessons.map((lesson: { id: string }) => lesson.id),
  );
  for (const id of ['P01-L1', 'P01-L2']) {
    const lesson = lessonById.get(id)!;
    assert.ok(lesson.title_he.startsWith('שלום, מציגים את עצמנו'));
    assert.doesNotMatch(JSON.stringify(lesson), /\b(?:Noa|Ben)\b|נועה/u);
    assert.equal(lesson.postlesson.length, 12);
    assert.match(String(lesson.postlesson[10]!.prompt_he), /בשם שלכם/u);
    assert.match(String(lesson.postlesson[11]!.prompt_he), /בשם שלכם/u);
  }
  for (const id of ['A101-L1', 'A101-L2']) {
    const lesson = lessonById.get(id)!;
    assert.doesNotMatch(JSON.stringify(lesson.postlesson.slice(10)), /\bNoa\b/u);
    assert.match(String(lesson.postlesson[10]!.prompt_he), /בשמכם/u);
  }
});

test('both tutors resolve across authored teaching, postlesson questions, passage and private anchors', () => {
  for (const voice of ['male', 'female'] as const) {
    const expected = voice === 'male' ? 'Mike' : 'Rachel';
    for (const id of ['P01-L1', 'P01-L2', 'A101-L1', 'A101-L2']) {
      const resolved = curriculumParticipants(lessonById.get(id)!, voice);
      const text = JSON.stringify(resolved);
      assert.ok(text.includes(expected));
      assert.doesNotMatch(text, /\{\{teacherName/u);
      assert.match(String(resolved.postlesson[10]!.rubric_he), /אין לדרוש שם/u);
    }
    const unit = curriculumParticipants(unitById.get('P01')!, voice);
    for (const question of unit.passage_questions) {
      assert.doesNotMatch(question.question_en!, /character.s perspective/u);
      assert.doesNotMatch(JSON.stringify(question), /\b(?:Noa|Ben)\b/u);
    }
    assert.equal(unit.passage_questions[0]!.answer_en, `${expected}.`);
    assert.equal(unit.passage_questions[3]!.answer_en, 'No.');
    for (const question of curriculumParticipants(
      lessonById.get('P01-L2')!,
      voice,
    ).postlesson.slice(6, 9))
      assert.equal(question.passage_en, unit.passage_en);
  }
  assert.match(
    unitById.get('P01')!.passage_en,
    /\{\{teacherName\}\}/u,
    'rendering must not change shared authored content',
  );
});
