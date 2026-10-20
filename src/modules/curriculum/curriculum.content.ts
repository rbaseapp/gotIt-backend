import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const PROGRAM_ID = 'english-zero-c1';
export const PROGRAM_VERSION = '2026-10-21.1';
export const BANDS = ['Pre-A1', 'A1', 'A2', 'B1', 'B2', 'C1'] as const;
export type Band = (typeof BANDS)[number];
export type Target = {
  id: string;
  en: string;
  he: string;
  unit: string;
  band: Band;
  track: string;
};
export type Question = {
  number?: number;
  kind?: string;
  type?: string;
  prompt_he?: string;
  prompt_en?: string;
  question_he?: string;
  question_en?: string;
  answer?: string;
  answer_en?: string;
  answer_he?: string;
  answer_anchor_en?: string;
  hint_he?: string;
  feedback_he?: string;
  rubric_he?: string;
  audio_text_en?: string;
  listening_text_en?: string;
  [key: string]: unknown;
};
export type Unit = {
  id: string;
  band: Band;
  title_he: string;
  goal_he: string;
  grammar_he: string;
  targets: Array<{ en: string; he: string }>;
  coverage_targets: unknown[];
  support_glossary: unknown[];
  dialogue: Array<{ speaker: string; text_en: string; text_he: string }>;
  passage_en: string;
  passage_questions: Question[];
  roleplay_prompt_he: string;
  model_response_en: string;
  writing_prompt_he: string;
  language_focus: Record<string, unknown>;
};
export type Lesson = {
  id: string;
  unit: string;
  band: Band;
  title_he: string;
  planned_minutes: number;
  targets: Array<{ en: string; he: string }>;
  teacher_script: Array<Record<string, unknown>>;
  branches: Record<string, string>;
  postlesson: Question[];
  postlesson_minutes: unknown;
};
export type Phonics = {
  id: string;
  title_he: string;
  mappings: Array<{ grapheme: string; phoneme: string; example: string }>;
  decodable_words: string[];
  decodable_sentence: string;
  teacher_script_he: string[];
  exercises: Question[];
  irregular_words: unknown[];
  duration_minutes_proposed: number;
  caution_he: string;
  decodability_he: string;
  oral_chunk_en: string;
};
export type Unseen = {
  id: string;
  band: Band;
  title_he: string;
  passage_en: string;
  questions: Question[];
  proposed_unit_block: string[];
  writing_prompt_he: string;
  speaking_prompt_he: string;
};
export const content = JSON.parse(
  readFileSync(resolve('assets/english-zero-c1/curriculum.json'), 'utf8'),
) as {
  units: Unit[];
  lessons: Lesson[];
  phonics: Phonics[];
  unseen: Unseen[];
  policies: Record<string, unknown>;
  evidence: unknown[];
};
export const lexicon = JSON.parse(
  readFileSync(resolve('assets/english-zero-c1/lexicon.json'), 'utf8'),
) as {
  targets: Target[];
  academic_elective: unknown[];
};
export const unitById = new Map(content.units.map((unit) => [unit.id, unit]));
export const lessonById = new Map(content.lessons.map((lesson) => [lesson.id, lesson]));
export const electiveTargets: Target[] = lexicon.academic_elective.map((raw, index) => {
  const item = raw as { en: string; definition_en: string };
  return {
    id: `E${String(index + 1).padStart(4, '0')}`,
    en: item.en,
    he:
      item.definition_en ||
      (item.en === 'descendent' ? 'a later member of the same family line' : ''),
    unit: 'C1E',
    band: 'C1',
    track: 'academic_elective',
  };
});
export const allTargets = [...lexicon.targets, ...electiveTargets];
export const targetById = new Map(allTargets.map((target) => [target.id, target]));
unitById.set('C1E', {
  ...content.units.find((unit) => unit.band === 'C1')!,
  id: 'C1E',
  title_he: 'אוצר מילים אקדמי לבחירה',
  goal_he: 'לומדים מילים אקדמיות באמצעות הגדרות באנגלית, בהקשר שנבחר. המסלול אינו תנאי לסיום C1.',
  targets: [],
  coverage_targets: [],
  support_glossary: [],
  dialogue: [],
  passage_en: '',
  passage_questions: [],
  roleplay_prompt_he: '',
  model_response_en: '',
  writing_prompt_he: '',
  grammar_he: 'בחירה לפי תחומי עניין ומשמעות בהקשר.',
  language_focus: {},
});
export const exitAssessment = JSON.parse(
  readFileSync(resolve('assets/english-zero-c1/exit-assessment.json'), 'utf8'),
) as {
  reading: { title: string; passage: string; questions: Question[] };
  listening: { title: string; passage: string; questions: Question[] };
  speaking: Question[];
  writing: Question[];
};
export const normalize = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘]/gu, "'")
    .replace(/[^\p{L}\p{N}'/æɑɒɔəɛɜɪʊʌθðŋʃʒː -]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
export function questionAudio(question: Question) {
  const cue = (question.prompt_he ?? '')
    .match(/\[audio:([^\]]*)\]/gu)
    ?.map((item) => item.slice(7, -1).trim())
    .join(' ');
  const text = String(
    question.audio_script_en ??
      question.audio_text_en ??
      question.listening_text_en ??
      cue ??
      question.passage_en ??
      '',
  );
  return (
    text
      .match(/[\s\S]{1,1000}(?:\s|$)/gu)
      ?.map((part) => part.trim())
      .filter(Boolean) ?? (text ? [text] : [])
  );
}

// These are learner projections, not JSON key blacklists. Author answer keys never leave this module.
export function questionView(question: Question, id: string) {
  return {
    id,
    kind: question.kind ?? question.type ?? 'comprehension',
    prompt: question.prompt_he ?? question.question_he ?? '',
    text: question.prompt_en ?? question.question_en ?? null,
    hasAudio: questionAudio(question).length > 0,
    audioParts: questionAudio(question).length,
    hasHint: Boolean(question.hint_he),
  };
}
