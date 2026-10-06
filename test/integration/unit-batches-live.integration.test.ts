import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';
import { WordPackRepository } from '../../src/modules/word-packs/word-packs.repository.js';
import { PracticeService } from '../../src/modules/practice/practice.service.js';
import { PostgresPrivateLessonJournal } from '../../src/modules/private-lessons/private-lesson.repository.js';

test(
  'ordered unit batches keep unfinished words, bound distractors and unlock the next batch after completion',
  { timeout: 150000 },
  async (t) => {
    const db = await createTestDatabase();
    try {
      const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
      await db.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,'gotit','GotIt')",
        [scope.applicationId],
      );
      await db.adminPool.query(
        'INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,$3)',
        [scope.applicationUserId, scope.applicationId, 'batch@example.test'],
      );
      const profileRepo = new ProfileRepository(db.runtimePool);
      await profileRepo.ensureAndGet(scope, {
        ...PROFILE_DEFAULTS,
        defaultSourceLanguage: 'en',
        defaultTranslationLanguage: 'he',
        defaultNewItemsPerDay: 0,
      });
      const packs = new WordPackRepository(db.runtimePool);
      const practice = new PracticeService(db.runtimePool, new ProfileService(profileRepo));
      const packId = 'd3000000-0000-4000-8000-000000000001';
      const otherId = 'd3000000-0000-4000-8000-000000000002';
      for (const id of [packId, otherId]) {
        const d = await packs.detail(scope, id);
        await packs.add(scope, id, { entryIds: d.entries.map((e) => e.id) });
      }
      let detail = await packs.detail(scope, packId);
      const words = detail.entries;
      const input = {
        sessionType: 'smart_review' as const,
        scope: { type: 'pack' as const, id: packId },
        includeNewItems: true,
        count: 10,
      };
      const start = async (count = 10) => {
        const { session } = await practice.createSession(scope, randomUUID(), { ...input, count });
        return { session, cards: (await practice.studyCards(scope, session.id)).cards };
      };
      await t.test(
        'profile quota zero does not block 5/10/20-word ordered batches or legacy clients',
        async () => {
          for (const count of [5, 10, 20]) {
            const { session, cards } = await start(count);
            assert.equal(session.itemCount, count);
            assert.equal(session.curriculumOrder, true);
            assert.deepEqual(
              cards.map((c) => c.learningItemId),
              words.slice(0, count).map((w) => w.learningItemId),
            );
          }
        },
      );
      const first = await start();
      await t.test('issued word order and distractors are restricted to this batch', async () => {
        const { exercises } = await practice.issueExercises(scope, first.session.id, {
          count: 3,
          exerciseType: 'matching',
          kind: 'multiple_choice',
          direction: 'source_to_translation',
        });
        assert.deepEqual(
          exercises.map((e) => e.learningItemId),
          first.cards.slice(0, 3).map((c) => c.learningItemId),
        );
        for (const e of exercises)
          for (const c of e.prompt.choices as { text: string }[])
            assert.ok(first.cards.some((card) => card.translationText === c.text));
      });
      async function complete(indexes: number[]) {
        const round = await start();
        const ids = words.filter((_, i) => indexes.includes(i)).map((w) => w.learningItemId);
        const { exercises } = await practice.issueExercises(scope, round.session.id, {
          count: ids.length,
          learningItemIds: ids,
          exerciseType: 'recall',
          kind: 'typed',
          direction: 'translation_to_source',
        });
        for (const e of exercises) {
          const word = words.find((w) => w.learningItemId === e.learningItemId)!;
          const receipt = await practice.submitAttempt(scope, randomUUID(), {
            exerciseId: e.id,
            answerText: word.sourceText,
            skipped: false,
            hintsUsed: 0,
          });
          assert.equal(receipt.attempt.result, 'correct');
        }
      }
      await t.test(
        'successful words are marked learned and incomplete batches do not top up',
        async () => {
          await complete([0, 2]);
          detail = await packs.detail(scope, packId);
          assert.equal(detail.entries[0]!.learned, true);
          assert.equal(detail.entries[1]!.learned, false);
          assert.equal(detail.pack.progress.completed, 2);
          const resumed = await start();
          assert.deepEqual(
            resumed.cards.map((c) => c.learningItemId),
            words
              .slice(0, 10)
              .filter((_, i) => ![0, 2].includes(i))
              .map((w) => w.learningItemId),
          );
        },
      );
      await t.test(
        'the next same-day batch starts only after completing all previous words',
        async () => {
          await complete([1, 3, 4, 5, 6, 7, 8, 9]);
          const next = await start();
          assert.deepEqual(
            next.cards.map((c) => c.learningItemId),
            words.slice(10, 20).map((w) => w.learningItemId),
          );
          const other = (
            await practice.createSession(scope, randomUUID(), {
              ...input,
              scope: { type: 'pack', id: otherId },
            })
          ).session;
          const list = await practice.sessions(scope, 50, undefined, undefined, packId);
          assert.ok(list.items.length);
          assert.ok(list.items.every((s) => s.scope?.id === packId));
          assert.ok(!list.items.some((s) => s.id === other.id));
          const foreign = { ...scope, applicationUserId: randomUUID() };
          assert.equal(
            (await practice.sessions(foreign, 50, undefined, undefined, packId)).items.length,
            0,
          );
          // Compatible with the earlier schema as well as DEV's stored guided-unit contexts.
          assert.deepEqual(
            await new PostgresPrivateLessonJournal(db.runtimePool).list(
              scope,
              50,
              undefined,
              packId,
            ),
            [],
          );
        },
      );
    } finally {
      await db.dispose();
    }
  },
);
