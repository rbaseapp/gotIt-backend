# English learning path catalog

The current path is **לימוד שפה מאפס**. It has three tracks, 60 ordered units and
50 English entries in each unit. `migrations/data/english-unique-3000-source.txt`
is the learner-supplied unit list. The published catalog is
`migrations/data/english-unique-3000-en-he.json`: all 3,000 English entries are
unique when compared without case, including words and phrases.

English is the learning language (`en`) and Hebrew is the translation language
(`he`). Users choose packs through the existing API; signing up does not import
the whole path. The 60 pack IDs, slugs and entry IDs remain stable so existing
links to packs still resolve. A changed ordinal entry ID never carries a user's
known or practice status to a different word.

## Hebrew translations

Existing reviewed translations are reused when possible. The 1,230 entries not
covered by the previous catalogs have draft Hebrew translations from the locally
cached `Helsinki-NLP/opus-mt-en-he` model, with explicit corrections for seven
items that the model did not translate appropriately. The generated JSON records
the translation source for every entry. These drafts need editorial review for
context and natural Hebrew; the catalog test establishes coverage, not linguistic
accuracy. The generation script is `scripts/build-english-unique-catalog.py`.

## Migration and progress

Migration `1790800011000_english-unique-catalog` updates the existing 60 packs
in place to version 4 and renames the topic. It archives every prior known mark
and learning-item pack link in `product_gotit.english_catalog_progress_archive`
before changing entries. A known mark is restored only when both the English
source and Hebrew meaning match a new entry. A learning link is restored only
when the same source and meaning remain in its installed pack. Unmatched
associations remain in the archive; their underlying learning items and practice
history remain intact. This prevents a previously known word from marking an
unrelated replacement word as known. A rollback is automatic only when no user
progress is present; otherwise it requires a reviewed restore from the archive.

Before production migration, take the documented schema backup. After migration,
verify the 60×50 catalog, global uniqueness, the topic title, the archive and
remapped progress. Unit and integration tests cover the supplied list, duplicate
regression, cross-unit known state, and migration of retained, removed and
different-sense words.

## History

The initial `1790800006000_daily-english-catalog` migration created the packs
from a frequency-oriented catalog. Migrations `1790800007000` through
`1790800010000` added the course name, thematic units and contextual meaning
corrections. Their data files are immutable migration inputs. The old thematic
catalog had 3,000 positions but only 1,710 distinct case-insensitive English
entries; repeated words could show partial progress in other units. The supplied
replacement removes these repetitions.
