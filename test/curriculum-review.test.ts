import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { applyReview, parseCsv } from '../src/modules/curriculum/curriculum.review.js';

const texts = ['curriculum', 'introduction-update'].map((name) =>
  readFileSync(`assets/english-zero-c1/${name}.json`, 'utf8'),
);
const curriculum = JSON.parse(texts[0]!);
const fix = (id: string, suggested_english: string) => ({ id, verdict: 'fix', suggested_english });

test('the sheet parser reads quoted cells, commas, newlines and doubled quotes', () => {
  const rows = parseCsv(
    '﻿"id","verdict (ok / fix / unsure)","suggested_english"\r\n' +
      '"A","fix","Hi, ""Dana""\nthere"\r\n"B","ok",""\r\n',
  );
  assert.deepEqual(rows, [
    { id: 'A', verdict: 'fix', suggested_english: 'Hi, "Dana"\nthere' },
    { id: 'B', verdict: 'ok', suggested_english: '' },
  ]);
});

test('a fixed dialogue line changes in its unit and the lessons that repeat it, nowhere else', () => {
  const unit = curriculum.units.find((u: { id: string }) => u.id === 'A205');
  const line = unit.dialogue[0].text_en as string;
  const result = applyReview(
    [fix('A205:dialogue:1', `${unit.dialogue[0].speaker}: Better line.`)],
    texts,
  );
  assert.equal(result.problems.length, 0);
  assert.deepEqual(result.changes, [{ id: 'A205:dialogue:1', from: line, to: 'Better line.' }]);
  const after = JSON.parse(result.texts[0]!);
  assert.equal(
    after.units.find((u: { id: string }) => u.id === 'A205').dialogue[0].text_en,
    'Better line.',
  );
  const lessons = JSON.stringify(after.lessons.filter((l: { unit: string }) => l.unit === 'A205'));
  assert.ok(!lessons.includes(JSON.stringify(line)));
  // Other units keep their content.
  const others = (data: { units: { id: string }[] }) =>
    JSON.stringify(data.units.filter((u) => u.id !== 'A205'));
  assert.equal(others(after), others(curriculum));
});

test('a fixed teacher example also changes the spoken line that quotes it', () => {
  const result = applyReview(
    [fix('B101-L1:example:recently', "I've recently started biking to work.")],
    texts,
  );
  const lesson = JSON.parse(result.texts[0]!).lessons.find(
    (l: { id: string }) => l.id === 'B101-L1',
  );
  const phase = lesson.teacher_script.find(
    (p: { target_en?: string }) => p.target_en === 'recently',
  );
  assert.equal(phase.example_en, "I've recently started biking to work.");
  assert.match(phase.say_en, /For example: "I've recently started biking to work\."/u);
});

test('rows without a suggestion or with an unknown id are reported, not applied', () => {
  const result = applyReview(
    [
      { id: 'A205:dialogue:1', verdict: 'fix', suggested_english: '' },
      fix('Z999:passage', 'Text.'),
      { id: 'A205:dialogue:2', verdict: 'ok', suggested_english: 'ignored' },
    ],
    texts,
  );
  assert.equal(result.changes.length, 0);
  assert.equal(result.problems.length, 2);
  assert.deepEqual(result.texts, texts);
});

test('the tutor name in a suggestion goes back to the tutor slot', () => {
  const unit = JSON.parse(texts[1]!).units.find((u: { id: string }) => u.id === 'P01');
  const index = unit.dialogue.findIndex((d: { text_en: string }) =>
    d.text_en.includes('{{teacherName}}'),
  );
  assert.ok(index >= 0);
  const result = applyReview(
    [fix(`P01:dialogue:${index + 1}`, "Hi! I'm Rachel, your teacher.")],
    texts,
  );
  assert.equal(result.problems.length, 0);
  const after = JSON.parse(result.texts[1]!).units.find((u: { id: string }) => u.id === 'P01');
  assert.equal(after.dialogue[index].text_en, "Hi! I'm {{teacherName}}, your teacher.");
});
