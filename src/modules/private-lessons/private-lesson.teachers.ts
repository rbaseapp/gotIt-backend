// Keep the existing preference keys compatible with saved lessons and clients.
export const privateLessonTeachers = {
  female: { name: 'Rachel', voice: 'marin' },
  male: { name: 'Mike', voice: 'cedar' },
} as const;

/** The name the tutor uses: a lesson may be hosted by a character such as Moochi. */
export const lessonTeacherName = (plan: {
  teacherName?: string;
  teacherVoice: keyof typeof privateLessonTeachers;
}) => plan.teacherName ?? privateLessonTeachers[plan.teacherVoice].name;

/** Moochi, the brain character who hosts the first chat, with his own Realtime voice. */
export const moochiName = 'Moochi';
export const moochiVoice = 'verse';

/**
 * The Realtime voice a lesson is spoken in. Moochi keeps his own voice; a teacher speaks in the
 * admin's override when one is set, else in their own.
 */
export const lessonTeacherVoice = (
  plan: { teacherName?: string; teacherVoice: keyof typeof privateLessonTeachers },
  override?: string,
) =>
  plan.teacherName === moochiName
    ? moochiVoice
    : (override ?? privateLessonTeachers[plan.teacherVoice].voice);

// Rachel already has a matching portrait set and Realtime voice. Keep the
// child course on that identity until a dedicated child tutor asset exists.
export const childCourseTeacherVoice = 'female' as const;

// Shared by planning, semantic review, assessment and the spoken tutor.
export const privateLessonIntroductionPolicy = `In greetings and introduction activities, the learner speaks as themselves using their own name or preferred name. If their name is unknown, ask them naturally as part of the introduction; never invent it or require a fictional name, identity or gender. The selected tutor uses teacherName when modelling a self-introduction. When a second named person is needed, use that same tutor and teacherName, with matching pronouns, rather than an unrelated character. Names in authored examples, previous lessons and sample answers are illustrative: adapt introduction practice to the actual participants while preserving its language objective. Accept a grammatically appropriate answer with the learner's own name; never mark it wrong for differing from a sample name. Keep a separate third-person character only when that distinction is necessary for the explicit objective; never make the learner adopt that character's identity. Reject introduction prompts or criteria that force an invented learner identity.`;
