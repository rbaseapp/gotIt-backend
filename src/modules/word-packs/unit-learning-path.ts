import type { LessonUnit } from './teacher-stations.js';
import type { StoredPrivateLesson } from '../private-lessons/private-lesson.repository.js';
import type { HomeworkDocument } from '../courses/course.schemas.js';
import { publicHomework } from '../courses/course.service.js';

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
    const available = station.available && precedingComplete;
    const result = {
      ...station,
      available,
      meetingCompleted: Boolean(lesson),
      preparationComplete,
      lessonId: lesson?.id ?? null,
      homework,
      lockReason: available ? null : !precedingComplete ? 'previous_preparation' : 'words',
    };
    precedingComplete = precedingComplete && preparationComplete;
    return result;
  });
  const pendingPractice = stations.find(
    (station) => station.meetingCompleted && !station.preparationComplete,
  );
  const nextStation = stations.find((station) => !station.meetingCompleted && station.available);
  const currentStage =
    pendingPractice ?? stations.find((station) => !station.meetingCompleted) ?? stations.at(-1);
  return {
    packId: unit.packId,
    words:
      (currentStage && unit.stageWordsByStation?.[currentStage.station]) ??
      unit.stageWords ??
      unit.words,
    stations,
    nextAction: pendingPractice
      ? {
          kind: 'homework' as const,
          station: pendingPractice.station,
          homeworkId: pendingPractice.homework?.id ?? null,
        }
      : nextStation
        ? { kind: 'meeting' as const, station: nextStation.station, homeworkId: null }
        : { kind: 'words' as const, station: null, homeworkId: null },
  };
}
