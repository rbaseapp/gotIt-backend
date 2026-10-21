import type { LessonUnit } from './teacher-stations.js';
import type { StoredPrivateLesson } from '../private-lessons/private-lesson.repository.js';
import type { HomeworkDocument } from '../courses/course.schemas.js';
import { publicHomework } from '../courses/course.service.js';
import { emptyUnitPathChoices, type UnitPathChoices, type UnitStep } from './unit-path-choices.js';

/** A report being generated, a greeting or an interrupted call is not a completed meeting. */
export function completedUnitMeeting(lesson: StoredPrivateLesson) {
  return (
    lesson.status === 'completed' &&
    Boolean(lesson.report) &&
    lesson.report!.assessment.lessonPerformance.evidenceQuality !== 'insufficient'
  );
}

export function buildUnitLearningPath(
  unit: LessonUnit,
  lessons: StoredPrivateLesson[],
  assignments: HomeworkDocument[],
  choices: UnitPathChoices = emptyUnitPathChoices(unit.packId),
) {
  // Keep the first genuine completion as the checkpoint. Repeating a meeting must not
  // replace its homework or reset progression that has already been earned.
  const completed = lessons
    .filter((lesson) => lesson.wordPack?.packId === unit.packId && completedUnitMeeting(lesson))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  let precedingComplete = true;
  const stations = unit.teacherStations.map((station) => {
    const candidates = completed.filter((item) => item.wordPack?.station === station.station);
    const lesson =
      candidates.find((item) =>
        assignments.some((assignment) => assignment.lessonId === item.id),
      ) ?? candidates[0];
    const assignment = lesson && assignments.find((item) => item.lessonId === lesson.id);
    const homework = assignment ? publicHomework(assignment) : null;
    const preparationComplete = Boolean(lesson && homework?.status === 'completed');
    const recommended = station.available && precedingComplete;
    const result = {
      ...station,
      available: unit.total > 0,
      recommended,
      meetingCompleted: Boolean(lesson),
      preparationComplete,
      lessonId: lesson?.id ?? null,
      homework,
      lockReason: null,
      recommendationReason: recommended
        ? null
        : !precedingComplete
          ? 'previous_preparation'
          : 'words',
    };
    precedingComplete = precedingComplete && preparationComplete;
    return result;
  });
  const steps = stations.flatMap((station) =>
    (['words', 'meeting', 'homework'] as const).map((kind) => {
      const key = `${station.station}:${kind}` as UnitStep;
      const complete =
        kind === 'words'
          ? unit.introduced >= station.requiredWords
          : kind === 'meeting'
            ? station.meetingCompleted
            : station.preparationComplete;
      return {
        key,
        kind,
        station: station.station,
        complete,
        skipped:
          !complete &&
          (Boolean(choices.unitSkipped) ||
            choices.skippedSteps.includes(key) ||
            (kind === 'homework' &&
              !station.meetingCompleted &&
              choices.skippedSteps.includes(`${station.station}:meeting`))),
        available: kind !== 'homework' || Boolean(station.homework && station.meetingCompleted),
        homeworkId: kind === 'homework' ? (station.homework?.id ?? null) : null,
      };
    }),
  );
  const next = steps.find((step) => !step.complete && !step.skipped);
  const currentStage =
    stations.find((station) => station.station === next?.station) ?? stations.at(-1);
  return {
    packId: unit.packId,
    navigationRevision: choices.revision,
    steps,
    navigationComplete: !next,
    skippedSteps: steps.filter((step) => step.skipped).length,
    words:
      (currentStage && unit.stageWordsByStation?.[currentStage.station]) ??
      unit.stageWords ??
      unit.words,
    stations,
    nextAction: next
      ? { kind: next.kind, station: next.station, homeworkId: next.homeworkId }
      : { kind: 'words' as const, station: null, homeworkId: null },
  };
}
