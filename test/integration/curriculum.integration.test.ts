import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { CurriculumStore } from '../../src/modules/curriculum/curriculum.store.js';
import { CurriculumService } from '../../src/modules/curriculum/curriculum.service.js';
import { WordPackRepository } from '../../src/modules/word-packs/word-packs.repository.js';
import { lexicon } from '../../src/modules/curriculum/curriculum.content.js';

test(
  'curriculum runtime preserves legacy data, scopes attempts, resumes and replays server-scored evidence',
  { timeout: 180000 },
  async () => {
    const db = await createTestDatabase();
    try {
      const applicationId = randomUUID(),
        userId = randomUUID(),
        otherUserId = randomUUID();
      await db.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,$2,'Curriculum test')",
        [applicationId, randomUUID()],
      );
      await db.adminPool.query(
        "INSERT INTO core.application_users(application_id,id,email,role,email_verified_at) VALUES($1,$2,'curriculum@example.test','user',now()),($1,$3,'other@example.test','user',now())",
        [applicationId, userId, otherUserId],
      );
      const scope = { applicationId, applicationUserId: userId },
        other = { applicationId, applicationUserId: otherUserId };
      const profiles = new ProfileService(new ProfileRepository(db.runtimePool));
      await profiles.getProfile(other);
      const store = new CurriculumStore(db.runtimePool);
      let now = new Date('2026-01-01T12:00:00Z');
      let calls = 0,
        failTeacher = false;
      const service = new CurriculumService(
        store,
        profiles,
        {
          generate: async (_scope, schema, name) => {
            calls++;
            if (name === 'curriculum_teacher_turn') {
              if (failTeacher) {
                failTeacher = false;
                throw new Error('Simulated provider interruption');
              }
              return schema.parse({
                feedback: 'Continue with the authored lesson.',
                advance: true,
                assisted: true,
                attempted: true,
              });
            }
            if (name === 'curriculum_reading_review')
              return schema.parse({ valid: true, issues: [] });
            if (name === 'curriculum_reading')
              return schema.parse({
                title: 'A greeting',
                text: 'Hello. I am Ben. You are Sam. Hello, Sam. I am Ben. I am Sam. Hello, Ben. Hello, Sam. Goodbye.',
                targetSpans: [
                  { targetId: 'P01-T01', quote: 'Hello' },
                  { targetId: 'P01-T04', quote: 'I' },
                ],
                questions: Array.from({ length: 6 }, () => ({
                  question_he: 'מי הדובר?',
                  question_en: 'Who is speaking?',
                  answer_en: 'Ben.',
                  type: 'detail',
                })),
              });
            return schema.parse({
              correct: true,
              message: true,
              criteria: [true, true, true, true],
              feedback: 'Meaning fits the task.',
              relevantTargetUsed: true,
            });
          },
          transcribe: async () => 'hello',
        },
        undefined,
        () => now,
      );
      assert.deepEqual((await service.catalog()).programs, []);
      const before = (
        await db.adminPool.query('SELECT count(*)::int n FROM product_gotit.word_packs')
      ).rows[0]!.n;
      const packs = new WordPackRepository(db.runtimePool);
      await profiles.getProfile(scope);
      const legacy = (
        await packs.list(scope, { sourceLanguageCode: 'en', translationLanguageCode: 'he' })
      ).packs;
      const old = legacy.find((pack) => pack.topic.slug === 'english-learning-path-en-he')!;
      assert.ok(old);
      await db.adminPool.query(
        "UPDATE product_gotit.structured_program_versions SET visible=true WHERE program_id='english-zero-c1'",
      );
      await db.adminPool.query(
        "INSERT INTO product_gotit.structured_program_catalog_overrides(topic_slug,hidden) VALUES('english-learning-path-en-he',true)",
      );
      assert.ok(
        !(
          await packs.list(scope, { sourceLanguageCode: 'en', translationLanguageCode: 'he' })
        ).packs.some((pack) => pack.topic.slug === 'english-learning-path-en-he'),
      );
      assert.equal((await packs.detail(scope, old.id)).pack.id, old.id);
      assert.equal(
        (await db.adminPool.query('SELECT count(*)::int n FROM product_gotit.word_packs')).rows[0]!
          .n,
        before,
      );
      await service.enroll(scope, { eventId: randomUUID(), minutes: 10, literacy: 'starting' });
      const initial = await service.get(scope);
      assert.equal(initial.units.length, 84);
      assert.equal(initial.phonics.length, 24);
      assert.equal(initial.review.introduced, 0);
      assert.equal(initial.units.filter((unit) => unit.unlocked).length, 84);
      assert.equal((await service.unit(scope, 'C118')).unit.id, 'C118');
      const ids = lexicon.targets
        .filter((target) => target.unit === 'P01')
        .slice(0, 6)
        .map((target) => target.id);
      const eventId = randomUUID(),
        input = { eventId, revision: initial.revision, targetIds: ids };
      await service.expose(scope, input);
      await service.expose(scope, input);
      assert.equal((await service.get(scope)).review.introduced, 6);
      await assert.rejects(service.expose(scope, { ...input, targetIds: ids.slice(0, 3) }));
      const revision = (await service.get(scope)).revision;
      await service.heartbeat(scope, { eventId: randomUUID(), activityId: 'unit:P01' });
      now = new Date(+now + 20_000);
      await service.heartbeat(scope, { eventId: randomUUID(), activityId: 'unit:P01' });
      assert.equal((await service.get(scope)).revision, revision);
      assert.equal((await store.get(scope))!.state.activeSeconds, 20);
      assert.ok(
        (
          await service.start(scope, {
            eventId: randomUUID(),
            revision,
            activityId: 'words:P01:recall',
          })
        ).id,
      );
      for (const game of ['recognition', 'matching']) {
        const round = await service.start(scope, {
          eventId: randomUUID(),
          revision: (await service.get(scope)).revision,
          activityId: `words:P01:${game}`,
        });
        for (let cursor = 0; cursor < round.total; cursor++) {
          const q = (await store.attempt(scope, round.id)).payload.questions[cursor]!;
          await service.answer(scope, {
            eventId: randomUUID(),
            revision: (await service.get(scope)).revision,
            attemptId: round.id,
            cursor,
            answer: '',
            choiceId: String(q.correct_choice_id),
            modality: 'typed',
          });
        }
      }
      const started = await service.start(scope, {
        eventId: randomUUID(),
        revision: (await service.get(scope)).revision,
        activityId: 'words:P01:recall',
      });
      assert.ok(started.question);
      assert.equal(started.question!.choices, null);
      assert.ok(!JSON.stringify(started).includes('answer_en'));
      assert.ok(!JSON.stringify(started).includes('correct_choice_id'));
      const resumed = await service.start(scope, {
        eventId: randomUUID(),
        revision: (await service.get(scope)).revision,
        activityId: 'words:P01:recall',
      });
      assert.equal(resumed.id, started.id);
      await assert.rejects(service.getAttempt(other, started.id));
      const attempt = await store.attempt(scope, started.id),
        q = attempt.payload.questions[0]!;
      now = new Date('2026-01-02T12:00:00Z');
      const answerInput = {
        eventId: randomUUID(),
        revision: (await service.get(scope)).revision,
        attemptId: started.id,
        cursor: 0,
        answer: q.answer_en!,
        modality: 'typed' as const,
      };
      const scored = await service.answer(scope, answerInput);
      assert.equal((scored as { cursor: number }).cursor, 1);
      assert.deepEqual(await service.answer(scope, answerInput), scored);
      await assert.rejects(service.answer(scope, { ...answerInput, answer: 'changed' }));
      assert.equal(calls, 0);
      const saved = (await store.get(scope))!.state.words[String(q.target_id)]!;
      assert.equal(saved.stage, 1);
      assert.equal(saved.independentDays.length, 1);
      const hintInput = {
        eventId: randomUUID(),
        revision: (await service.get(scope)).revision,
        attemptId: started.id,
        cursor: 1,
      };
      await service.hint(scope, hintInput);
      const second = (await store.attempt(scope, started.id)).payload.questions[1]!;
      await service.answer(scope, {
        eventId: randomUUID(),
        revision: (await service.get(scope)).revision,
        attemptId: started.id,
        cursor: 1,
        answer: second.answer_en!,
        modality: 'typed',
      });
      assert.equal((await store.get(scope))!.state.words[String(second.target_id)]!.stage, 0);
      const phonics = await service.start(scope, {
        eventId: randomUUID(),
        revision: (await service.get(scope)).revision,
        activityId: 'phonics:F01',
      });
      assert.ok(!JSON.stringify(phonics.question).includes('answer'));
      assert.ok(!JSON.stringify(phonics.question).includes('audio:'));
      assert.ok(
        (
          await service.start(scope, {
            eventId: randomUUID(),
            revision: (await service.get(scope)).revision,
            activityId: 'phonics:F24',
          })
        ).id,
      );
      await service.saveWork(scope, {
        eventId: randomUUID(),
        revision: (await service.get(scope)).revision,
        activityId: 'teacher:P01-L1',
        draft: 'A saved question',
        cursor: 200,
      });
      assert.equal((await store.get(scope))!.state.cursors['teacher:P01-L1'], undefined);
      assert.equal((await store.get(scope))!.state.drafts['teacher:P01-L1'], 'A saved question');
      await assert.rejects(
        service.generateArticle(scope, {
          eventId: randomUUID(),
          revision: (await service.get(scope)).revision,
        }),
      );
      const definition = (
        await db.adminPool.query(
          "SELECT jsonb_array_length(content->'lessons') lessons,jsonb_array_length(lexicon->'targets') targets FROM product_gotit.structured_program_versions WHERE program_id='english-zero-c1'",
        )
      ).rows[0]!;
      assert.equal(definition.lessons, 168);
      assert.equal(definition.targets, 3424);
      const teacherInput = {
        eventId: randomUUID(),
        revision: (await service.get(scope)).revision,
        lessonId: 'P01-L1',
        answer: 'I understand.',
      };
      const teacherReply = await service.teacherTurn(scope, teacherInput),
        teacherCalls = calls;
      assert.deepEqual(await service.teacherTurn(scope, teacherInput), teacherReply);
      assert.equal(calls, teacherCalls);
      assert.equal((await store.get(scope))!.state.cursors['teacher:P01-L1'], 1);
      const interrupted = {
        eventId: randomUUID(),
        revision: (await service.get(scope)).revision,
        lessonId: 'P01-L1',
        answer: 'hello',
      };
      failTeacher = true;
      await assert.rejects(service.teacherTurn(scope, interrupted));
      assert.equal((await store.get(scope))!.state.cursors['teacher:P01-L1'], 1);
      await service.teacherTurn(scope, interrupted);
      assert.equal((await store.get(scope))!.state.cursors['teacher:P01-L1'], 2);
      await db.runtimePool.query(
        `UPDATE product_gotit.structured_program_enrollments SET state=jsonb_set(state,'{activeSeconds}','1800'::jsonb),revision=revision+1
      WHERE application_id=$1 AND application_user_id=$2`,
        [applicationId, userId],
      );
      const readingInput = { eventId: randomUUID(), revision: (await service.get(scope)).revision };
      const reading = await service.generateArticle(scope, readingInput);
      assert.equal(reading.status, 'ready');
      assert.equal(reading.mode, 'guided');
      assert.equal(reading.attempt!.question!.hasAudio, true);
      assert.ok(!JSON.stringify(reading).includes('targetSpans'));
      assert.ok(!JSON.stringify(reading).includes('answer_en'));
      const readingCalls = calls;
      assert.equal((await service.generateArticle(scope, readingInput)).id, reading.id);
      assert.equal(calls, readingCalls);
      assert.equal((await service.get(scope)).reading.eligible, false);
      await assert.rejects(service.article(other, reading.id));
      assert.equal((await service.get(scope)).graduation.complete, false);
      const migration = await import(
        new URL('../../migrations/1792530000000_english-zero-c1-runtime.js', import.meta.url).href
      );
      const statements: string[] = [];
      migration.down({ sql: (sql: string) => statements.push(sql) });
      await assert.rejects(db.adminPool.query(statements.join('\n')), /rollback is protected/u);
      assert.equal((await service.get(scope)).review.introduced, 6);
      assert.ok(
        (
          await service.start(scope, {
            eventId: randomUUID(),
            revision: (await service.get(scope)).revision,
            activityId: 'exit:reading',
          })
        ).id,
      );
      assert.equal((await service.get(scope)).graduation.complete, false);
    } finally {
      await db.dispose();
    }
  },
);
