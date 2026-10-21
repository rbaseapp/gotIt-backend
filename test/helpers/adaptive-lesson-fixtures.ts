import { randomUUID } from 'node:crypto';
import type { PrivateLessonPlan } from '../../src/modules/private-lessons/private-lesson.prompt.js';
import {
  lessonPlanningRequirements,
  type AdaptivePlan,
  type AdaptiveActivity,
} from '../../src/modules/private-lessons/private-lesson.planner.js';
export function adaptiveLesson(durationSeconds = 600): PrivateLessonPlan {
  return {
    id: randomUUID(),
    interactionProtocol: 'adaptive-v1',
    durationSeconds,
    targetLanguageCode: 'en',
    supportLanguageCode: 'he',
    lessonMode: 'standard',
    teachingLanguage: 'support',
    level: 'A2',
    topic: 'Travel',
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
  };
}
export function adaptiveCurriculum(lesson = adaptiveLesson()): AdaptivePlan {
  const count = lessonPlanningRequirements(lesson).minimumActivities;
  const kinds: AdaptiveActivity['kind'][] = [
    'meaning',
    'guided_use',
    'recall',
    'contrast',
    'information_gap',
    'role_play',
    'transfer',
  ];
  return {
    version: 'adaptive-v1',
    opening: 'נלמד לבקש מידע בטיול. Here is a model in a different situation.',
    exhaustedMessage: 'סיימנו את הפעילויות הזמינות. אפשר לסיים ולשמור את השיעור.',
    activities: Array.from({ length: count }, (_, i) => ({
      id: `task-${i}`,
      family: `operation-${i}`,
      objective: 'Ask for travel information',
      kind: kinds[i % kinds.length]!,
      route: i < 4 ? 'core' : i < 7 ? 'support' : 'extension',
      context: `Travel situation ${i}`,
      prompt: `Ask the traveller for the missing information in situation ${i}.`,
      hint: 'Think about which information you need, then ask for it.',
      criterion: `A meaningful original question about situation ${i}, accepting natural variants.`,
      requiredWords: [],
      estimatedSeconds: i === count - 1 ? 20 : Math.ceil((lesson.durationSeconds * 1.6) / count),
      independent: i !== 0,
    })),
  };
}
