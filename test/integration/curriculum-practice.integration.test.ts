import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { CurriculumStore } from '../../src/modules/curriculum/curriculum.store.js';
import { CurriculumService } from '../../src/modules/curriculum/curriculum.service.js';
import { PracticeService } from '../../src/modules/practice/practice.service.js';
import {
  sessionSchema,
  exercisesSchema,
  attemptSchema,
} from '../../src/modules/practice/practice.validation.js';
import { lexicon } from '../../src/modules/curriculum/curriculum.content.js';

test(
  'unit vocabulary uses real multi-game sessions, all unit words and atomic curriculum evidence',
  { timeout: 180000 },
  async () => {
    const db = await createTestDatabase();
    try {
      const applicationId = randomUUID(),
        userId = randomUUID(),
        otherId = randomUUID();
      await db.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,$2,'Practice bridge')",
        [applicationId, randomUUID()],
      );
      await db.adminPool.query(
        "INSERT INTO core.application_users(application_id,id,email) VALUES($1,$2,'bridge@example.test'),($1,$3,'other-bridge@example.test')",
        [applicationId, userId, otherId],
      );
      const scope = { applicationId, applicationUserId: userId },
        other = { applicationId, applicationUserId: otherId };
      const profiles = new ProfileService(new ProfileRepository(db.runtimePool));
      const store = new CurriculumStore(db.runtimePool);
      const curriculum = new CurriculumService(store, profiles);
      const practice = new PracticeService(db.runtimePool, profiles, undefined, () => true);
      await db.adminPool.query(
        "UPDATE product_gotit.structured_program_versions SET visible=true WHERE program_id='english-zero-c1'",
      );
      await curriculum.enroll(scope, { eventId: randomUUID(), minutes: 20, literacy: 'starting' });
      await curriculum.enroll(other, { eventId: randomUUID(), minutes: 20, literacy: 'starting' });
      const historical = (
        await db.adminPool.query(
          `INSERT INTO product_gotit.learning_items
      (application_id,application_user_id,source_text,normalized_source_text,source_language_code,translation_language_code,item_type)
      VALUES($1,$2,'hello','hello','en','he','word') RETURNING id`,
          [applicationId, userId],
        )
      ).rows[0]!.id;
      const input = sessionSchema.parse({
        sessionType: 'smart_review',
        curriculumUnitId: 'P01',
        sourceLanguageCode: 'en',
        count: 1,
        includeNewItems: true,
      });
      assert.equal(
        sessionSchema.safeParse({ ...input, scope: { type: 'pack', id: randomUUID() } }).success,
        false,
      );
      assert.equal(sessionSchema.safeParse({ ...input, sourceLanguageCode: 'ar' }).success, false);
      const key = randomUUID();
      const created = await practice.createSession(scope, key, input);
      assert.equal(created.session.curriculumUnitId, 'P01');
      assert.equal(created.session.itemCount, 12); // Count is not a one-word cap for a whole-unit path.
      assert.equal(
        (await practice.createSession(scope, key, input)).session.id,
        created.session.id,
      );
      await assert.rejects(
        practice.createSession(scope, key, { ...input, curriculumUnitId: 'P02' }),
      );
      assert.equal(
        (await practice.createSession(scope, randomUUID(), { ...input, curriculumUnitId: 'P02' }))
          .session.curriculumUnitId,
        'P02',
      );
      await assert.rejects(practice.getSession(other, String(created.session.id)));
      const cards = (await practice.studyCards(scope, String(created.session.id))).cards;
      const expected = lexicon.targets.filter((word) => word.unit === 'P01');
      assert.equal(cards.length, expected.length);
      assert.deepEqual(
        new Set(cards.map((card) => card.sourceText)),
        new Set(expected.map((word) => word.en)),
      );
      assert.ok(
        cards.every(
          (card) =>
            card.sourceLanguageCode === 'en' &&
            card.translationLanguageCode === 'he' &&
            card.learningItemId !== historical,
        ),
      );
      assert.equal((await curriculum.get(scope)).review.introduced, 0);
      assert.equal((await curriculum.get(scope)).practiceSessions.P01, created.session.id);
      await assert.rejects(
        practice.issueExercises(
          scope,
          String(created.session.id),
          exercisesSchema.parse({
            count: 1,
            learningItemIds: [historical],
            exerciseType: 'recall',
          }),
        ),
      );
      const first = cards[0]!;
      const flash = (
        await practice.issueExercises(
          scope,
          String(created.session.id),
          exercisesSchema.parse({
            count: 1,
            learningItemIds: [first.learningItemId],
            exerciseType: 'flashcards',
          }),
        )
      ).exercises[0]!;
      await practice.submitAttempt(
        scope,
        randomUUID(),
        attemptSchema.parse({ exerciseId: flash.id, selfRating: 'good' }),
      );
      let state = (await store.get(scope))!.state;
      const firstTarget = Object.entries(state.practiceItems!).find(
        ([, id]) => id === first.learningItemId,
      )![0];
      assert.equal(state.words[firstTarget]!.status, 'introduced');
      assert.equal(state.words[firstTarget]!.lastIndependentAt, null);
      assert.equal(state.words[firstTarget]!.practiceModes.recognition, undefined);
      const board = await practice.issueExercises(
        scope,
        String(created.session.id),
        exercisesSchema.parse({
          count: 4,
          learningItemIds: cards.slice(0, 4).map((card) => card.learningItemId),
          exerciseType: 'matching',
          kind: 'multiple_choice',
          direction: 'source_to_translation',
        }),
      );
      assert.equal(board.exercises.length, 4);
      for (const exercise of board.exercises) {
        const card = cards.find((item) => item.learningItemId === exercise.learningItemId)!;
        const choices = exercise.prompt.choices as Array<{
          id: string;
          text: string;
          correct?: boolean;
        }>;
        assert.ok(choices.every((choice) => choice.correct === undefined));
        const choice = choices.find((item) => item.text === card.translationText)!;
        const operation = randomUUID(),
          answer = attemptSchema.parse({ exerciseId: exercise.id, choiceId: choice.id });
        const accepted = await practice.submitAttempt(scope, operation, answer);
        assert.equal(accepted.attempt.result, 'correct');
        assert.equal(
          (await practice.submitAttempt(scope, operation, answer)).attempt.id,
          accepted.attempt.id,
        );
      }
      state = (await store.get(scope))!.state;
      assert.equal(state.words[firstTarget]!.practiceModes.matching, 1);
      assert.equal(state.words[firstTarget]!.practiceModes.recognition, 1);
      const typed = (
        await practice.issueExercises(
          scope,
          String(created.session.id),
          exercisesSchema.parse({
            count: 1,
            learningItemIds: [first.learningItemId],
            exerciseType: 'recall',
            direction: 'translation_to_source',
          }),
        )
      ).exercises[0]!;
      await practice.submitAttempt(
        scope,
        randomUUID(),
        attemptSchema.parse({ exerciseId: typed.id, answerText: first.sourceText }),
      );
      state = (await store.get(scope))!.state;
      assert.equal(state.words[firstTarget]!.practiceModes.recall, 1);
      assert.equal(state.words[firstTarget]!.lastIndependentAt, null); // Immediate repetition is not delayed retention.
      assert.equal(state.words[firstTarget]!.stage, 0);
      assert.equal((await curriculum.get(other)).review.introduced, 0);
      const original = (
        await db.adminPool.query(
          'SELECT learning_status FROM product_gotit.learning_items WHERE id=$1',
          [historical],
        )
      ).rows[0]!;
      assert.equal(original.learning_status, 'new');
      const before = await db.adminPool.query(
        'SELECT count(*)::int count FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2',
        [applicationId, userId],
      );
      await practice.closeSession(scope, String(created.session.id), 'completed');
      assert.equal((await curriculum.get(scope)).practiceSessions.P01, undefined);
      const next = await practice.createSession(scope, randomUUID(), input);
      const nextCards = (await practice.studyCards(scope, String(next.session.id))).cards;
      assert.deepEqual(
        new Set(nextCards.map((card) => card.learningItemId)),
        new Set(cards.map((card) => card.learningItemId)),
      );
      assert.deepEqual(
        (
          await db.adminPool.query(
            'SELECT count(*)::int count FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2',
            [applicationId, userId],
          )
        ).rows,
        before.rows,
      );
    } finally {
      await db.dispose();
    }
  },
);
