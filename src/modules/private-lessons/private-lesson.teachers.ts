// Keep the existing preference keys compatible with saved lessons and clients.
export const privateLessonTeachers = {
  female: { name: 'Rachel', voice: 'marin' },
  male: { name: 'Mike', voice: 'cedar' },
} as const;

// Rachel already has a matching portrait set and Realtime voice. Keep the
// child course on that identity until a dedicated child tutor asset exists.
export const childCourseTeacherVoice = 'female' as const;
