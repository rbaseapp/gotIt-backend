// Read-only report of the within-learner curriculum experiments.
// Usage: DATABASE_URL=... npm run report:experiments [-- <experiment-id>]
// Reads learner states only; it never writes and prints no user identifiers.
import { createPool } from '../src/shared/database/pool.js';
import {
  lexicon,
  PROGRAM_ID,
  PROGRAM_VERSION,
} from '../src/modules/curriculum/curriculum.content.js';
import {
  analyzeExperiment,
  EXPERIMENTS,
} from '../src/modules/curriculum/curriculum.experiments.js';
import type { CurriculumState } from '../src/modules/curriculum/curriculum.store.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const wanted = process.argv[2];
const experiments = EXPERIMENTS.filter((e) => !wanted || e.id === wanted);
if (!experiments.length) throw new Error(`Unknown experiment ${wanted}`);

const unitTargets = new Map<string, string[]>();
for (const target of lexicon.targets)
  unitTargets.set(target.unit, [...(unitTargets.get(target.unit) ?? []), target.id]);

const pool = createPool(url);
try {
  const rows = (
    await pool.query<{ application_user_id: string; state: CurriculumState }>(
      `SELECT application_user_id,state FROM product_gotit.structured_program_enrollments
       WHERE program_id=$1 AND version=$2`,
      [PROGRAM_ID, PROGRAM_VERSION],
    )
  ).rows;
  const learners = rows.map((row) => ({ userId: row.application_user_id, words: row.state.words }));
  for (const experiment of experiments) {
    const report = analyzeExperiment(experiment, learners, unitTargets, new Date());
    console.log(`\n${experiment.id}: ${experiment.description}`);
    console.log(
      `learners ${report.learners}, paired ${report.pairedLearners}, words still pending ${report.pendingWords}`,
    );
    for (const [arm, totals] of Object.entries(report.arms))
      console.log(
        `  arm ${arm}: ${totals.retained}/${totals.words} retained` +
          (totals.rate === null ? '' : ` (${(totals.rate * 100).toFixed(1)}%)`),
      );
    if (report.meanDifference !== null)
      console.log(
        `  within-learner difference ${(report.meanDifference * 100).toFixed(1)} points` +
          (report.interval95
            ? `, 95% interval ${report.interval95.map((x) => (x * 100).toFixed(1)).join(' to ')}`
            : ' (needs 2+ paired learners for an interval)'),
      );
  }
} finally {
  await pool.end();
}
