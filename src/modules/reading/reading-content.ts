import {
  generatedReadingSchema,
  type GeneratedReading,
  type ReadingTarget,
} from './reading.validation.js';

export type ReadingRange = { start: number; end: number };
export type BoundReadingTarget = ReadingTarget & {
  occurrenceCount: number;
  ranges: ReadingRange[];
};

type CanonicalPoint = { value: string; start: number; end: number };

/**
 * Builds a searchable representation while retaining code-point offsets into the
 * original passage. NFKC, case and whitespace differences should not turn a
 * visually present target into a provider failure.
 */
function canonicalPoints(text: string): CanonicalPoint[] {
  const result: CanonicalPoint[] = [];
  let pointOffset = 0;
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text);
  for (const { segment } of segments) {
    const segmentLength = [...segment].length;
    for (const value of [...segment.normalize('NFKC').toLocaleLowerCase()]) {
      if (/\s/u.test(value)) {
        const previous = result.at(-1);
        if (previous?.value === ' ') {
          previous.end = pointOffset + segmentLength;
          continue;
        }
        result.push({ value: ' ', start: pointOffset, end: pointOffset + segmentLength });
      } else {
        result.push({ value, start: pointOffset, end: pointOffset + segmentLength });
      }
    }
    pointOffset += segmentLength;
  }
  return result;
}

export function targetRanges(bodyText: string, sourceText: string): ReadingRange[] {
  const haystack = canonicalPoints(bodyText);
  const needle = canonicalPoints(sourceText);
  while (needle[0]?.value === ' ') needle.shift();
  while (needle.at(-1)?.value === ' ') needle.pop();
  if (!needle.length || needle.length > haystack.length) return [];
  const ranges: ReadingRange[] = [];
  for (let index = 0; index <= haystack.length - needle.length; index++) {
    if (needle.every((point, offset) => point.value === haystack[index + offset]!.value)) {
      ranges.push({
        start: haystack[index]!.start,
        end: haystack[index + needle.length - 1]!.end,
      });
      index += needle.length - 1;
    }
  }
  return ranges;
}

export function bindReadingTargets(bodyText: string, targets: ReadingTarget[]) {
  const bound: BoundReadingTarget[] = [];
  const missing: ReadingTarget[] = [];
  for (const target of targets) {
    const ranges = targetRanges(bodyText, target.sourceText);
    if (!ranges.length) missing.push(target);
    else bound.push({ ...target, occurrenceCount: ranges.length, ranges });
  }
  return { bound, missing };
}

const points = (value: string) => [...value];

/** Last-resort completion after model repair attempts. Returns null only when
 * the target text itself cannot fit inside the public passage size contract. */
export function completeMissingTargets(
  content: GeneratedReading,
  targets: ReadingTarget[],
): GeneratedReading | null {
  const initial = bindReadingTargets(content.bodyText, targets);
  if (!initial.missing.length) return content;

  const addition = `\n\n${initial.missing.map((target) => target.sourceText).join(' · ')}`;
  const appended = generatedReadingSchema.safeParse({
    ...content,
    bodyText: `${content.bodyText}${addition}`,
  });
  if (appended.success) return appended.data;

  const uniqueTargets = [
    ...new Map(targets.map((target) => [target.sourceText, target.sourceText])).values(),
  ];
  const appendix = `\n\n${uniqueTargets.join(' · ')}`;
  const prefixLength = 12000 - points(appendix).length;
  if (prefixLength < 20) return null;
  const rebuilt = generatedReadingSchema.safeParse({
    ...content,
    bodyText: `${points(content.bodyText).slice(0, prefixLength).join('').trimEnd()}${appendix}`,
  });
  return rebuilt.success ? rebuilt.data : null;
}
