import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allTargets, content, unitById } from '../src/modules/curriculum/curriculum.content.js';
import { clozeable, curriculumExample } from '../src/modules/curriculum/curriculum.examples.js';
import { clozeContext } from '../src/modules/practice/practice.cloze.js';
import type { Lesson, Unit } from '../src/modules/curriculum/curriculum.content.js';

const unit = (id: string, lines: string[], passage = ''): Unit =>
  ({
    id,
    dialogue: lines.map((text_en) => ({ speaker: 'A', text_en, text_he: '' })),
    passage_en: passage,
    model_response_en: '',
  }) as unknown as Unit;

test('a longer word is never the sentence for a shorter one', () => {
  const units = [unit('U1', ['That is affordable.', 'We can afford it.'])];
  assert.equal(curriculumExample('afford', units[0]!, []), 'We can afford it.');
  assert.equal(clozeable('That is affordable.', 'afford'), false);
});

test("the teacher's example for the word comes first, then the word's own unit, then the nearest unit", () => {
  const lessons = [
    {
      unit: 'U2',
      teacher_script: [
        { phase: 'teach_target', target_en: 'budget', example_en: 'My budget is small.' },
      ],
    },
  ] as unknown as Lesson[];
  const units = [
    unit('U1', ['A budget helps.']),
    unit('U2', ['Check the budget today.']),
    unit('U3', ['They walk home.']),
    unit('U4', ['I walk to work.']),
  ];
  assert.equal(curriculumExample('budget', units[1]!, lessons, units), 'My budget is small.');
  assert.equal(curriculumExample('walk', units[1]!, lessons, units), 'They walk home.');
  assert.equal(curriculumExample('lake', units[1]!, lessons, units), null);
});

test('passages are split into sentences and slot templates are skipped', () => {
  const u = unit(
    'U1',
    ['{{t:He|She}} can afford it.'],
    'We went out. Nobody could afford the hotel. It rained.',
  );
  assert.equal(curriculumExample('afford', u, []), 'Nobody could afford the hotel.');
});

test('every course word that has a course sentence gets one with a gap', () => {
  let found = 0;
  for (const target of allTargets.filter((target) => target.track === 'communicative')) {
    const example = curriculumExample(
      target.en,
      unitById.get(target.unit)!,
      content.lessons,
      content.units,
    );
    if (!example) continue;
    found++;
    assert.ok(clozeContext(example, [target.en]), `${target.en}: ${example}`);
  }
  // 357 of the communicative words had a usable sentence before.
  assert.ok(found > 900, `only ${found}`);
});

test('clozeContext returns null when the exact answer is missing', () => {
  assert.equal(clozeContext('That is affordable.', ['afford']), null);
  assert.equal(clozeContext('We can afford it.', ['afford']), 'We can _____ it.');
  assert.equal(clozeContext(null, ['afford']), null);
});
