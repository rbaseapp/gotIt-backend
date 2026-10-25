import type { Pool } from 'pg';
import type { ProfileScope } from '../profile/profile.types.js';
import { WordPackRepository } from '../word-packs/word-packs.repository.js';
import type { PrivateLessonTarget, PrivateLessonWordPackContext } from './private-lesson.prompt.js';

export interface PrivateLessonWordPackSource {
  context(
    scope: ProfileScope,
    packId: string,
    station: 'supported' | 'midpoint' | 'review',
  ): Promise<{ context: PrivateLessonWordPackContext; targets: PrivateLessonTarget[] }>;
}

/** Catalog membership is public; linked vocabulary and progress always belong to the caller. */
export class PostgresPrivateLessonWordPackSource implements PrivateLessonWordPackSource {
  private readonly packs: WordPackRepository;
  constructor(pool: Pool) {
    this.packs = new WordPackRepository(pool);
  }

  async context(scope: ProfileScope, packId: string, station: 'supported' | 'midpoint' | 'review') {
    const { pack, entries } = await this.packs.detail(scope, packId);
    const introduced = (entry: (typeof entries)[number]) =>
      entry.known ||
      Boolean(
        entry.learningItemId &&
          !entry.excludedAt &&
          entry.userStatus === 'active' &&
          entry.learningStatus !== 'new',
      );
    // Keep the provider vocabulary bounded; readiness counts the full owned unit.
    const ordered = [...entries]
      .sort((a, b) => Number(introduced(b)) - Number(introduced(a)))
      .slice(0, 12);
    const context: PrivateLessonWordPackContext = {
      packId,
      title: String(pack.title),
      moduleNumber: Number(pack.moduleNumber),
      targetLanguageCode: String(pack.track.sourceLanguageCode),
      supportLanguageCode: String(pack.track.translationLanguageCode),
      level: pack.track.cefrFrom ?? 'A1',
      station,
      introduced: pack.progress.introduced,
      teacherStations: pack.teacherStations,
      completed: pack.progress.completed,
      total: pack.wordCount,
      words: ordered.map((entry) => ({
        sourceText: String(entry.sourceText),
        translationText: String(entry.translationText),
        exampleText: typeof entry.exampleText === 'string' ? entry.exampleText : null,
        introduced: introduced(entry),
      })),
    };
    return {
      context,
      targets: ordered
        .filter(
          (entry) => entry.learningItemId && !entry.excludedAt && entry.userStatus === 'active',
        )
        .map((entry) => ({
          learningItemId: String(entry.learningItemId),
          sourceText: String(entry.sourceText),
          translationText: String(entry.translationText),
        })),
    };
  }
}
