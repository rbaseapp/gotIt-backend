import type { DatabaseTransaction } from '../../shared/database/transaction.js';
import type { ProfileScope } from '../profile/profile.types.js';
import { lookupText } from '../capture/capture.validation.js';
import { AppError } from '../../shared/errors/app-error.js';
import {
  BANDS,
  content,
  allTargets,
  unitById,
  PROGRAM_ID,
  PROGRAM_VERSION,
  type Band,
} from './curriculum.content.js';
import { scopeArgs, curriculumMissing, type CurriculumState } from './curriculum.store.js';
import { introduce, recallEvidence, reviewPriority } from './curriculum.policy.js';

export function curriculumPlacedBelow(state: CurriculumState, band: Band) {
  return ['reading', 'listening', 'speaking', 'writing', 'vocabulary'].every((skill) => {
    const evidence = state.placement[skill];
    return (
      evidence?.independent &&
      evidence.score >= 0.75 &&
      BANDS.indexOf(evidence.band as Band) > BANDS.indexOf(band)
    );
  });
}
export function curriculumUnitUnlocked(state: CurriculumState, id: string): boolean {
  if (id === 'C1E') return curriculumUnitUnlocked(state, 'C101');
  const index = content.units.findIndex((unit) => unit.id === id);
  if (index < 0) return false;
  const previous = content.units[index - 1];
  const required = previous
    ? content.unseen.find((test) => test.proposed_unit_block.at(-1) === previous.id)
    : null;
  if (
    index === 0 ||
    (previous &&
      state.completed[`gate:${previous.id}`] &&
      (!required || state.completed[`unseen:${required.id}`]))
  )
    return true;
  const band = unitById.get(id)!.band;
  return (
    curriculumPlacedBelow(state, band) ||
    (content.units.find((unit) => unit.band === band)?.id === id &&
      ['reading', 'listening', 'speaking', 'writing', 'vocabulary'].every((skill) => {
        const evidence = state.placement[skill];
        return (
          evidence?.independent &&
          evidence.score >= 0.75 &&
          BANDS.indexOf(evidence.band as Band) >= BANDS.indexOf(band)
        );
      }))
  );
}
export type CurriculumPracticeSelection = {
  version: string;
  unitId: string;
  title: string;
  targets: Record<string, string>;
};
export async function lockCurriculumPractice(tx: DatabaseTransaction, scope: ProfileScope) {
  await tx.lock(['curriculum', ...scopeArgs(scope), PROGRAM_ID, PROGRAM_VERSION]);
}
async function enrollment(tx: DatabaseTransaction, scope: ProfileScope) {
  const row = (
    await tx.query(
      `SELECT state FROM product_gotit.structured_program_enrollments
    WHERE application_id=$1 AND application_user_id=$2 AND program_id=$3 AND version=$4 FOR UPDATE`,
      [...scopeArgs(scope), PROGRAM_ID, PROGRAM_VERSION],
    )
  ).rows[0];
  if (!row) throw curriculumMissing();
  return row.state as CurriculumState;
}
async function save(tx: DatabaseTransaction, scope: ProfileScope, state: CurriculumState) {
  await tx.query(
    `UPDATE product_gotit.structured_program_enrollments SET state=$5::jsonb,revision=revision+1,updated_at=now()
    WHERE application_id=$1 AND application_user_id=$2 AND program_id=$3 AND version=$4`,
    [...scopeArgs(scope), PROGRAM_ID, PROGRAM_VERSION, JSON.stringify(state)],
  );
}

/** Real practice items, scoped to this version and target. No historical learning is imported. */
export async function prepareCurriculumPractice(
  tx: DatabaseTransaction,
  scope: ProfileScope,
  unitId: string,
) {
  await lockCurriculumPractice(tx, scope);
  const state = await enrollment(tx, scope);
  const unit = unitById.get(unitId);
  if (!unit || !curriculumUnitUnlocked(state, unitId)) throw curriculumMissing();
  const words = allTargets.filter((target) => target.unit === unitId);
  if (!words.length || words.length > 100) throw curriculumMissing();
  state.practiceItems ??= {};
  const targets: Record<string, string> = {};
  let changed = false;
  for (const word of words) {
    let id = state.practiceItems[word.id];
    if (id) {
      const item = (
        await tx.query(
          `SELECT id FROM product_gotit.learning_items li WHERE application_id=$1 AND application_user_id=$2
        AND id=$3 AND deleted_at IS NULL AND user_status='active' AND source_language_code='en' AND translation_language_code='he'
        AND source_text=$4 AND EXISTS(SELECT 1 FROM product_gotit.item_translations t WHERE t.learning_item_id=li.id
          AND t.application_id=li.application_id AND t.application_user_id=li.application_user_id AND t.is_current AND t.is_primary AND t.translation_text=$5)`,
          [...scopeArgs(scope), id, word.en, word.he],
        )
      ).rows[0];
      if (!item) throw new AppError(409, 'EXERCISE_STALE', 'Curriculum practice word changed');
    } else {
      const item = (
        await tx.query(
          `INSERT INTO product_gotit.learning_items
        (application_id,application_user_id,source_text,normalized_source_text,source_language_code,translation_language_code,item_type)
        VALUES($1,$2,$3,$4,'en','he',$5) RETURNING id`,
          [
            ...scopeArgs(scope),
            word.en,
            lookupText(word.en),
            word.en.trim().includes(' ') ? 'phrase' : 'word',
          ],
        )
      ).rows[0]!;
      id = String(item.id);
      await tx.query(
        `INSERT INTO product_gotit.item_translations
        (application_id,application_user_id,learning_item_id,translation_text,normalized_text,is_primary,source_kind)
        VALUES($1,$2,$3,$4,$5,true,'catalog')`,
        [...scopeArgs(scope), id, word.he, lookupText(word.he)],
      );
      const example = unit.dialogue.find((turn) =>
        turn.text_en.toLowerCase().includes(word.en.toLowerCase()),
      )?.text_en;
      if (example)
        await tx.query(
          `INSERT INTO product_gotit.item_examples
        (application_id,application_user_id,learning_item_id,example_text,source_kind,learning_revision)
        VALUES($1,$2,$3,$4,'catalog',1)`,
          [...scopeArgs(scope), id, example],
        );
      await tx.query(
        `INSERT INTO product_gotit.item_skill_progress
        (application_id,application_user_id,learning_item_id,skill_type,algorithm_version)
        SELECT $1,$2,$3,skill,'pending-learning-engine' FROM unnest(ARRAY['recognition','recall','listening','spelling','pronunciation']) skill`,
        [...scopeArgs(scope), id],
      );
      state.practiceItems[word.id] = id;
      changed = true;
    }
    targets[id] = word.id;
  }
  if (changed) await save(tx, scope, state);
  const now = new Date();
  // Every target remains in the session; due/failed words come first, followed by authored order.
  const ranked = words.map((word, index) => ({ word, index, evidence: state.words[word.id] }));
  ranked.sort((a, b) => {
    const priority = (value: typeof a) =>
      value.evidence && Date.parse(value.evidence.dueAt) <= +now
        ? reviewPriority(value.evidence, now)
        : 0;
    return priority(b) - priority(a) || a.index - b.index;
  });
  return {
    ids: ranked.map(({ word }) => state.practiceItems![word.id]!),
    selection: {
      version: PROGRAM_VERSION,
      unitId,
      title: unit.title_he,
      targets,
    } satisfies CurriculumPracticeSelection,
  };
}

/** Runs inside the original attempt transaction and its receipt/replay boundary. */
export async function recordCurriculumPractice(
  tx: DatabaseTransaction,
  scope: ProfileScope,
  selection: CurriculumPracticeSelection,
  input: {
    itemId: string;
    type: string;
    correct: boolean;
    assisted: boolean;
    cued: boolean;
    skipped: boolean;
    now: Date;
  },
) {
  if (selection.version !== PROGRAM_VERSION)
    throw new AppError(409, 'EXERCISE_STALE', 'Curriculum version changed');
  const targetId = selection.targets[input.itemId];
  const target = allTargets.find((word) => word.id === targetId && word.unit === selection.unitId);
  if (!target) throw curriculumMissing();
  if (input.skipped) return;
  const state = await enrollment(tx, scope);
  if (state.practiceItems?.[target.id] !== input.itemId) throw curriculumMissing();
  state.words[target.id] ??= introduce(input.now);
  const word = state.words[target.id]!;
  word.practiceModes ??= {};
  const mode =
    input.type === 'matching'
      ? 'matching'
      : input.type === 'recall'
        ? 'recall'
        : input.type === 'listening_spelling'
          ? 'listening'
          : null;
  if (input.correct && !input.assisted && mode) {
    word.practiceModes[mode] = (word.practiceModes[mode] ?? 0) + 1;
    if (mode === 'matching')
      word.practiceModes.recognition = (word.practiceModes.recognition ?? 0) + 1;
  }
  if (mode)
    state.words[target.id] = recallEvidence(word, {
      correct: input.correct,
      assisted: input.assisted || mode === 'matching',
      dimension: mode === 'matching' ? 'meaning' : mode === 'listening' ? 'listening' : 'recall',
      retrievalCued: input.cued,
      timezone: state.timezone,
      now: input.now,
    });
  else word.lastExposureAt = input.now.toISOString();
  if (!input.correct || input.assisted || input.cued)
    state.words[target.id]!.lastExposureAt = input.now.toISOString();
  await save(tx, scope, state);
}
