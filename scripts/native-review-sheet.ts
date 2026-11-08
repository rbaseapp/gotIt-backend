// Writes docs/native-review/review-sheet.csv: every English line a learner hears or reads,
// for a fluent speaker to mark as natural or not. Open it in Google Sheets or Excel.
// Usage: npm run export:review
// Rows come in review order: the teacher's example sentences (newest content), then each
// unit's reading passage, then its dialogue. Tutor names are shown as Rachel.
import { mkdirSync, writeFileSync } from 'node:fs';
import { content, lexicon, normalize } from '../src/modules/curriculum/curriculum.content.js';
import { curriculumParticipants } from '../src/modules/curriculum/curriculum.participants.js';

const served = curriculumParticipants(content, 'female');
const header = [
  'id',
  'level',
  'unit',
  'unit_title',
  'type',
  'word',
  'meaning_he',
  'english',
  'verdict (ok / fix / unsure)',
  'suggested_english',
  'comment',
  'reviewer',
];
type Row = [string, string, string, string, string, string, string, string];
const rows: Row[] = [];
const unitTitle = new Map(served.units.map((unit) => [unit.id, unit.title_he]));
const band = new Map(served.units.map((unit) => [unit.id, unit.band]));

for (const lesson of served.lessons)
  for (const phase of lesson.teacher_script)
    if (phase.phase === 'teach_target' && typeof phase.example_en === 'string') {
      const word = String(phase.target_en);
      const target = lexicon.targets.find(
        (t) => t.unit === lesson.unit && normalize(t.en) === normalize(word),
      );
      rows.push([
        `${lesson.id}:example:${word}`,
        band.get(lesson.unit)!,
        lesson.unit,
        unitTitle.get(lesson.unit)!,
        'teacher example',
        word,
        target?.he ?? '',
        phase.example_en,
      ]);
    }
for (const unit of served.units) {
  rows.push([
    `${unit.id}:passage`,
    unit.band,
    unit.id,
    unit.title_he,
    'reading passage',
    '',
    '',
    unit.passage_en,
  ]);
  unit.dialogue.forEach((line, index) =>
    rows.push([
      `${unit.id}:dialogue:${index + 1}`,
      unit.band,
      unit.id,
      unit.title_he,
      'dialogue',
      '',
      line.text_he ?? '',
      `${line.speaker ? `${line.speaker}: ` : ''}${line.text_en}`,
    ]),
  );
}

const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
const csv = [header, ...rows.map((row) => [...row, '', '', '', ''])]
  .map((row) => row.map(cell).join(','))
  .join('\r\n');
mkdirSync('docs/native-review', { recursive: true });
// The byte-order mark lets Excel open the Hebrew columns as UTF-8.
writeFileSync('docs/native-review/review-sheet.csv', `﻿${csv}\r\n`);
const count = (type: string) => rows.filter((row) => row[4] === type).length;
console.log(
  `review-sheet.csv: ${rows.length} rows (${count('teacher example')} teacher examples, ${count('reading passage')} passages, ${count('dialogue')} dialogue lines)`,
);
