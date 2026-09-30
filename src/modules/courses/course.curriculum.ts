import { AppError } from '../../shared/errors/app-error.js';
import type { CourseDocument, CoursePlan, CoursePreferences } from './course.schemas.js';

// Versioned content coverage, separate from teaching stages. These are scope guides,
// not a certification that a generated course covers every possible use of a language.
const grammarCoverage: Record<string, string[]> = {
  en: [
    'be and subject pronouns',
    'articles and determiners',
    'nouns, plurals and possession',
    'present simple and questions',
    'present continuous and stative verbs',
    'past simple and irregular verb forms',
    'past continuous',
    'future forms',
    'present perfect and past contrast',
    'perfect continuous',
    'past perfect',
    'future perfect and continuous',
    'modal verbs and modality',
    'adjectives, adverbs and comparison',
    'prepositions',
    'quantifiers and countability',
    'gerunds and infinitives',
    'conditionals and wishes',
    'passive voice and causatives',
    'relative clauses',
    'reported speech and indirect questions',
    'clause linking and discourse',
    'inversion, emphasis and ellipsis',
    'advanced tense choices, exceptions and register',
  ],
  es: [
    'género, número y artículos',
    'pronombres personales y posesivos',
    'presente regular e irregular',
    'ser, estar y hay',
    'concordancia y adjetivos',
    'preguntas y negación',
    'pretérito perfecto',
    'indefinido e imperfecto',
    'futuro y condicional',
    'pronombres de objeto y colocación',
    'verbos reflexivos y recíprocos',
    'preposiciones por y para',
    'imperativo',
    'presente de subjuntivo',
    'pasados de subjuntivo',
    'oraciones condicionales',
    'perífrasis verbales',
    'relativas y subordinación',
    'voz pasiva y se impersonal',
    'discurso indirecto y concordancia temporal',
  ],
  fr: [
    'articles, genre et nombre',
    'pronoms sujets et être/avoir',
    'présent et verbes irréguliers',
    'adjectifs et accords',
    'questions et négation',
    'prépositions et contractions',
    'passé composé et auxiliaires',
    'imparfait et récit',
    'futur et conditionnel',
    'pronoms objets, y et en',
    'verbes pronominaux',
    'comparaison et quantité',
    'relatifs simples et composés',
    'plus-que-parfait et antériorité',
    'subjonctif',
    'hypothèses et si',
    'voix passive',
    'discours indirect',
    'participe, gérondif et accords',
    'registres et structures complexes',
  ],
  de: [
    'Verbzweitstellung und Personalpronomen',
    'Artikel, Genus und Plural',
    'Präsens und Konjugation',
    'Fragen und Negation',
    'Nominativ und Akkusativ',
    'Dativ und Genitiv',
    'Präpositionen und Wechselpräpositionen',
    'Modalverben und Satzklammer',
    'trennbare und untrennbare Verben',
    'Perfekt und Präteritum',
    'Adjektivdeklination',
    'Komparativ und Superlativ',
    'Nebensätze und Verbstellung',
    'Reflexivverben',
    'Relativsätze',
    'Infinitiv mit zu',
    'Passiv',
    'Konjunktiv II',
    'Konjunktiv I und indirekte Rede',
    'Nominalisierung, Partizipien und Textverknüpfung',
  ],
  he: [
    'כתב, ניקוד וקריאה בסיסית',
    'כינויי גוף ומשפט שמני',
    'מין ומספר בשמות',
    'יידוע והתאמת תארים',
    'שאלות ושלילה',
    'מילות יחס ונטייתן',
    'שורש ומשקל',
    'פועל בהווה',
    'בנייני הפועל ומשמעותם',
    'עבר ונטייה לפי גוף',
    'עתיד וציווי',
    'שם הפועל ושמות פעולה',
    'סמיכות ושייכות',
    'מושא ישיר ואת',
    'מספרים והתאמה',
    'פעלים חריגים וגזרות',
    'סביל ופעיל',
    'משפטי זיקה ותנאי',
    'קישור משפטים ודיבור עקיף',
    'משלב, סדר מילים ודיוק מתקדם',
  ],
  ar: [
    'الأبجدية والحركات',
    'الضمائر والجملة الاسمية',
    'التعريف والتنكير',
    'الجنس والعدد والمثنى',
    'الصفة والمطابقة',
    'الإضافة والملكية',
    'السؤال والنفي',
    'حروف الجر والضمائر المتصلة',
    'الجذر والوزن',
    'الماضي',
    'المضارع',
    'الأمر والمصدر',
    'أوزان الأفعال',
    'الأفعال المعتلة',
    'الحالات الإعرابية بحسب الفصحى',
    'الجمع والتطابق',
    'المبني للمجهول',
    'الشرط والموصول',
    'النصب والجزم',
    'الربط والأسلوب والفروق بين الفصحى واللهجة المختارة',
  ],
  ru: [
    'алфавит и произношение',
    'род и число',
    'местоимения и настоящее время',
    'вопросы и отрицание',
    'именительный и винительный падежи',
    'родительный падеж',
    'дательный и творительный падежи',
    'предложный падеж',
    'прилагательные и согласование',
    'прошедшее и будущее',
    'вид глагола',
    'глаголы движения',
    'приставки',
    'возвратные глаголы',
    'числительные и управление',
    'повелительное и условное наклонение',
    'сравнение',
    'причастия и деепричастия',
    'сложные предложения',
    'порядок слов и стиль',
  ],
  zh: [
    '拼音、声调与汉字基础',
    '基本语序与是句',
    '人称代词与的',
    '疑问句与疑问词',
    '不和没的否定',
    '量词与数量',
    '时间地点与语序',
    '有和在',
    '情态动词',
    '了、过、着与体',
    '结果补语',
    '趋向补语',
    '程度与可能补语',
    '比较句',
    '把字句',
    '被字句',
    '连动与兼语',
    '话题结构',
    '复句与关联词',
    '语气、语体与篇章衔接',
  ],
};
export function syllabusFor(preferences: CoursePreferences) {
  const base = new Intl.Locale(preferences.targetLanguageCode).language;
  const topics = grammarCoverage[base];
  return {
    version: '2026-09-30.1',
    basis: topics ? 'language_scope' : 'generated_scope',
    topics: (
      topics ?? [
        'writing and sound system',
        'basic sentence structure',
        'questions and negation',
        'reference, possession and modification',
        'time, aspect and modality where applicable',
        'language-specific morphology and agreement where applicable',
        'complex clauses and discourse',
        'advanced register and exceptions',
      ]
    ).map((title, index) => ({ key: `${base}-${index + 1}`, title })),
  };
}
export function validateCoursePlan(
  plan: CoursePlan,
  preferences: CoursePreferences,
  prior?: CourseDocument,
) {
  const seen = new Set<string>();
  for (const unit of plan.units) {
    if (seen.has(unit.key) || unit.prerequisites.some((key) => !seen.has(key))) throw invalidPlan();
    seen.add(unit.key);
  }
  if (preferences.path !== 'goal') {
    const required = syllabusFor(preferences).topics;
    const included = new Set(plan.units.flatMap((unit) => unit.syllabusKeys));
    if (required.some((topic) => !included.has(topic.key))) throw invalidPlan();
  }
  // Any unit with learning history retains its identity and exact content. A revision
  // changes future scope only; existing evidence must never be reassigned to new material.
  if (prior?.activeVersion) {
    const previous = prior.versions.find((version) => version.version === prior.activeVersion)!;
    const touched = new Set(prior.evidence.map((e) => e.unitKey));
    for (const unit of previous.plan.units.filter((unit) => touched.has(unit.key))) {
      if (JSON.stringify(plan.units.find((next) => next.key === unit.key)) !== JSON.stringify(unit))
        throw invalidPlan();
    }
    const oldOrder = previous.plan.units
      .filter((unit) => touched.has(unit.key))
      .map((unit) => unit.key);
    const newOrder = plan.units.filter((unit) => touched.has(unit.key)).map((unit) => unit.key);
    if (JSON.stringify(oldOrder) !== JSON.stringify(newOrder)) throw invalidPlan();
  }
  return plan;
}
function invalidPlan() {
  return new AppError(
    503,
    'COURSE_PLAN_INVALID',
    'The course plan needs another generation attempt',
  );
}

export function nextCourseLesson(course: CourseDocument) {
  const version = course.versions.find((item) => item.version === course.activeVersion);
  if (!version) return null;
  for (const unit of version.plan.units) {
    for (let lessonIndex = 0; lessonIndex < unit.lessons.length; lessonIndex++) {
      if (
        !course.evidence.some(
          (e) =>
            e.unitKey === unit.key &&
            e.lessonIndex === lessonIndex &&
            e.independent &&
            evidenceMatchesActiveUnit(course, e.version, unit.key),
        )
      )
        return { version, unit, lessonIndex, lesson: unit.lessons[lessonIndex]! };
    }
  }
  return null;
}
export function evidenceMatchesActiveUnit(
  course: CourseDocument,
  evidenceVersion: number,
  unitKey: string,
) {
  const active = course.versions
    .find((version) => version.version === course.activeVersion)
    ?.plan.units.find((unit) => unit.key === unitKey);
  const original = course.versions
    .find((version) => version.version === evidenceVersion)
    ?.plan.units.find((unit) => unit.key === unitKey);
  return Boolean(active && original && JSON.stringify(active) === JSON.stringify(original));
}
