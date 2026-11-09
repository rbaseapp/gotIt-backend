/** Replaces whole-word occurrences of the answers with a gap; never a part of a word. */
export function hideAnswers(context: string | null, answers: string[]) {
  if (!context) return null;
  const alternatives = [...new Set(answers.filter((answer) => answer.trim()))]
    .sort((a, b) => b.length - a.length)
    .map((answer) => answer.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  if (!alternatives.length) return context.slice(0, 4000);
  // Unicode word segmentation also handles contractions, combining marks and
  // languages without spaces. Never turn a substring of a word into a gap.
  const boundaries = new Set<number>();
  for (const segment of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(context)) {
    boundaries.add(segment.index);
    boundaries.add(segment.index + segment.segment.length);
  }
  const result = context.replace(
    new RegExp(alternatives.join('|'), 'giu'),
    (match, offset: number) =>
      boundaries.has(offset) && boundaries.has(offset + match.length) ? '_____' : match,
  );
  return result.slice(0, 4000);
}

/** The context with the answer hidden, or null when the exact answer is not in it. */
export function clozeContext(context: string | null | undefined, answers: string[]) {
  const hidden = hideAnswers(context ?? null, answers);
  return hidden?.includes('_____') ? hidden : null;
}

const LATIN_WORD = /^[\p{Script=Latin}\p{M}\p{N}\p{P}\p{Zs}]+$/u;
const OTHER_LETTER = /(?!\p{Script=Latin})\p{L}/u;

/**
 * An example for the sentence game must be written in the word's own language only.
 * Generated examples sometimes add a translation, e.g. "I love it. (אני אוהב)";
 * a trailing bracketed translation is removed. A word written in Latin letters
 * rejects any example that still contains letters from another script.
 */
export function cleanExample(text: string, sourceText: string) {
  if (!LATIN_WORD.test(sourceText)) return text;
  const trimmed = text.replace(/\s*[([（][^()[\]（）]*[)\]）]\s*$/u, (part) =>
    OTHER_LETTER.test(part) ? '' : part,
  );
  return OTHER_LETTER.test(trimmed) ? null : trimmed;
}
