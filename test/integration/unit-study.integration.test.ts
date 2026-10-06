import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';
import { WordPackRepository } from '../../src/modules/word-packs/word-packs.repository.js';
import { WordPackStudyService } from '../../src/modules/word-packs/word-pack-study.service.js';
import { PracticeService } from '../../src/modules/practice/practice.service.js';

test(
  'uninstalled unit has study media without learning writes; games isolate units and exclude known words',
  { timeout: 150000 },
  async () => {
    const db = await createTestDatabase();
    try {
      const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
      await db.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,'gotit','GotIt')",
        [scope.applicationId],
      );
      await db.adminPool.query(
        'INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,$3)',
        [scope.applicationUserId, scope.applicationId, 'unit@example.test'],
      );
      const repository = new ProfileRepository(db.runtimePool);
      await repository.ensureAndGet(scope, {
        ...PROFILE_DEFAULTS,
        defaultSourceLanguage: 'en',
        defaultTranslationLanguage: 'he',
      });
      const packs = new WordPackRepository(db.runtimePool);
      const id = 'd3000000-0000-4000-8000-000000000001';
      const otherId = 'd3000000-0000-4000-8000-000000000002';
      const initial = await packs.detail(scope, id);
      let images = 0,
        examples = 0;
      const imageProvider = {
        id: 'unit-fixture',
        generate: async () => {
          images++;
          return {
            data: Buffer.from('image'),
            contentType: 'image/png' as const,
            kind: 'generated' as const,
            provider: 'fixture',
            sourceUrl: null,
            creator: null,
          };
        },
      };
      const study = new WordPackStudyService(db.runtimePool, packs, imageProvider, {
        generate: async () => {
          examples++;
          return 'I am happy.';
        },
      });
      const entryId = String(initial.entries[0]!.id);
      const media = await study.image(scope, id, entryId);
      assert.ok(media.image?.url.startsWith('data:image/png'));
      assert.deepEqual(await study.example(scope, id, entryId), {
        exampleText: 'I am happy.',
        generated: true,
      });
      await study.example(scope, id, entryId);
      assert.equal(examples, 1, 'example cache avoids repeat provider work');
      const restarted = new WordPackStudyService(db.runtimePool, packs, imageProvider);
      assert.deepEqual(await restarted.image(scope, id, entryId), media);
      assert.equal(images, 1, 'persistent image asset is reused without a library item');
      const after = await packs.detail(scope, id);
      assert.equal(after.pack.installed, false);
      assert.equal(after.pack.progress.introduced, 0);
      assert.ok(after.entries.every((entry) => !entry.learningItemId));
      const counts = (
        await db.adminPool.query(
          'SELECT (SELECT count(*) FROM product_gotit.learning_items)::int AS items,(SELECT count(*) FROM product_gotit.practice_sessions)::int AS sessions',
        )
      ).rows[0];
      assert.deepEqual(counts, { items: 0, sessions: 0 });
      await assert.rejects(study.image(scope, otherId, entryId), { code: 'NOT_FOUND' });
      await assert.rejects(study.example(scope, otherId, entryId), { code: 'NOT_FOUND' });
      assert.equal(images, 1);
      assert.equal(examples, 1);

      await packs.add(scope, id, { entryIds: initial.entries.map((entry) => String(entry.id)) });
      const other = await packs.detail(scope, otherId);
      await packs.add(scope, otherId, { entryIds: other.entries.map((entry) => String(entry.id)) });
      await packs.setKnown(scope, id, { entryIds: [entryId], known: true });
      const selected = await packs.detail(scope, id);
      const allowed = new Set(
        selected.entries.filter((entry) => !entry.known).map((entry) => entry.learningItemId),
      );
      const practice = new PracticeService(
        db.runtimePool,
        new ProfileService(repository),
        undefined,
        () => true,
      );
      await repository.patch(scope, PROFILE_DEFAULTS, { defaultNewItemsPerDay: 20 });
      await db.adminPool.query(
        `UPDATE product_gotit.learning_items li SET next_review_at=now()+make_interval(days=>100-entry.sort_order)
         FROM product_gotit.learning_item_pack_entries link
         JOIN product_gotit.word_pack_entries entry ON entry.id=link.entry_id
         WHERE li.id=link.learning_item_id AND link.application_id=$1 AND link.application_user_id=$2 AND link.pack_id=$3`,
        [scope.applicationId, scope.applicationUserId, id],
      );
      for (const count of [10, 20]) {
        const { session: batch } = await practice.createSession(scope, randomUUID(), {
          sessionType: 'smart_review',
          scope: { type: 'pack', id },
          sourceLanguageCode: 'en',
          count,
          includeNewItems: true,
          curriculumOrder: true,
        });
        const { cards } = await practice.studyCards(scope, batch.id);
        assert.equal(cards.length, count);
        assert.deepEqual(
          cards.map((card) => card.learningItemId),
          selected.entries
            .filter((entry) => !entry.known)
            .slice(0, count)
            .map((entry) => entry.learningItemId),
          'daily batches follow unit order and omit the known first word, even with other units installed',
        );
        const { exercises } = await practice.issueExercises(scope, batch.id, {
          count: 3,
          exerciseType: 'matching',
          kind: 'multiple_choice',
          direction: 'source_to_translation',
        });
        assert.deepEqual(
          exercises.map((exercise) => exercise.learningItemId),
          cards.slice(0, 3).map((card) => card.learningItemId),
          'the actual game round, not only the study selection, keeps curriculum order',
        );
      }
      for (const sessionType of [
        'recall',
        'matching',
        'flashcards',
        'listening_spelling',
        'pronunciation',
        'smart_review',
      ] as const) {
        const { session } = await practice.createSession(scope, randomUUID(), {
          sessionType,
          scope: { type: 'pack', id },
          sourceLanguageCode: 'en',
          count: 10,
          ...(sessionType === 'smart_review' ? { includeNewItems: true } : {}),
        });
        const { cards } = await practice.studyCards(scope, session.id);
        assert.ok(cards.length > 0);
        assert.ok(
          cards.every((card) => allowed.has(card.learningItemId)),
          sessionType,
        );
        assert.equal(session.scope?.id, id);
      }
      const { session: scopedSmart } = await practice.createSession(scope, randomUUID(), {
        sessionType: 'smart_review',
        scope: { type: 'pack', id },
        sourceLanguageCode: 'en',
        count: 2,
        includeNewItems: true,
      });
      const { cards: scopedCards } = await practice.studyCards(scope, scopedSmart.id);
      const scopedMeanings = new Set(
        scopedCards.flatMap((card) => [card.sourceText, card.translationText]),
      );
      const { exercises: scopedExercises } = await practice.issueExercises(scope, scopedSmart.id, {
        count: 1,
        exerciseType: 'recall',
        direction: 'source_to_translation',
        kind: 'multiple_choice',
      });
      const scopedChoices = scopedExercises[0]!.prompt.choices;
      assert.ok(Array.isArray(scopedChoices));
      assert.ok(scopedChoices.length >= 2);
      assert.ok(
        scopedChoices.every((choice: { text: string }) => scopedMeanings.has(choice.text)),
        'a unit game must not import distractors from the general vocabulary library',
      );
      const unitWords = selected.entries.filter((entry) => !entry.known);
      const later = unitWords[25]!;
      const { session: general } = await practice.createSession(scope, randomUUID(), {
        sessionType: 'recall',
        learningItemIds: [String(later.learningItemId)],
        count: 1,
      });
      const { exercises: generalExercises } = await practice.issueExercises(scope, general.id, {
        count: 1,
        kind: 'typed',
        direction: 'translation_to_source',
      });
      await practice.submitAttempt(scope, randomUUID(), {
        exerciseId: generalExercises[0]!.id,
        answerText: String(later.sourceText),
        skipped: false,
        hintsUsed: 0,
      });
      assert.equal(
        (await packs.detail(scope, id)).entries.find((entry) => entry.id === later.id)!.learned,
        false,
        'general-library practice does not complete a later curriculum word',
      );
      const orderedInput = {
        sessionType: 'smart_review' as const,
        scope: { type: 'pack' as const, id },
        count: 10,
        includeNewItems: true,
        curriculumOrder: true,
      };
      const { session: firstBatch } = await practice.createSession(
        scope,
        randomUUID(),
        orderedInput,
      );
      const { cards: firstCards } = await practice.studyCards(scope, firstBatch.id);
      assert.deepEqual(
        firstCards.map((card) => card.learningItemId),
        unitWords.slice(0, 10).map((entry) => entry.learningItemId),
      );
      const { exercises: firstRound } = await practice.issueExercises(scope, firstBatch.id, {
        count: 3,
        exerciseType: 'matching',
        kind: 'multiple_choice',
        direction: 'source_to_translation',
      });
      assert.deepEqual(
        firstRound.map((exercise) => exercise.learningItemId),
        firstCards.slice(0, 3).map((card) => card.learningItemId),
      );
      const firstChoice = (
        firstRound[0]!.prompt.choices as Array<{ id: string; text: string }>
      ).find((choice) => choice.text === firstCards[0]!.translationText)!;
      await practice.submitAttempt(scope, randomUUID(), {
        exerciseId: firstRound[0]!.id,
        choiceId: firstChoice.id,
        skipped: false,
        hintsUsed: 0,
      });
      await practice.submitAttempt(scope, randomUUID(), {
        exerciseId: firstRound[1]!.id,
        skipped: true,
        hintsUsed: 0,
      });
      await practice.submitAttempt(scope, randomUUID(), {
        exerciseId: firstRound[2]!.id,
        choiceId: firstChoice.id,
        skipped: false,
        hintsUsed: 0,
      });
      const progressDetail = await packs.detail(scope, id);
      assert.equal(
        progressDetail.entries.find((entry) => entry.id === unitWords[0]!.id)!.learned,
        true,
      );
      assert.equal(
        progressDetail.entries.find((entry) => entry.id === unitWords[1]!.id)!.learned,
        false,
      );
      assert.equal(
        progressDetail.entries.find((entry) => entry.id === unitWords[2]!.id)!.learned,
        false,
      );
      const { session: continued } = await practice.createSession(
        scope,
        randomUUID(),
        orderedInput,
      );
      const { cards: remainingCards } = await practice.studyCards(scope, continued.id);
      assert.deepEqual(
        remainingCards.map((card) => card.learningItemId),
        firstCards.slice(1).map((card) => card.learningItemId),
        'reopening an incomplete batch retains its unfinished words without introducing the next batch',
      );
      const { exercises: remainingExercises } = await practice.issueExercises(scope, continued.id, {
        count: remainingCards.length,
        learningItemIds: remainingCards.map((card) => card.learningItemId),
        exerciseType: 'recall',
        kind: 'typed',
      });
      for (const exercise of remainingExercises) {
        const card = remainingCards.find(
          (card) => card.learningItemId === exercise.learningItemId,
        )!;
        await practice.submitAttempt(scope, randomUUID(), {
          exerciseId: exercise.id,
          answerText: card.sourceText,
          skipped: false,
          hintsUsed: 0,
        });
      }
      assert.ok(
        (await packs.detail(scope, id)).entries
          .filter((entry) => unitWords.slice(0, 10).some((word) => word.id === entry.id))
          .every((entry) => entry.learned),
      );
      const { session: nextBatch } = await practice.createSession(
        scope,
        randomUUID(),
        orderedInput,
      );
      const { cards: nextCards } = await practice.studyCards(scope, nextBatch.id);
      assert.ok(nextCards.length > 0);
      assert.deepEqual(
        nextCards.map((card) => card.learningItemId),
        unitWords.slice(10, 10 + nextCards.length).map((entry) => entry.learningItemId),
        'later words unlock only once every word in the previous batch was successfully practised',
      );
      await db.adminPool.query(
        'UPDATE product_gotit.learning_items SET learning_revision=learning_revision+1 WHERE id=$1',
        [firstCards[0]!.learningItemId],
      );
      assert.equal(
        (await packs.detail(scope, id)).entries.find((entry) => entry.id === unitWords[0]!.id)!
          .learned,
        false,
        'obsolete revision evidence cannot mark a changed word learned',
      );
      await packs.setKnown(scope, id, {
        entryIds: initial.entries.map((entry) => String(entry.id)),
        known: true,
      });
      await assert.rejects(
        practice.createSession(scope, randomUUID(), {
          sessionType: 'smart_review',
          scope: { type: 'pack', id },
          count: 10,
          includeNewItems: true,
        }),
        { code: 'NO_ELIGIBLE_ITEMS' },
      );
    } finally {
      await db.dispose();
    }
  },
);
