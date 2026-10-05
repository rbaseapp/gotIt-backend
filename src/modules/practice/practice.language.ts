// A script check catches mislabeled legacy words; it does not identify languages
// sharing a script (for example English and French). Language codes still own scope.
const scripts = {
  Latn: /\p{Script=Latin}/u,
  Arab: /\p{Script_Extensions=Arabic}/u,
  Hebr: /\p{Script=Hebrew}/u,
  Cyrl: /\p{Script=Cyrillic}/u,
  Hans: /\p{Script=Han}/u,
  Hant: /\p{Script=Han}/u,
  Jpan: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  Kore: /[\p{Script=Hangul}\p{Script=Han}]/u,
  Grek: /\p{Script=Greek}/u,
} as const;
const languageScripts = new Map(
  [
    'en',
    'de',
    'es',
    'fr',
    'ar',
    'he',
    'ru',
    'zh',
    'ja',
    'ko',
    'el',
    'uk',
    'bg',
    'sr',
    'fa',
    'ur',
    'tr',
    'pt',
    'it',
    'vi',
    'pl',
    'nl',
  ].map((language) => [language, new Intl.Locale(language).maximize().script!] as const),
);
const letter = /\p{Letter}/u;
const mark = /\p{Mark}/u;
const ranges = new Map<string, string>();

function allowedLetters(script: keyof typeof scripts) {
  const cached = ranges.get(script);
  if (cached) return cached;
  const parts: string[] = [];
  let first = -1;
  for (let point = 0; point <= 0x110000; point++) {
    const char = point < 0x110000 ? String.fromCodePoint(point) : '';
    if (char && (mark.test(char) || (letter.test(char) && scripts[script].test(char)))) {
      if (first === -1) first = point;
    } else if (first !== -1) {
      const last = point - 1;
      parts.push(
        String.fromCodePoint(first) + (last === first ? '' : `-${String.fromCodePoint(last)}`),
      );
      first = -1;
    }
  }
  const result = `[${parts.join('')}]`;
  ranges.set(script, result);
  return result;
}

/** Internal SQL fragment; aliases are fixed by the repository, never user input. */
export function practiceLanguagePredicate(alias: 'li' = 'li') {
  const language = `${alias}.source_language_code`;
  const clauses = Object.keys(scripts).map((script) => {
    const defaults = [...languageScripts]
      .filter(([, value]) => value === script)
      .map(([value]) => `'${value}'`);
    // An explicit BCP-47 script takes precedence over a language's usual script.
    const condition = `${language} ~ '-${script}(-|$)' OR (${language} !~ '-[A-Z][a-z]{3}(-|$)' AND split_part(${language},'-',1) IN (${defaults.join(',') || "''"}))`;
    return `WHEN ${condition} THEN regexp_replace(${alias}.source_text, '${allowedLetters(script as keyof typeof scripts)}', '', 'g') !~ '[[:alpha:]]'`;
  });
  return `(CASE ${clauses.join(' ')} ELSE true END)`;
}
