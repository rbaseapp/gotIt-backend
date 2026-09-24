const ENGLISH_HOMOPHONE_GROUPS = [
  ['air', 'heir'],
  ['allowed', 'aloud'],
  ['bare', 'bear'],
  ['be', 'bee'],
  ['blew', 'blue'],
  ['brake', 'break'],
  ['buy', 'by', 'bye'],
  ['cell', 'sell'],
  ['cent', 'scent', 'sent'],
  ['cereal', 'serial'],
  ['dear', 'deer'],
  ['die', 'dye'],
  ['fair', 'fare'],
  ['flour', 'flower'],
  ['for', 'fore', 'four'],
  ['hear', 'here'],
  ['hole', 'whole'],
  ['hour', 'our'],
  ['i', 'eye'],
  ['know', 'no'],
  ['knight', 'night'],
  ['mail', 'male'],
  ['meat', 'meet'],
  ['one', 'won'],
  ['pair', 'pare', 'pear'],
  ['peace', 'piece'],
  ['plain', 'plane'],
  ['principal', 'principle'],
  ['rain', 'reign', 'rein'],
  ['right', 'rite', 'write', 'wright'],
  ['role', 'roll'],
  ['sea', 'see'],
  ['son', 'sun'],
  ['some', 'sum'],
  ['stair', 'stare'],
  ['steal', 'steel'],
  ['suite', 'sweet'],
  ['tail', 'tale'],
  ['their', 'there', 'theyre'],
  ['to', 'too', 'two'],
  ['wait', 'weight'],
  ['ware', 'wear', 'where'],
  ['weather', 'whether'],
  ['week', 'weak'],
  ['which', 'witch'],
  ['wood', 'would'],
  ['your', 'youre'],
] as const;

const normalize = (value: string) =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ');

const groupByWord = new Map<string, readonly string[]>();
for (const group of ENGLISH_HOMOPHONE_GROUPS)
  for (const word of group) groupByWord.set(word, group);

function isEnglish(language: string) {
  try {
    return new Intl.Locale(language).language === 'en';
  } catch {
    return false;
  }
}

function equivalentEnglishWord(actual: string, expected: string) {
  if (actual === expected) return true;
  return groupByWord.get(expected)?.includes(actual) ?? false;
}

export function arePronunciationEquivalent(actual: string, expected: string, language: string) {
  const actualWords = normalize(actual).split(' ');
  const expectedWords = normalize(expected).split(' ');
  if (actualWords.join(' ') === expectedWords.join(' ')) return true;
  return (
    isEnglish(language) &&
    actualWords.length === expectedWords.length &&
    actualWords.every((word, index) => equivalentEnglishWord(word, expectedWords[index]!))
  );
}

export function pronunciationAlternatives(expected: string, language: string) {
  const normalized = normalize(expected);
  if (!isEnglish(language) || normalized.includes(' ')) return [expected];
  const group = groupByWord.get(normalized);
  return group ? [expected, ...group.filter((word) => word !== normalized)] : [expected];
}
