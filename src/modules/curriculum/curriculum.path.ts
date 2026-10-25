import { allTargets, content, lessonById, unitById } from './curriculum.content.js';
import type { CurriculumState } from './curriculum.store.js';
import { curriculumPlacedBelow } from './curriculum.practice.js';

export type CurriculumPathStep = {
  id: string;
  complete: boolean;
  skipped: boolean;
  available: boolean;
  batch?: number;
};
export function activityUnit(id: string) {
  const [kind, key] = id.split(':');
  if (['teacher', 'post', 'introduce'].includes(kind!))
    return lessonById.get(key!)?.unit ?? (unitById.has(key!) ? key : undefined);
  if (['words', 'text', 'gate', 'unit'].includes(kind!))
    return unitById.has(key!) ? key : undefined;
  if (kind === 'unseen')
    return content.unseen.find((item) => item.id === key)?.proposed_unit_block.at(-1);
  return undefined;
}
export function activitySkipped(state: CurriculumState, id: string) {
  return Boolean(
    state.pathChoices?.activities.includes(id) ||
      state.pathChoices?.units.includes(activityUnit(id) ?? ''),
  );
}
export function curriculumPathSteps(state: CurriculumState, unitId: string): CurriculumPathStep[] {
  const unit = unitById.get(unitId);
  if (!unit) return [];
  const targets = allTargets.filter((target) => target.unit === unitId);
  const steps: CurriculumPathStep[] = [];
  const add = (id: string, complete: boolean, available = true, batch?: number) => {
    const dependentSkip =
      id.startsWith('post:') &&
      !complete &&
      !state.completed[`teacher:${id.slice(5)}`] &&
      activitySkipped(state, `teacher:${id.slice(5)}`);
    steps.push({
      id,
      complete,
      skipped:
        !complete &&
        (activitySkipped(state, id) ||
          dependentSkip ||
          Boolean(state.pathChoices?.units.includes(unitId))),
      available,
      ...(batch === undefined ? {} : { batch }),
    });
  };
  content.lessons
    .filter((lesson) => lesson.unit === unitId)
    .forEach((lesson, index) => {
      const group = targets.filter((target) =>
        lesson.targets.some((item) => item.en.toLowerCase() === target.en.toLowerCase()),
      );
      add(
        `introduce:${lesson.id}`,
        group.length > 0 && group.every((target) => state.words[target.id]),
        true,
        index,
      );
      add(`teacher:${lesson.id}`, Boolean(state.completed[`teacher:${lesson.id}`]));
      add(
        `post:${lesson.id}`,
        Boolean(state.completed[`post:${lesson.id}`]),
        Boolean(state.completed[`teacher:${lesson.id}`]),
      );
    });
  if (targets.length > 12)
    add(
      `introduce:${unitId}`,
      targets.every((target) => state.words[target.id]),
      true,
      Math.floor(
        Math.max(
          0,
          targets.findIndex((target) => !state.words[target.id]),
        ) / 6,
      ),
    );
  for (const mode of ['recognition', 'recall', 'listening', 'context'])
    add(
      `words:${unitId}:${mode}`,
      targets.length > 0 &&
        targets.every(
          (target) =>
            (state.words[target.id]?.practiceModes?.[mode] ??
              (mode === 'recognition' ? state.words[target.id]?.practiceModes?.matching : 0) ??
              0) > 0,
        ),
    );
  const index = content.units.indexOf(unit);
  const phonics = index < 6 ? (index + 1) * 2 : index < 18 ? index + 7 : 0;
  if (state.literacy !== 'independent' && !state.placement.decoding?.independent)
    for (const session of content.phonics.slice(0, phonics))
      add(`phonics:${session.id}`, Boolean(state.completed[`phonics:${session.id}`]));
  add(`text:${unitId}`, Boolean(state.completed[`text:${unitId}`]));
  add(`gate:${unitId}`, Boolean(state.completed[`gate:${unitId}`]));
  const unseen = content.unseen.find((test) => test.proposed_unit_block.at(-1) === unitId);
  if (unseen) add(`unseen:${unseen.id}`, Boolean(state.completed[`unseen:${unseen.id}`]));
  if (unitId === content.units.at(-1)?.id)
    for (const skill of ['reading', 'listening', 'speaking', 'writing'])
      add(`exit:${skill}`, Boolean(state.completed[`exit:${skill}`]));
  return steps;
}
export function curriculumGraduationReady(state: CurriculumState) {
  return (
    content.units.every(
      (unit) => state.completed[`gate:${unit.id}`] || curriculumPlacedBelow(state, unit.band),
    ) &&
    content.unseen.every(
      (test) => state.completed[`unseen:${test.id}`] || curriculumPlacedBelow(state, test.band),
    )
  );
}
export function nextPathUnit(state: CurriculumState) {
  return content.units.find((unit) => {
    if (curriculumPlacedBelow(state, unit.band)) return false;
    if (state.pathChoices?.units.includes(unit.id)) return false;
    const steps = curriculumPathSteps(state, unit.id);
    const unseen = content.unseen.find((test) => test.proposed_unit_block.at(-1) === unit.id);
    if (
      state.completed[`gate:${unit.id}`] &&
      (!unseen ||
        state.completed[`unseen:${unseen.id}`] ||
        activitySkipped(state, `unseen:${unseen.id}`))
    )
      return false;
    return steps.some((step) => !step.complete && !step.skipped);
  });
}
