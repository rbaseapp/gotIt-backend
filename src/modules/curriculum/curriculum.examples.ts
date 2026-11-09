import { hideAnswers } from '../practice/practice.cloze.js';
import type { Lesson, Unit } from './curriculum.content.js';

const MAX_WORDS = 22;

function sentences(text: string | undefined) {
  if (!text) return [];
  return [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)]
    .map(({ segment }) => segment.trim())
    .filter(Boolean);
}

/** True when the sentence can become a fill-in-the-gap prompt for this exact word. */
export function clozeable(sentence: string, word: string) {
  return hideAnswers(sentence, [word])?.includes('_____') ?? false;
}

const unitText = new WeakMap<Unit, { examples: Map<string, string[]>; rest: string[] }>();

/** Every English sentence a unit shows, split once and cached. */
function unitCorpus(unit: Unit, lessons: readonly Lesson[]) {
  let cached = unitText.get(unit);
  if (!cached) {
    const examples = new Map<string, string[]>();
    const other: string[] = [];
    for (const lesson of lessons)
      if (lesson.unit === unit.id)
        for (const phase of lesson.teacher_script ?? [])
          if (phase.phase === 'teach_target' && typeof phase.example_en === 'string') {
            const key = String(phase.target_en ?? '').toLowerCase();
            examples.set(key, [...(examples.get(key) ?? []), phase.example_en]);
            other.push(phase.example_en);
          }
    cached = {
      examples,
      rest: [
        ...unit.dialogue.flatMap((turn) => sentences(turn.text_en)),
        ...other,
        ...sentences(unit.passage_en),
        ...sentences(unit.model_response_en),
      ],
    };
    unitText.set(unit, cached);
  }
  return cached;
}

function unitSentences(word: string, unit: Unit, lessons: readonly Lesson[]) {
  const corpus = unitCorpus(unit, lessons);
  return [...(corpus.examples.get(word.toLowerCase()) ?? []), ...corpus.rest];
}

function pick(word: string, candidates: string[]) {
  const key = word.toLowerCase();
  const usable = candidates.filter(
    (sentence) =>
      !sentence.includes('{{') && sentence.toLowerCase().includes(key) && clozeable(sentence, word),
  );
  return usable.find((sentence) => sentence.split(/\s+/u).length <= MAX_WORDS) ?? usable[0];
}

/**
 * The English sentence the course uses to show a word in context: the word's own
 * unit first (the teacher's example for the word, dialogue, other examples,
 * reading passage, model answer), then the nearest other unit, earlier units
 * before later ones. Only sentences that contain the exact word (not a longer
 * word such as "affordable" for "afford") qualify, so the sentence game always
 * has a gap. Returns null when no course text uses the word.
 */
export function curriculumExample(
  word: string,
  unit: Unit,
  lessons: readonly Lesson[],
  units: readonly Unit[] = [unit],
) {
  const own = pick(word, unitSentences(word, unit, lessons));
  if (own) return own;
  const index = units.findIndex((item) => item.id === unit.id);
  const others = units
    .map((item, position) => ({ item, position }))
    .filter(({ item }) => item.id !== unit.id)
    .sort((a, b) => {
      const distance = (position: number) =>
        position < index ? (index - position) * 2 - 1 : (position - index) * 2;
      return distance(a.position) - distance(b.position);
    });
  for (const { item } of others) {
    const found = pick(word, unitSentences(word, item, lessons));
    if (found) return found;
  }
  return null;
}
