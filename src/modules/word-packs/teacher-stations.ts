import type { CefrLevel } from '../profile/profile.types.js';

export type TeacherStation = 'supported' | 'midpoint' | 'review';

export function teacherStations(total: number, introduced: number) {
  return (
    [
      { station: 'supported', requiredWords: Math.min(10, total), durationMinutes: 5 },
      { station: 'midpoint', requiredWords: Math.ceil(total / 2), durationMinutes: 5 },
      { station: 'review', requiredWords: total, durationMinutes: 10 },
    ] as const
  ).map((step) => ({
    ...step,
    available: total > 0 && introduced >= step.requiredWords,
  }));
}

export type LessonUnit = {
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
};
