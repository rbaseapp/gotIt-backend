import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  ProfileScope,
  ProfileServiceContract,
} from '../../src/modules/profile/profile.types.js';
import type { CourseGenerator } from '../../src/modules/courses/course.provider.js';
import type {
  CourseDocument,
  CoursePlan,
  CoursePreferences,
  HomeworkDocument,
  LearningDocument,
} from '../../src/modules/courses/course.schemas.js';
import {
  courseConflict,
  type LearningDocumentStore,
} from '../../src/modules/courses/course.repository.js';
import { syllabusFor } from '../../src/modules/courses/course.curriculum.js';

export const scope: ProfileScope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
export const preferences: CoursePreferences = {
  targetLanguageCode: 'en',
  supportLanguageCode: 'he',
  path: 'grammar',
  goal: 'להשתמש בדקדוק בשיחה',
  experience: 'מתחילים מהיסודות',
  startingLevel: 'A1',
  absoluteBeginner: true,
  ageGroup: 'adult',
  literacy: 'independent',
  minutesPerLesson: 10,
  daysPerWeek: 3,
  interests: ['נסיעות'],
  statedNeeds: ['דקדוק שיטתי'],
  recommendations: ['תרגול קצר אחרי כל שיעור'],
};
export const plan: CoursePlan = {
  title: 'דקדוק אנגלי בשיחה',
  outcome: 'משפטים בטוחים ומדויקים',
  scope: 'יסודות, מבנים מתקדמים ושימוש בשיחה',
  changeSummary: 'תוכנית מסודרת מהיסודות',
  units: ['foundation', 'intermediate', 'advanced'].map((key, index) => ({
    key,
    title: ['משפטים ראשונים', 'מספרים על חוויות', 'מביעים רעיונות מורכבים'][index]!,
    outcome: 'לבנות משפטים בהקשר',
    level: (['A1', 'B1', 'C1'] as const)[index]!,
    prerequisites: index ? [['foundation', 'intermediate'][index - 1]!] : [],
    syllabusKeys: syllabusFor(preferences)
      .topics.slice(index * 8, index * 8 + 8)
      .map((topic) => topic.key),
    grammar: ['מבנה משפט'],
    vocabulary: ['חיי היום יום'],
    lessons: [
      { title: 'מכירים מבנה', objective: 'להציג את עצמי' },
      { title: 'משתמשים במבנה', objective: 'לדבר באופן עצמאי' },
    ],
    estimatedMinutes: 20,
    homeworkExample: 'בנו משפט היכרות',
    successTask: 'הצגה עצמית עצמאית',
  })),
};
export function courseFixture(): CourseDocument {
  return {
    kind: 'course',
    id: randomUUID(),
    revision: 0,
    createdAt: new Date().toISOString(),
    preferences: structuredClone(preferences),
    approvedPreferences: null,
    preferencesApprovedAt: null,
    ready: true,
    messages: [],
    suggestions: [],
    versions: [],
    draftVersion: null,
    activeVersion: null,
    evidence: [],
  };
}
export function homeworkFixture(): HomeworkDocument {
  return {
    kind: 'homework',
    id: randomUUID(),
    revision: 0,
    createdAt: new Date().toISOString(),
    lessonId: randomUUID(),
    course: null,
    targetLanguageCode: 'en',
    supportLanguageCode: 'he',
    title: 'משפטי היכרות',
    source: { report: {}, turns: [{ role: 'tutor', text: 'I am at home.' }] },
    content: {
      title: 'תרגול קצר',
      objective: 'שימוש ב־be',
      estimatedMinutes: 3,
      tasks: ['transform', 'choice'].map((kind) => ({
        kind: kind as 'transform' | 'choice',
        objective: 'שימוש ב־be',
        prompt: 'Change I to We: I am at home.',
        sourceQuote: 'I am at home.',
        choices: kind === 'choice' ? ['We is at home.', 'We are at home.'] : [],
        tokens: [],
        listeningText: null,
        hint: 'Think about the subject.',
        explanation: 'We takes are.',
        expectedAnswer: 'We are at home.',
        acceptedAnswers: ['We are at home.', "We're at home."],
      })),
    },
    progress: [0, 1].map(() => ({ attempts: [], hintUsed: false, done: false, draft: '' })),
  };
}
export class MemoryLearningStore implements LearningDocumentStore {
  documents = new Map<string, LearningDocument>();
  receipts = new Map<string, { fingerprint: string; document: LearningDocument }>();
  key(scope: ProfileScope, id: string) {
    return `${scope.applicationId}:${scope.applicationUserId}:${id}`;
  }
  async get(scope: ProfileScope, id: string) {
    return structuredClone(this.documents.get(this.key(scope, id)) ?? null);
  }
  async list(scope: ProfileScope, kind: 'course' | 'homework') {
    return structuredClone(
      [...this.documents.entries()]
        .filter(([key, d]) => key.startsWith(this.key(scope, '')) && d.kind === kind)
        .map(([, d]) => d),
    );
  }
  async replay(scope: ProfileScope, event: string, fingerprint: string) {
    const receipt = this.receipts.get(this.key(scope, event));
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint) throw courseConflict();
    return structuredClone(receipt.document);
  }
  async save(
    scope: ProfileScope,
    document: LearningDocument,
    expected: number | null,
    event: string,
    fingerprint: string,
  ) {
    const replay = await this.replay(scope, event, fingerprint);
    if (replay) return replay;
    const previous = this.documents.get(this.key(scope, document.id));
    if (expected === null ? previous : previous?.revision !== expected) throw courseConflict();
    const next = structuredClone({ ...document, revision: expected === null ? 0 : expected + 1 });
    this.documents.set(this.key(scope, document.id), next);
    this.receipts.set(this.key(scope, event), { fingerprint, document: structuredClone(next) });
    return structuredClone(next);
  }
  seed(document: LearningDocument) {
    this.documents.set(this.key(scope, document.id), structuredClone(document));
  }
}
export const profiles: ProfileServiceContract = {
  async getProfile() {
    return {
      defaultSourceLanguage: 'en',
      defaultTranslationLanguage: 'he',
      timezone: 'Asia/Jerusalem',
      dailyGoal: { type: 'minutes', value: 10 },
      defaultNewItemsPerDay: 5,
      translationMethodPreference: 'auto',
      languages: [],
      interests: [],
    };
  },
  async patchProfile() {
    return this.getProfile(scope);
  },
};
export class FixtureGenerator implements CourseGenerator {
  calls: string[] = [];
  handler?: (name: string, data: unknown) => Promise<unknown>;
  async generate<T>(
    _scope: ProfileScope,
    schema: z.ZodType<T>,
    name: string,
    _instruction: string,
    data: unknown,
  ): Promise<T> {
    this.calls.push(name);
    const result = this.handler
      ? await this.handler(name, data)
      : name === 'course_plan'
        ? plan
        : name === 'course_intake' || name === 'course_intake_revision'
          ? {
              message: (data as { step?: number }).step === undefined
                ? 'מה חשוב לך ללמוד?'
                : [
                    'נשמע שהמטרה חשובה לך. מה כבר יצא לך ללמוד?',
                    'יש לך קצת רקע. בן כמה אתה, והאם נוח לך לקרוא?',
                    'תודה ששיתפת. אילו נושאים מעניינים אותך?',
                    'מעניין! איך נוח לך ללמוד ולתרגל?',
                    'מה יתאים לך מבחינת אורך שיעור וזמן בשבוע?',
                    'תודה, בוא נעבור יחד על הפרטים לפני בניית הקורס.',
                  ][(data as { step: number }).step],
              suggestions: ['לדבר', 'דקדוק', 'לא בטוח'],
              ready: true,
              preferences,
            }
          : name === 'course_intake_questions'
            ? {
                closing: 'סיימנו. אפשר לעבור על הפרטים לפני בניית התוכנית.',
                questions: [
                  'מה תרצה ללמוד לעשות בשפה החדשה?',
                  'מה כבר למדת בשפה הזאת?',
                  'בן כמה אתה, או לאיזו קבוצת גיל אתה שייך?',
                  'איך נוח לך לקרוא ולכתוב בשפה החדשה?',
                  'אילו נושאים מעניינים אותך?',
                  'כמה דקות מתאים לך לשיעור וכמה פעמים בשבוע?',
                ].map((question) => ({ question, suggestions: [] })),
              }
            : name === 'course_intake_questions_review'
              ? { valid: true, feedback: 'Clear interview' }
              : name === 'lesson_homework'
                ? homeworkFixture().content
                : name === 'lesson_homework_review'
                  ? { valid: true, feedback: 'Clear and grounded' }
                  : { result: 'retry', feedback: 'Try matching the subject.' };
    return schema.parse(result);
  }
  async transcribe() {
    return 'רוצה ללמוד מההתחלה';
  }
}
