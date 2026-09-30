# Daily English catalog (English for Hebrew speakers)

The catalog adds three tracks to the existing word-pack API. Each track has exactly
1,000 distinct English items in 20 ordered packs of 50. The tracks are **אנגלית
בסיסית**, **אנגלית טובה**, and **אנגלית מתקדמת**. English is the learning/source
language (`en`); Hebrew is the explanation/translation language (`he`). Users opt
into packs through the existing selection flow; no 3,000-item import runs on signup.

## Research and ordering

- The main word pool is drawn from the freely available top-5,000 lemma sample of
  the [Corpus of Contemporary American English (COCA)](https://www.wordfrequency.info/samples.asp).
  We use its TV/movie, unscripted speech and overall frequency columns. The
  weighted score is `0.65 × ln(1 + TV/movie per million + spoken per million) +
  0.35 × ln(1 + overall per million)`. Duplicate lemmas, proper names, non-words
  and a small set of less useful items are removed. COCA is a frequency guide,
  not an exact ranking of usefulness for every learner.
- The first 100 common function and survival words are moved forward for a learner
  starting at zero. Fixed expressions were selected for conversational tasks and
  distributed through the tracks. The [English Vocabulary Profile](https://englishprofile.org/?menu=english-vocabulary-profile)
  and [Oxford Phrase List overview](https://www.oxfordlearnersdictionaries.com/us/about/wordlists/oxford-phrase-list.html)
  guided the decision to include word senses and phrases alongside single words.
  The expression order is editorial, not a measured phrase-frequency rank.
- The track labels are product progression names. The stored CEFR ranges are broad
  navigation hints, not a CEFR certification or proof that every item has that
  individual level.

## Hebrew meanings and review

The draft translations were generated locally with the Apache-2.0 licensed
[Helsinki-NLP `opus-mt-en-he` model](https://huggingface.co/Helsinki-NLP/opus-mt-en-he).
Verb and noun context prompts reduce part-of-speech errors. Common words,
ambiguous senses and all first-track survival phrases have explicit Hebrew
corrections in `scripts/build-daily-english-catalog.py`. The checked-in JSON is
the runtime source of truth; regeneration requires an editorial review before
replacing it. The [Wiktionary translation dataset](https://zenodo.org/records/1286991)
was consulted as a secondary sense check and is not copied into the catalog.

Automated tests guard track and unit counts, uniqueness, nonempty Hebrew,
representative high-use meanings, migration contents and rollback protection.
Translations remain subject to ongoing editorial refinement, especially
polysemous entries beyond the first units. Editing an existing catalog entry
after users have installed it requires a separate versioned correction process;
do not silently rewrite a learned sense in a migration.

## Rollout

The learner-facing name is now **מסלול לימוד אנגלית** (English learning path),
shown on the dedicated Web route `/english-learning`. The original migration is
frozen because it was already published. Apply
`1790800007000_english-learning-path` after it: this renames the topic and
corrects 72 Hebrew catalog meanings. The original JSON remains the immutable
input to migration `6000`; `migrations/data/english-learning-corrections.json`
records each versioned correction. Existing installed learning-item meanings are
not rewritten or regraded; the corrected meanings apply to future installations.
The units are ordered by practical frequency, rather than falsely labeled as
thematic chapters.

Migration `1790800006000_daily-english-catalog` only inserts the new topic,
three tracks, 60 packs and 3,000 entries. Run it with the dedicated migrator
after backup and before backend deployment. The migration does not modify
existing user packs. Rollback refuses to remove these packs after any user has
installed one or has linked learning progress. Verify with an authenticated
`GET /api/v1/word-packs` using an `en` learning / `he` translation profile, then
inspect the first and last pack details and install a 50-entry pack on a test user.
