// Applies a filled-in native review sheet (see docs/native-review/README.md) to the assets.
// Usage: npm run apply:review -- <sheet.csv> [--write]
// Without --write it only prints the changes. Rows marked "fix" with a suggested_english
// replace that line everywhere the course repeats it (lessons copy passages and dialogue).
import { readFileSync, writeFileSync } from 'node:fs';
import { applyReview, parseCsv } from '../src/modules/curriculum/curriculum.review.js';

const [sheet, ...flags] = process.argv.slice(2);
if (!sheet) throw new Error('Usage: npm run apply:review -- <sheet.csv> [--write]');
const files = ['curriculum.json', 'introduction-update.json'].map((name) => ({
  path: `assets/english-zero-c1/${name}`,
  text: readFileSync(`assets/english-zero-c1/${name}`, 'utf8'),
}));
const result = applyReview(
  parseCsv(readFileSync(sheet, 'utf8')),
  files.map((file) => file.text),
);
for (const change of result.changes)
  console.log(`${change.id}\n  - ${change.from}\n  + ${change.to}`);
for (const problem of result.problems) console.log(`SKIPPED ${problem}`);
console.log(`${result.changes.length} changes, ${result.problems.length} skipped`);
if (flags.includes('--write')) {
  files.forEach((file, index) => writeFileSync(file.path, result.texts[index]!));
  console.log('Written. Next: npm run audit:curriculum && npm test');
}
