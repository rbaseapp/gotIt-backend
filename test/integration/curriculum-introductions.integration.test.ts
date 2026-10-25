import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTestDatabase } from '../helpers/postgres.js';
import { adaptiveLesson } from '../helpers/adaptive-lesson-fixtures.js';
import { CurriculumStore } from '../../src/modules/curriculum/curriculum.store.js';
import { CurriculumService } from '../../src/modules/curriculum/curriculum.service.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { PostgresPrivateLessonJournal } from '../../src/modules/private-lessons/private-lesson.repository.js';
import { PROGRAM_ID, PROGRAM_VERSION } from '../../src/modules/curriculum/curriculum.content.js';

test(
  'postlesson uses its completed tutor, keeps progress and accepts own-name answers with scoped frozen questions',
  { timeout: 180000 },
  async () => {
    const db = await createTestDatabase();
    try {
      const applicationId = randomUUID();
      await db.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,$2,'Introduction test')",
        [applicationId, randomUUID()],
      );
      const profiles = new ProfileService(new ProfileRepository(db.runtimePool));
      const store = new CurriculumStore(db.runtimePool);
      const journal = new PostgresPrivateLessonJournal(db.runtimePool);
      let evaluations = 0;
      const service = new CurriculumService(store, profiles, {
        async generate(_scope, schema, name, instruction, data) {
          assert.equal(name, 'curriculum_answer');
          assert.match(instruction, /never mark it wrong for differing from a sample name/);
          const input = data as { question: { kind: string }; learnerAnswer: string };
          if (
            input.question.kind === 'roleplay_rehearsal' ||
            input.question.kind === 'writing_or_recording_project'
          )
            assert.match(input.learnerAnswer, /My name is Ori/);
          evaluations++;
          return schema.parse({
            correct: true,
            message: true,
            criteria: [true, true, true, true],
            feedback: 'A meaningful answer.',
            relevantTargetUsed: true,
          });
        },
        async transcribe() {
          return 'My name is Ori.';
        },
      });
      await db.adminPool.query(
        'UPDATE product_gotit.structured_program_versions SET visible=true WHERE program_id=$1 AND version=$2',
        [PROGRAM_ID, PROGRAM_VERSION],
      );
      let foreignSource: string | undefined;
      for (const voice of ['male', 'female'] as const) {
        const scope = { applicationId, applicationUserId: randomUUID() };
        await db.adminPool.query(
          "INSERT INTO core.application_users(application_id,id,email,role,email_verified_at) VALUES($1,$2,$3,'user',now())",
          [applicationId, scope.applicationUserId, `${randomUUID()}@example.test`],
        );
        await profiles.getProfile(scope);
        await service.enroll(scope, { eventId: randomUUID(), minutes: 10, literacy: 'starting' });
        const preference = voice === 'male' ? 'female' : 'male';
        await db.runtimePool.query(
          "INSERT INTO product_gotit.private_lesson_preferences(application_id,application_user_id,target_language_code,teacher_voice) VALUES($1,$2,'en',$3)",
          [applicationId, scope.applicationUserId, preference],
        );
        const plan = { ...adaptiveLesson(), teacherVoice: voice };
        await journal.create(scope, plan);
        await db.runtimePool.query(
          "UPDATE product_gotit.private_lesson_sessions SET status='completed' WHERE id=$1 AND application_id=$2 AND application_user_id=$3",
          [plan.id, applicationId, scope.applicationUserId],
        );
        const enrollment = (await store.get(scope))!;
        enrollment.state.completed['teacher:P01-L2'] = {
          at: new Date().toISOString(),
          score: 1,
          independent: false,
          source: plan.id,
        };
        enrollment.state.cursors['teacher:P01-L2'] = 18;
        await db.runtimePool.query(
          'UPDATE product_gotit.structured_program_enrollments SET state=$3::jsonb WHERE application_id=$1 AND application_user_id=$2',
          [applicationId, scope.applicationUserId, JSON.stringify(enrollment.state)],
        );
        if (foreignSource)
          assert.equal(
            await store.teacherVoice(scope, foreignSource),
            preference,
            'foreign lesson cannot override this learner preference',
          );
        foreignSource = plan.id;
        const unit = await service.unit(scope, 'P01');
        assert.equal(unit.unit.title, 'שלום, מציגים את עצמנו');
        assert.doesNotMatch(JSON.stringify(unit), /\{\{teacherName|נועה/u);
        const command = {
          eventId: randomUUID(),
          revision: (await store.get(scope))!.revision,
          activityId: 'post:P01-L2',
        };
        const started = await service.start(scope, command);
        assert.deepEqual(await service.start(scope, command), started);
        let attempt = await store.attempt(scope, started.id);
        assert.ok(
          String(attempt.payload.questions[10]!.answer_anchor_en).includes(
            voice === 'male' ? 'Mike' : 'Rachel',
          ),
        );
        assert.doesNotMatch(
          JSON.stringify(attempt.payload.questions),
          /\b(?:Noa|Ben)\b|נועה|\{\{teacherName/u,
        );
        assert.equal(
          attempt.payload.questions[6]!.passage_en,
          attempt.payload.questions[8]!.passage_en,
        );
        await db.runtimePool.query(
          'UPDATE product_gotit.private_lesson_preferences SET teacher_voice=$3 WHERE application_id=$1 AND application_user_id=$2',
          [applicationId, scope.applicationUserId, voice],
        );
        assert.deepEqual(
          (await store.attempt(scope, started.id)).payload.questions,
          attempt.payload.questions,
        );
        while (!attempt.result) {
          const question = attempt.payload.questions[attempt.payload.cursor]!;
          const ownName = ['roleplay_rehearsal', 'writing_or_recording_project'].includes(
            question.kind!,
          );
          const input = {
            eventId: randomUUID(),
            revision: (await store.get(scope))!.revision,
            attemptId: attempt.id,
            cursor: attempt.payload.cursor,
            answer: ownName ? 'Hello. My name is Ori. Goodbye.' : String(question.answer_en),
            modality: 'typed' as const,
          };
          const result = await service.answer(scope, input);
          const calls = evaluations;
          assert.deepEqual(await service.answer(scope, input), result);
          assert.equal(evaluations, calls);
          attempt = await store.attempt(scope, attempt.id);
        }
        assert.ok(attempt.payload.grades[10]!.correct);
        assert.ok(attempt.payload.grades[11]!.correct);
        assert.equal((await store.get(scope))!.state.completed['teacher:P01-L2']!.source, plan.id);
        assert.equal((await store.get(scope))!.state.cursors['teacher:P01-L2'], 18);
      }
    } finally {
      await db.dispose();
    }
  },
);
