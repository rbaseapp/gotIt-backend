import type { CefrLevel } from '../profile/profile.types.js';
import type { LessonMaterial } from '../courses/lesson-material.schema.js';

export type TeacherStation = 'supported' | 'midpoint' | 'review';
export type StationSettings = Partial<
  Record<TeacherStation, { requiredWords: number; durationMinutes: number }>
>;

export function supportsTeacherStations(topicSlug: string, source: string, translation: string) {
  return (
    ['daily-english', 'english-learning-path-en-he'].includes(topicSlug) &&
    source === 'en' &&
    translation === 'he'
  );
}

export function teacherStations(total: number, introduced: number, settings?: StationSettings) {
  return (
    [
      { station: 'supported', requiredWords: Math.min(10, total), durationMinutes: 5 },
      { station: 'midpoint', requiredWords: Math.ceil(total / 2), durationMinutes: 5 },
      { station: 'review', requiredWords: total, durationMinutes: 10 },
    ] as const
  ).map((step) => ({
    ...step,
    requiredWords: settings?.[step.station]?.requiredWords ?? step.requiredWords,
    durationMinutes: settings?.[step.station]?.durationMinutes ?? step.durationMinutes,
    available:
      total > 0 && introduced >= (settings?.[step.station]?.requiredWords ?? step.requiredWords),
  }));
}

export type LessonUnit = {
  readingSteps?: import('./unit-reading.js').UnitReading[];
  material?: LessonMaterial;
  materials?: Partial<Record<TeacherStation, LessonMaterial>>;
  packId: string;
  title: string;
  moduleNumber: number;
  targetLanguageCode: string;
  supportLanguageCode: string;
  level: CefrLevel;
  station: TeacherStation;
  introduced: number;
  completed: number;
  total: number;
  teacherStations: ReturnType<typeof teacherStations>;
  words: Array<{
    sourceText: string;
    translationText: string;
    exampleText: string | null;
    introduced: boolean;
    learningItemId: string | null;
  }>;
  stageWords?: LessonUnit['words'];
  stageWordsByStation?: Partial<Record<TeacherStation, LessonUnit['words']>>;
};

export function currentWordStage(total: number, introduced: number, settings?: StationSettings) {
  const thresholds = [
    ...new Set(teacherStations(total, introduced, settings).map((step) => step.requiredWords)),
  ];
  const end = thresholds.find((threshold) => introduced < threshold) ?? total;
  const start = thresholds.filter((threshold) => threshold < end).at(-1) ?? 0;
  return { start, end };
}
