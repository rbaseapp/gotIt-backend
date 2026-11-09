import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  auditCurriculum,
  auditPhonics,
  auditUnits,
  baseForms,
  segmentable,
  uncontractedForms,
  type AuditUnit,
} from '../src/modules/curriculum/curriculum.quality.js';
import { content, lexicon, sameEnglish } from '../src/modules/curriculum/curriculum.content.js';
import { curriculumParticipants } from '../src/modules/curriculum/curriculum.participants.js';

const unit = (over: Partial<AuditUnit>): AuditUnit => ({
  id: 'X01',
  band: 'Pre-A1',
  targets: [],
  dialogue: [],
  passage_en: '',
  ...over,
});

test('uncontracted spoken forms are flagged, stressed final forms are not', () => {
  assert.deepEqual(
    uncontractedForms('I am Noa.').map((u) => u.form),
    ['I am'],
  );
  assert.equal(uncontractedForms('Yes, I am.').length, 0);
  assert.equal(uncontractedForms("I'm Noa. Let's go.").length, 0);
  assert.deepEqual(
    uncontractedForms('I do not understand. Let us meet at five.').map((u) => u.form),
    ['do not', 'Let us'],
  );
});

test('base forms fold common inflections and contractions', () => {
  assert.ok(baseForms('apples').includes('apple'));
  assert.ok(baseForms('stopped').includes('stop'));
  assert.ok(baseForms('making').includes('make'));
  assert.ok(baseForms("don't").includes('not'));
  assert.ok(baseForms("can't").includes('can'));
});

test('unit audit reports budget, coverage, missing targets and recycling', () => {
  const [first, second] = auditUnits([
    unit({
      id: 'P01',
      targets: ['hello', 'name', 'my', 'is', 'goodbye', 'hi', 'yes', 'no'].map((en) => ({ en })),
      dialogue: [{ text_en: 'Hello. My name is Ben.' }],
      passage_en: 'Hello. My name is Noa. Goodbye.',
    }),
    unit({
      id: 'P02',
      targets: [{ en: 'apple' }, { en: 'cup' }],
      support_words: ['I', 'have', 'two', 'a'],
      dialogue: [{ text_en: 'I am Noa. I have two apples.' }],
      passage_en: 'Hello. I have a cup and a zebra.',
    }),
  ]);
  assert.ok(first && second);
  assert.equal(first.overBudget, true);
  assert.ok(first.targetsNotInInput.includes('hi'));
  assert.equal(first.passageCoverage, 1);
  assert.equal(second.overBudget, false);
  assert.deepEqual(second.unknownInPassage.sort(), ['and', 'zebra']);
  assert.ok(second.recycledEarlierTargets >= 1);
  assert.equal(second.uncontracted.length, 1);
  assert.equal(second.reviewed, false);
});

test('phonics decodability only allows graphemes taught so far', () => {
  assert.ok(segmentable('ship', new Set(['sh', 'i', 'p'])));
  assert.ok(!segmentable('ship', new Set(['s', 'i', 'p'])));
  const [f1, f2] = auditPhonics([
    {
      id: 'F01',
      mappings: ['s', 'a', 't', 'm'].map((grapheme) => ({ grapheme })),
      decodable_words: ['sat', 'mat', 'pat'],
    },
    {
      id: 'F02',
      mappings: [{ grapheme: 'p' }, { grapheme: 'a_e' }],
      decodable_words: ['pat', 'tape', 'the'],
      irregular_words: ['the'],
    },
  ]);
  assert.ok(f1 && f2);
  assert.deepEqual(f1.notDecodable, ['pat']);
  assert.deepEqual(f2.notDecodable, []);
});

test('the shipped curriculum is auditable end to end', () => {
  const content = JSON.parse(readFileSync('assets/english-zero-c1/curriculum.json', 'utf8'));
  const report = auditCurriculum(content);
  assert.equal(report.units.length, content.units.length);
  assert.equal(report.phonics.length, content.phonics.length);
  for (const band of report.summary)
    assert.ok((band.medianCoverage ?? -1) >= 0 && (band.medianCoverage ?? 2) <= 1);
});

test('contracted and full forms grade as the same closed answer', () => {
  assert.ok(sameEnglish("I'm Ben.", 'I am Ben.'));
  assert.ok(sameEnglish('I don’t understand', 'I do not understand.'));
  assert.ok(sameEnglish("It's cold", 'It is cold.'));
  assert.ok(sameEnglish("I can't swim", 'I cannot swim'));
  assert.ok(sameEnglish("Let's go", 'let us go'));
  assert.ok(!sameEnglish("I'm Dan.", 'I am Ben.'));
});

const assetText = () =>
  ['curriculum', 'lexicon', 'exit-assessment', 'introduction-update']
    .map((name) => readFileSync(`assets/english-zero-c1/${name}.json`, 'utf8'))
    .join('\n');

test('Pre-A1 to A2 dialogue uses natural contractions', () => {
  const report = auditCurriculum(content);
  const lines = report.units
    .filter((u) => ['Pre-A1', 'A1', 'A2'].includes(u.band))
    .flatMap((u) => u.uncontracted.map((x) => `${u.id}: ${x.line}`));
  assert.deepEqual(lines, []);
});

test('the course uses American spelling (General American model)', () => {
  const british =
    /\b(colour\w*|centre[sd]?|practis(e|ed|es|ing)|neighbour\w*|behaviour\w*|favour\w*|theatre|programmes?|judgement|travell(ed|ing|er|ers)|cancell(ed|ing)|organis(e|ed|es|ing|ation\w*|er\w*)|recognis\w+|realis(e|ed|es|ing))\b/gi;
  // former_en keeps the old spelling on purpose (renaming existing practice items).
  const text = assetText().replace(/"former_en": \[[^\]]*\]/g, '');
  assert.deepEqual([...new Set(text.match(british) ?? [])], []);
});

test('renamed target words keep their former spelling for existing practice items', () => {
  const lexicon = JSON.parse(readFileSync('assets/english-zero-c1/lexicon.json', 'utf8'));
  const color = lexicon.targets.find((t: { id: string }) => t.id === 'A105-T05');
  assert.equal(color.en, 'color');
  assert.deepEqual(color.former_en, ['colour']);
});

test('every lesson word is met in context: dialogue, passage or the teacher example', () => {
  const missing = auditCurriculum(content).units.flatMap((u) =>
    u.targetsNotInInput.map((t) => `${u.id}: ${t}`),
  );
  assert.deepEqual(missing, []);
});

test('every reading passage reaches 95% known words', () => {
  // As in the report: a unit's frequency cards are taught before its reading.
  const cards = new Map<string, string[]>();
  for (const t of lexicon.targets)
    if (t.track !== 'communicative') cards.set(t.unit, [...(cards.get(t.unit) ?? []), t.en]);
  const low = auditCurriculum(content, cards)
    .units.filter((u) => u.passageCoverage < 0.95)
    .map((u) => u.id);
  assert.deepEqual(low, []);
});

test('A2 to C1 use American everyday words', () => {
  // NGSL definitions keep their source wording ("a flat dish") under attribution.
  const text = assetText()
    .replace(/"former_en": \[[^\]]*\]/g, '')
    .replace(/"definition_en": "[^"]*"/g, '');
  const british =
    /\b(an? (small |shared )?flat|the flat|timetables?|in the lift|rubbish|pavement|rota|flatmates?|enquir(y|ies)|trolleys?|public transport(?!ation)|\d+ pounds|(sixty|ninety|ten) pounds)\b/gi;
  assert.deepEqual([...new Set(text.match(british) ?? [])], []);
  const renamed = (id: string) => lexicon.targets.find((t) => t.id === id)!;
  assert.deepEqual([renamed('A203-T02').en, renamed('A208-T10').en], ['vacation', 'line']);
});

test('the phonics track stays decodable and keeps Hebrew-speaker reinforcement', () => {
  const report = auditCurriculum(content);
  assert.equal(report.phonicsNotDecodable, 0);
  const kinds = (id: string) => content.phonics.find((s) => s.id === id)!.exercises;
  for (const id of ['F02', 'F03', 'F04', 'F05', 'F06', 'F07'])
    assert.ok(
      kinds(id).some((e) => e.kind === 'phoneme_deletion'),
      id,
    );
  // th (F10), silent e (F13) and b/d/p/q letter shapes return in later sessions.
  const reviews = content.phonics.flatMap((s) =>
    s.exercises.filter((e) => e.review_of).map((e) => String(e.review_of)),
  );
  for (const of of ['F07', 'F08', 'F10', 'F13']) assert.ok(reviews.includes(of), of);
  // Added exercises go before the closing dictation of F02–F19.
  assert.ok(content.phonics.slice(1, 19).every((s) => s.exercises.at(-1)?.kind === 'dictation'));
});

test('from B1 a full "would" in speech is a register choice, not a defect', () => {
  assert.equal(uncontractedForms('If I were you, I would wait.', 'B2').length, 0);
  assert.equal(uncontractedForms('If I were you, I would wait.', 'A2').length, 1);
  assert.equal(uncontractedForms('I do not agree with that.', 'C1').length, 1);
});

test('Hebrew instructions address learners in the plural and agree with the tutor', () => {
  const text = assetText();
  // The recurring instruction phrases are plural, like the rest of the app.
  for (const singular of ['הקשב:', 'אמור את הצורה', 'השתמש במשמעות שנלמדה', 'נסה שוב או הקלד'])
    assert.equal(text.includes(singular), false, singular);
  // Every tutor slot has a masculine and a feminine form and resolves for both tutors.
  const slots = text.match(/\{\{t:[^}]*\}\}/gu) ?? [];
  assert.ok(slots.length > 200);
  for (const slot of slots) assert.match(slot, /^\{\{t:[^|{}]+\|[^|{}]+\}\}$/u, slot);
  for (const voice of ['female', 'male'] as const) {
    const resolved = JSON.stringify(curriculumParticipants(content, voice));
    assert.equal(resolved.includes('{{t:'), false);
  }
  assert.equal(curriculumParticipants('המורה {{t:יציג|תציג}} עט.', 'female'), 'המורה תציג עט.');
  assert.equal(curriculumParticipants('המורה {{t:יציג|תציג}} עט.', 'male'), 'המורה יציג עט.');
});
