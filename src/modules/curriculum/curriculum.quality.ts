// Read-only quality audit for the authored curriculum (assets/english-zero-c1).
// It measures properties a professional course needs and that drafts tend to miss:
// a new-word budget per band, comprehensible input coverage, recycling of earlier
// targets, natural spoken English (contractions) and phonics decodability.
// Thresholds are product starting points to calibrate, not validated norms.

export type Band = 'Pre-A1' | 'A1' | 'A2' | 'B1' | 'B2' | 'C1';

type Entry = { en: string };
type Line = { speaker?: string; text_en: string };
export type AuditUnit = {
  id: string;
  band: Band;
  targets: Entry[];
  support_words?: string[];
  support_glossary?: unknown[];
  dialogue: Line[];
  passage_en: string;
  model_response_en?: string;
  content_status?: string;
};
export type AuditPhonics = {
  id: string;
  mappings: { grapheme: string }[];
  decodable_words: string[];
  irregular_words?: unknown[];
  exercises?: { kind?: string; answer?: unknown; source_word?: string }[];
};
export type AuditCurriculum = {
  units: AuditUnit[];
  phonics: AuditPhonics[];
  lessons?: { unit: string; targets: unknown[] }[];
};

// New target words per unit; ranges follow the level authoring guidance
// (very low density for beginners, growing with level).
export const NEW_TARGET_BUDGET: Record<Band, [number, number]> = {
  'Pre-A1': [4, 7],
  A1: [5, 8],
  A2: [6, 10],
  B1: [7, 12],
  B2: [8, 14],
  C1: [8, 14],
};

// Known-token share needed for unassisted comprehension of a passage: ~95% is a
// commonly cited lower bound and ~98% the comfortable level (Laufer; Hu & Nation).
export const COVERAGE_MIN = 0.95;
export const COVERAGE_COMFORTABLE = 0.98;

// Uncontracted forms that sound like written English when spoken in a dialogue.
const UNCONTRACTED: [RegExp, string][] = [
  [/\bI am\b/, "I'm"],
  [/\b(you|we|they) are\b/i, "you're / we're / they're"],
  [/\b(he|she|it|that|what|there|where) is\b/i, "it's / that's / what's"],
  [/\bdo not\b/i, "don't"],
  [/\bdoes not\b/i, "doesn't"],
  [/\bdid not\b/i, "didn't"],
  [/\b(is|are|was|were) not\b/i, "isn't / aren't"],
  [/\bcannot\b/i, "can't"],
  [/\bwill not\b/i, "won't"],
  [/\blet us\b/i, "let's"],
  [/\b(I|you|we|they) (will|would)\b/, "I'll / I'd"],
  // "have" only as an auxiliary ("I have finished"); "I have two apples" stays.
  [/\b(I|you|we|they) have (been|done|seen|got|finished|never|already|just|[a-z]+ed)\b/, "I've"],
];
// A full form is natural when stressed at the end ("Yes, I am.") or in emphatic
// contrast; skip those so the check does not ask for "Yes, I'm."
const STRESSED_FINAL = /\b(am|are|is|not|will|have|would)[.!?]?\s*$/i;

// From B1 the full "would" and auxiliary "have" are register choices (polite
// advice, formal complaints, emphasis), so they are reported only below B1.
const REGISTER_DEPENDENT = new Set(["I'll / I'd", "I've"]);
export function uncontractedForms(text: string, band?: Band) {
  const out: { form: string; suggestion: string }[] = [];
  const lenient = band && !['Pre-A1', 'A1', 'A2'].includes(band);
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    for (const [re, suggestion] of UNCONTRACTED) {
      if (lenient && REGISTER_DEPENDENT.has(suggestion)) continue;
      const m = sentence.match(re);
      if (!m) continue;
      const tail = sentence.slice((m.index ?? 0) + m[0].length);
      if (!tail.trim() || STRESSED_FINAL.test(m[0] + tail)) continue;
      out.push({ form: m[0], suggestion });
    }
  }
  return out;
}

export function tokens(text: string) {
  // Keep apostrophes inside words. Template placeholders such as
  // {{teacherName}} are filled with a name at runtime, so they are not words.
  return text.replace(/\{\{\w+\}\}/g, ' ').match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) ?? [];
}

const lowerTokens = (text: string) => tokens(text).map((t) => t.toLowerCase().replace(/’/g, "'"));

// Capitalised words other than "I" that never occur in lower case in the text:
// likely names or places, which do not count against coverage when unknown.
function likelyNames(text: string) {
  const all = tokens(text);
  const lower = new Set(all.filter((t) => /^[a-z]/.test(t)).map((t) => t.toLowerCase()));
  return new Set(
    all
      .filter((t) => /^[A-Z]/.test(t) && t !== 'I' && !lower.has(t.toLowerCase()))
      .map((t) => t.toLowerCase()),
  );
}

const CONTRACTION_BASE: Record<string, string[]> = {
  "n't": ['not'],
  "'m": ['am'],
  "'re": ['are'],
  "'s": ['is'],
  "'ll": ['will'],
  "'ve": ['have'],
  "'d": ['would'],
};
const IRREGULAR_BASE: Record<string, string> = { "can't": 'can', "won't": 'will' };

// Crude inflection folding; good enough to avoid counting "apples" as unknown
// when "apple" is a target. Returns candidate base forms.
export function baseForms(word: string): string[] {
  const w = word.toLowerCase().replace(/’/g, "'");
  const out = new Set([w]);
  if (IRREGULAR_BASE[w]) out.add(IRREGULAR_BASE[w]);
  for (const [suffix, extra] of Object.entries(CONTRACTION_BASE)) {
    if (w.endsWith(suffix)) {
      out.add(w.slice(0, -suffix.length));
      extra.forEach((e) => out.add(e));
    }
  }
  for (const [suffix, repl] of [
    ['ies', 'y'],
    ['es', ''],
    ['s', ''],
    ['ied', 'y'],
    ['ed', ''],
    ['ed', 'e'],
    ['ing', ''],
    ['ing', 'e'],
    ['er', ''],
    ['est', ''],
  ] as const) {
    if (w.length >= suffix.length + 2 && w.endsWith(suffix)) {
      const stem = w.slice(0, -suffix.length) + repl;
      out.add(stem);
      // doubled consonant: stopped -> stop, running -> run
      if (/([b-df-hj-np-tv-z])\1$/.test(stem)) out.add(stem.slice(0, -1));
    }
  }
  return [...out];
}

const known = (vocab: Set<string>, word: string) => baseForms(word).some((b) => vocab.has(b));

function entryWords(entries: unknown[] | undefined) {
  return (entries ?? []).flatMap((e) =>
    e && typeof (e as Entry).en === 'string'
      ? tokens((e as Entry).en).map((t) => t.toLowerCase())
      : [],
  );
}

/** Targets the unit's dialogue, model response and passage never use (inflections count). */
export function targetsWithoutInput(
  unit: Pick<AuditUnit, 'dialogue' | 'passage_en' | 'model_response_en'>,
  targets: string[],
) {
  const text = [
    ...unit.dialogue.map((d) => d.text_en),
    unit.model_response_en ?? '',
    unit.passage_en,
  ].join('\n');
  const bases = new Set(lowerTokens(text).flatMap(baseForms));
  return targets.filter((t) => !tokens(t).every((w) => baseForms(w).some((b) => bases.has(b))));
}

export type UnitReport = {
  id: string;
  band: Band;
  targetCount: number;
  newPerSession: number;
  budget: [number, number];
  overBudget: boolean;
  targetsNotInInput: string[];
  uncontracted: { line: string; form: string; suggestion: string }[];
  passageCoverage: number;
  unknownInPassage: string[];
  recycledEarlierTargets: number;
  reviewed: boolean;
};

// wordCardsByUnit: extra words taught for a unit outside its dialogue (e.g. the
// lexicon's frequency-coverage cards); they count as known for coverage only.
export function auditUnits(
  units: AuditUnit[],
  wordCardsByUnit: Map<string, string[]> = new Map(),
  newPerLessonByUnit: Map<string, number> = new Map(),
): UnitReport[] {
  const earlier = new Set<string>();
  return units.map((unit) => {
    const targetWords = entryWords(unit.targets);
    const vocab = new Set([
      ...earlier,
      ...targetWords,
      ...(wordCardsByUnit.get(unit.id) ?? []).flatMap(lowerTokens),
      ...(unit.support_words ?? []).flatMap((w) => tokens(w).map((t) => t.toLowerCase())),
      ...entryWords(unit.support_glossary),
    ]);
    const spoken = [...unit.dialogue.map((d) => d.text_en), unit.model_response_en ?? ''];
    const allText = [...spoken, unit.passage_en].join('\n');
    const input = lowerTokens(allText);
    const targetsNotInInput = targetsWithoutInput(
      unit,
      unit.targets.map((t) => t.en),
    );
    const names = likelyNames(allText);
    const passage = lowerTokens(unit.passage_en).filter((w) => known(vocab, w) || !names.has(w));
    const unknown = passage.filter((w) => !known(vocab, w));
    const recycled = new Set(
      input.filter(
        (w) => baseForms(w).some((b) => earlier.has(b)) && !known(new Set(targetWords), w),
      ),
    ).size;
    const budget = NEW_TARGET_BUDGET[unit.band];
    const report: UnitReport = {
      id: unit.id,
      band: unit.band,
      targetCount: unit.targets.length,
      budget,
      // A unit's targets are introduced across its lessons; the budget applies
      // to what one session introduces.
      newPerSession: newPerLessonByUnit.get(unit.id) ?? unit.targets.length,
      overBudget: (newPerLessonByUnit.get(unit.id) ?? unit.targets.length) > budget[1],
      targetsNotInInput,
      uncontracted: spoken.flatMap((line) =>
        uncontractedForms(line, unit.band).map((u) => ({ line, ...u })),
      ),
      passageCoverage: passage.length ? 1 - unknown.length / passage.length : 1,
      unknownInPassage: [...new Set(unknown)],
      recycledEarlierTargets: recycled,
      reviewed: Boolean(
        unit.content_status && !/proposal|draft|not_.*validated/.test(unit.content_status),
      ),
    };
    // Earlier targets and glossed support words have been met before.
    [...targetWords, ...vocab].forEach((w) => earlier.add(w));
    return report;
  });
}

// "a_e" -> a, e ; "y בסוף מילה" -> y ; "-ed אחרי" -> ed
export function graphemeOf(raw: string): string[] {
  const m = raw.toLowerCase().match(/[a-z]+(?:_[a-z])?/);
  if (!m) return [];
  return m[0].includes('_') ? m[0].split('_') : [m[0]];
}

export function segmentable(word: string, graphemes: Set<string>) {
  const w = word.toLowerCase();
  const longest = Math.max(1, ...[...graphemes].map((g) => g.length));
  const ok: boolean[] = [true, ...Array(w.length).fill(false)];
  for (let i = 0; i < w.length; i++) {
    if (!ok[i]) continue;
    for (let len = 1; len <= longest && i + len <= w.length; len++)
      if (graphemes.has(w.slice(i, i + len))) ok[i + len] = true;
  }
  return ok[w.length];
}

export type PhonicsReport = { id: string; notDecodable: string[]; exerciseNotDecodable: string[] };

// Exercises whose answer (or source word) is a word the learner must decode at
// this point; their words may only use graphemes taught so far.
const DECODING_KINDS = new Set([
  'dictation',
  'phoneme_deletion',
  'visual_discrimination',
  'vowel_discrimination',
]);

// A decodable word may only use grapheme-phoneme mappings taught so far
// (irregular words are exempt: they are taught as whole words).
export function auditPhonics(sessions: AuditPhonics[]): PhonicsReport[] {
  const taught = new Set<string>();
  return sessions.map((s) => {
    s.mappings.forEach((m) => graphemeOf(m.grapheme).forEach((g) => taught.add(g)));
    // Vowel sets written as "a/e/i/o/u" in review sessions.
    s.mappings.forEach((m) =>
      m.grapheme.split('/').forEach((g) => /^[a-z]{1,3}$/.test(g) && taught.add(g)),
    );
    const irregular = new Set(
      (s.irregular_words ?? []).map((w) => {
        const entry = w as { en?: string; word?: string } | string | null;
        return (typeof entry === 'string' ? entry : (entry?.en ?? entry?.word ?? '')).toLowerCase();
      }),
    );
    return {
      id: s.id,
      notDecodable: s.decodable_words.filter(
        (w) => !irregular.has(w.toLowerCase()) && !segmentable(w, taught),
      ),
      exerciseNotDecodable: (s.exercises ?? [])
        .filter((e) => DECODING_KINDS.has(e.kind ?? ''))
        .flatMap((e) => [String(e.answer ?? ''), e.source_word ?? ''])
        // Single letters are answers about a letter shape, not words to decode.
        .filter((w) => /^[a-z]{2,}$/i.test(w) && !irregular.has(w.toLowerCase()))
        .filter((w) => !segmentable(w, taught)),
    };
  });
}

export function auditCurriculum(c: AuditCurriculum, wordCardsByUnit?: Map<string, string[]>) {
  const perLesson = new Map<string, number>();
  for (const lesson of c.lessons ?? [])
    perLesson.set(lesson.unit, Math.max(perLesson.get(lesson.unit) ?? 0, lesson.targets.length));
  const units = auditUnits(c.units, wordCardsByUnit, perLesson);
  const phonics = auditPhonics(c.phonics);
  const byBand = new Map<Band, UnitReport[]>();
  units.forEach((u) => byBand.set(u.band, [...(byBand.get(u.band) ?? []), u]));
  const summary = [...byBand.entries()].map(([band, list]) => ({
    band,
    units: list.length,
    overBudget: list.filter((u) => u.overBudget).length,
    meanTargets: list.reduce((s, u) => s + u.targetCount, 0) / list.length,
    belowCoverageMin: list.filter((u) => u.passageCoverage < COVERAGE_MIN).length,
    medianCoverage: [...list.map((u) => u.passageCoverage)].sort((a, b) => a - b)[
      Math.floor(list.length / 2)
    ],
    unitsWithUncontracted: list.filter((u) => u.uncontracted.length).length,
    uncontractedLines: list.reduce((s, u) => s + u.uncontracted.length, 0),
    targetsNotInInput: list.reduce((s, u) => s + u.targetsNotInInput.length, 0),
    reviewed: list.filter((u) => u.reviewed).length,
  }));
  return {
    summary,
    units,
    phonics,
    phonicsNotDecodable: phonics.reduce(
      (s, p) => s + p.notDecodable.length + p.exerciseNotDecodable.length,
      0,
    ),
  };
}
