import { z } from 'zod';
import { privateLessonInputSchema } from '../private-lessons/private-lesson.validation.js';
import type { PrivateLessonPlan } from '../private-lessons/private-lesson.prompt.js';
import {
  buildRealtimeLessonContract,
  type RealtimeDefaults,
} from '../private-lessons/private-lesson.realtime.js';
import { promptContentSchema } from './admin.prompt-config.js';

export const promptPreviewSchema = z
  .object({
    content: promptContentSchema,
    sample: z
      .object(privateLessonInputSchema.shape)
      .omit({ courseId: true, packId: true, station: true, interactionMode: true })
      .strict(),
  })
  .strict();
export function previewRealtimePrompt(
  input: z.infer<typeof promptPreviewSchema>,
  defaults: RealtimeDefaults,
) {
  const request = privateLessonInputSchema.parse({
    ...input.content.realtime?.lessonDefaults,
    ...input.sample,
  });
  const plan: PrivateLessonPlan = {
    id: '00000000-0000-4000-8000-000000000001',
    durationSeconds: (request.requestedDurationMinutes ?? 10) * 60,
    targetLanguageCode: request.targetLanguageCode,
    supportLanguageCode: request.supportLanguageCode ?? null,
    lessonMode: request.lessonMode ?? 'standard',
    teachingLanguage:
      request.teachingLanguage ??
      (request.lessonMode === 'absolute_beginner' ? 'support' : 'target'),
    level: request.requestedLevel ?? 'A1',
    topic: request.topic ?? 'Ordering food',
    grammarFocus: request.grammarFocus ?? null,
    focusAreas: request.focusAreas ?? ['speaking'],
    customFocus: request.customFocus ?? null,
    correctionMode: request.correctionMode ?? 'recast',
    vocabularyMode: request.vocabularyMode ?? 'none',
    teacherVoice: request.teacherVoice ?? 'female',
    speechRate: request.speechRate ?? 'normal',
    interests: [],
    targets: [],
    continuity: null,
  };
  if (
    (plan.teachingLanguage === 'support' || plan.lessonMode === 'absolute_beginner') &&
    !plan.supportLanguageCode
  )
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['sample', 'supportLanguageCode'],
        message: 'A support teaching language requires a support language',
      },
    ]);
  const contract = buildRealtimeLessonContract(plan, defaults, input.content);
  return {
    kind: 'synthetic-preview',
    note: 'תצוגת טיוטה עם נתוני דוגמה בלבד. נעשה שימוש באותו מרכיב הרכבה כמו בשיעור חי. ללא פרופיל, קורס, מילים, שיעור קודם או יצירת תוכן ב-AI; נתונים אלו מתווספים בזמן שיעור אמיתי. לא בוצעה קריאה ל-OpenAI.',
    browserRequest: {
      method: 'POST',
      path: '/api/v1/private-lessons/realtime-sessions',
      body: input.sample,
    },
    resolvedRequest: request,
    resolvedLesson: plan,
    providerRequest: {
      method: 'POST',
      url: 'https://api.openai.com/v1/realtime/client_secrets',
      body: { session: contract.session },
    },
    clientEvents: contract.events,
    baseSections: contract.baseSections,
    expected: {
      createSession: {
        description: 'הרשאה זמנית לפתיחת השיחה; אינה תשובת המורה.',
        fields: [
          'value: temporary secret (server only with call guard)',
          'expires_at: Unix seconds',
          'session: provider configuration',
        ],
      },
      browserResponse: {
        fields: [
          'lesson: resolved lesson plan',
          'realtime.clientSecret: one-use GotIt ticket',
          'realtime.connectionUrl: /api/v1/realtime/connect',
          'realtime.openingEvent',
          'realtime.continuationEvent',
          'realtime.wrapUpEvent',
          'realtime.translationEvent',
        ],
      },
      connection: {
        request: 'POST /api/v1/realtime/connect; Content-Type: application/sdp; body: SDP offer',
        response: 'SDP answer; microphone and teacher audio stream over WebRTC',
      },
      events: [
        { type: 'session.created', meaning: 'השיחה מוכנה; מתקבלת הגדרת session.' },
        { type: 'input_audio_buffer.speech_started', meaning: 'התחיל דיבור מזוהה של הלומד.' },
        {
          type: 'input_audio_buffer.speech_stopped',
          meaning: 'זוהה סיום דיבור; הזיהוי אינו ציון או הוכחת הבנה.',
        },
        {
          type: 'conversation.item.input_audio_transcription.completed',
          meaning: 'תמלול דברי הלומד.',
          fields: ['item_id', 'transcript'],
        },
        { type: 'response.created', meaning: 'המורה התחיל לייצר תשובה.', fields: ['response.id'] },
        {
          type: 'response.output_audio_transcript.delta',
          meaning: 'חלק נוסף של טקסט תשובת המורה.',
          fields: ['delta', 'item_id'],
        },
        {
          type: 'response.output_audio_transcript.done',
          meaning: 'התמלול המלא של תור המורה.',
          fields: ['transcript', 'item_id'],
        },
        {
          type: 'response.done',
          meaning: 'יצירת התשובה הסתיימה; ניגון האודיו עשוי עדיין להימשך.',
          fields: ['response.status'],
        },
        {
          type: 'error',
          meaning: 'שגיאת ספק; הממשק צריך להציג כשל ולא תשובה מומצאת.',
          fields: ['error.type', 'error.code', 'error.message'],
        },
      ],
      completion:
        'POST /api/v1/private-lessons/:id/complete: actualDurationSeconds + turns. A separate report model generates the journal report; Realtime does not update learning scores directly.',
    },
  };
}
