import type { CefrLevel } from '../profile/profile.types.js';

export const privateLessonGoalKinds = ['recommended', 'communication', 'grammar'] as const;
export type PrivateLessonGoalKind = (typeof privateLessonGoalKinds)[number];

export const communicationGoals = [
  'everyday-conversation',
  'workplace-communication',
  'travel-confidence',
  'job-interviews',
  'presentations',
] as const;

export type CommunicationGoalKey = (typeof communicationGoals)[number];

export const grammarTopics = [
  { key: 'present-simple-continuous', cefr: 'A1', prerequisites: [] },
  { key: 'past-simple-continuous', cefr: 'A2', prerequisites: ['present-simple-continuous'] },
  { key: 'verb-forms-v1-v2-v3', cefr: 'A2', prerequisites: ['past-simple-continuous'] },
  { key: 'prepositions', cefr: 'A2', prerequisites: ['present-simple-continuous'] },
  { key: 'future-forms', cefr: 'A2', prerequisites: ['present-simple-continuous'] },
  { key: 'modal-verbs', cefr: 'B1', prerequisites: ['present-simple-continuous'] },
  { key: 'gerund-infinitive', cefr: 'B1', prerequisites: ['verb-forms-v1-v2-v3'] },
  { key: 'conditionals', cefr: 'B1', prerequisites: ['past-simple-continuous', 'modal-verbs'] },
  { key: 'passive-voice', cefr: 'B1', prerequisites: ['verb-forms-v1-v2-v3'] },
  {
    key: 'advanced-sentence-structure',
    cefr: 'B2',
    prerequisites: ['conditionals', 'gerund-infinitive'],
  },
] as const satisfies readonly { key: string; cefr: CefrLevel; prerequisites: readonly string[] }[];

export type GrammarTopicKey = (typeof grammarTopics)[number]['key'];
export type PrivateLessonGoalKey =
  | CommunicationGoalKey
  | GrammarTopicKey
  | 'recommended-foundation';
export type RoadmapStage =
  | 'foundation'
  | 'guided-use'
  | 'controlled-conversation'
  | 'free-conversation'
  | 'independent-mastery';

export type RoadmapBlueprint = {
  goalKind: PrivateLessonGoalKind;
  goalKey: PrivateLessonGoalKey;
  goalTitle: string;
  recommendedReason: string;
  milestones: {
    key: RoadmapStage;
    title: string;
    description: string;
    communicationObjective: string;
    grammarTopics: GrammarTopicKey[];
    successCriteria: { minimumLessons: number; targetScore: number };
  }[];
};

const communicationSequences: Record<CommunicationGoalKey, GrammarTopicKey[]> = {
  'everyday-conversation': [
    'present-simple-continuous',
    'past-simple-continuous',
    'prepositions',
    'future-forms',
    'modal-verbs',
  ],
  'workplace-communication': [
    'present-simple-continuous',
    'modal-verbs',
    'past-simple-continuous',
    'passive-voice',
    'advanced-sentence-structure',
  ],
  'travel-confidence': [
    'present-simple-continuous',
    'prepositions',
    'modal-verbs',
    'past-simple-continuous',
    'future-forms',
  ],
  'job-interviews': [
    'present-simple-continuous',
    'past-simple-continuous',
    'verb-forms-v1-v2-v3',
    'modal-verbs',
    'conditionals',
  ],
  presentations: [
    'future-forms',
    'passive-voice',
    'modal-verbs',
    'conditionals',
    'advanced-sentence-structure',
  ],
};

const stageKeys: RoadmapStage[] = [
  'foundation',
  'guided-use',
  'controlled-conversation',
  'free-conversation',
  'independent-mastery',
];
const titleFor = (key: string) =>
  key
    .split('-')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');

export function recommendedGoal(level: CefrLevel): {
  goalKind: 'grammar';
  goalKey: GrammarTopicKey;
  reason: string;
} {
  const levelRank = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].indexOf(level);
  const topic =
    grammarTopics.find(
      (item) => ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].indexOf(item.cefr) >= Math.max(0, levelRank),
    ) ?? grammarTopics.at(-1)!;
  return {
    goalKind: 'grammar',
    goalKey: topic.key,
    reason: `A practical next step for level ${level}`,
  };
}

export function buildRoadmapBlueprint(
  goalKind: PrivateLessonGoalKind,
  goalKey: string,
  level: CefrLevel,
): RoadmapBlueprint {
  const recommended = recommendedGoal(level);
  const resolvedKind = goalKind === 'recommended' ? recommended.goalKind : goalKind;
  const resolvedKey = goalKind === 'recommended' ? recommended.goalKey : goalKey;
  if (resolvedKind === 'grammar') {
    const topic = grammarTopics.find((item) => item.key === resolvedKey);
    if (!topic) throw new Error('Unknown grammar goal');
    const prerequisite = (topic.prerequisites[0] as GrammarTopicKey | undefined) ?? topic.key;
    const sequence: GrammarTopicKey[] = [prerequisite, topic.key, topic.key, topic.key, topic.key];
    return blueprint(
      goalKind,
      goalKind === 'recommended' ? 'recommended-foundation' : topic.key,
      titleFor(topic.key),
      sequence,
      recommended.reason,
    );
  }
  if (!communicationGoals.includes(resolvedKey as CommunicationGoalKey))
    throw new Error('Unknown communication goal');
  const key = resolvedKey as CommunicationGoalKey;
  return blueprint(
    goalKind,
    key,
    titleFor(key),
    communicationSequences[key],
    `Build confident, reusable language for ${titleFor(key).toLowerCase()}`,
  );
}

function blueprint(
  goalKind: PrivateLessonGoalKind,
  goalKey: PrivateLessonGoalKey,
  goalTitle: string,
  sequence: GrammarTopicKey[],
  reason: string,
): RoadmapBlueprint {
  return {
    goalKind,
    goalKey,
    goalTitle,
    recommendedReason: reason,
    milestones: stageKeys.map((key, index) => ({
      key,
      title: titleFor(key),
      description: `Stage ${index + 1} of a progressive path toward ${goalTitle}`,
      communicationObjective: `${titleFor(key)}: use ${titleFor(sequence[index]!)} in meaningful spoken English`,
      grammarTopics: [sequence[index]!],
      successCriteria: { minimumLessons: 2, targetScore: 75 },
    })),
  };
}

export function privateLessonCurriculum(level: CefrLevel) {
  const recommended = recommendedGoal(level);
  return {
    recommended,
    communicationGoals: communicationGoals.map((key) => ({ key })),
    grammarTopics: grammarTopics.map((topic) => ({ ...topic })),
  };
}
