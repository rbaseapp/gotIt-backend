import { randomUUID } from 'node:crypto';
import type {
  StoredPrivateLesson,
  PrivateLessonJournal,
} from '../../src/modules/private-lessons/private-lesson.repository.js';
import { basicPrivateLessonReport } from '../../src/modules/private-lessons/private-lesson.summary.js';
import {
  teacherStations,
  type LessonUnit,
  type TeacherStation,
} from '../../src/modules/word-packs/teacher-stations.js';
import { homeworkFixture, MemoryLearningStore, profiles, scope } from './course-fixtures.js';
import { CourseService } from '../../src/modules/courses/course.service.js';

export const unitFixture = (introduced = 50): LessonUnit => ({
  packId: '30000000-0000-4000-8000-000000000001',
  title: 'First sentences',
  moduleNumber: 1,
  targetLanguageCode: 'en',
  supportLanguageCode: 'he',
  level: 'A1',
  station: 'supported',
  introduced,
  completed: introduced,
  total: 50,
  teacherStations: teacherStations(50, introduced),
  words: [],
});
export function unitLesson(
  station: TeacherStation = 'supported',
  date = '2026-10-01T10:00:00.000Z',
): StoredPrivateLesson {
  const lesson: StoredPrivateLesson = {
    id: randomUUID(),
    durationSeconds: 300,
    targetLanguageCode: 'en',
    supportLanguageCode: 'he',
    lessonMode: 'standard',
    level: 'A1',
    topic: 'First sentences',
    grammarFocus: null,
    focusAreas: ['speaking'],
    customFocus: null,
    correctionMode: 'recast',
    vocabularyMode: 'none',
    teacherVoice: 'female',
    speechRate: 'normal',
    interests: [],
    targets: [],
    continuity: null,
    wordPack: { ...unitFixture(), station },
    status: 'completed',
    startedAt: date,
    endedAt: date,
    actualDurationSeconds: 300,
    report: null,
  };
  lesson.report = basicPrivateLessonReport(lesson);
  lesson.report.assessment.lessonPerformance.evidenceQuality = 'moderate';
  lesson.report.grammarPoints = [
    { topic: 'be', explanation: 'Match the subject', example: 'I am at home.' },
  ];
  return lesson;
}
export function unitAssignment(lesson: StoredPrivateLesson, done = false) {
  const homework = homeworkFixture();
  homework.id = lesson.id;
  homework.lessonId = lesson.id;
  homework.wordPack = { packId: lesson.wordPack!.packId, station: lesson.wordPack!.station };
  homework.source.report = lesson.report!;
  homework.progress.forEach((p) => {
    p.done = done;
  });
  return homework;
}
export function unitHistoryFixture(lessons: StoredPrivateLesson[]) {
  const journal: PrivateLessonJournal = {
    create: async () => {},
    get: async (_scope, id) => lessons.find((lesson) => lesson.id === id) ?? null,
    list: async () => lessons,
    unitHistory: async () => lessons,
    claim: async () => null,
    complete: async () => {
      throw new Error('unused');
    },
    fail: async () => {},
    remove: async () => false,
  };
  const store = new MemoryLearningStore();
  return {
    journal,
    store,
    courses: new CourseService(store, profiles, undefined, undefined, journal),
    seed: (identity = scope) =>
      lessons.forEach((lesson) =>
        store.documents.set(store.key(identity, lesson.id), unitAssignment(lesson, true)),
      ),
  };
}
