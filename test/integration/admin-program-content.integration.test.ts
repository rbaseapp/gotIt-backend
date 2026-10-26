import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProductAdminService, type AdminActor } from '../../src/modules/admin/admin.service.js';
import { unitSaveSchema } from '../../src/modules/admin/admin.programs.js';
import { listSchema } from '../../src/modules/admin/admin.schemas.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { DEFAULT_LEARNING_POLICY } from '../../src/modules/learning/learning.policy.js';
import { WordPackRepository } from '../../src/modules/word-packs/word-packs.repository.js';
import { PostgresLearningDocumentStore } from '../../src/modules/courses/course.repository.js';
import { CourseService, publicCourse } from '../../src/modules/courses/course.service.js';
import { lessonMaterialSchema } from '../../src/modules/courses/lesson-material.schema.js';
import { plan, preferences } from '../helpers/course-fixtures.js';
import { unitLesson } from '../helpers/unit-path-fixtures.js';
import { PostgresPrivateLessonJournal } from '../../src/modules/private-lessons/private-lesson.repository.js';
import { buildRealtimeLessonContract } from '../../src/modules/private-lessons/private-lesson.realtime.js';
import { UnitReadingRepository, readingHash } from '../../src/modules/word-packs/unit-reading.js';
import { PrivateLessonService } from '../../src/modules/private-lessons/private-lesson.service.js';
import { adaptiveLesson, adaptiveCurriculum } from '../helpers/adaptive-lesson-fixtures.js';

const command = () => ({ operationId: randomUUID(), reason: 'Verify authored program content' });
test(
  'admin program content: scoped overrides, semantic revisions, templates, prompts and statistics',
  { timeout: 180000 },
  async (t) => {
    const db = await createTestDatabase();
    try {
      // Rehearse this exact migration even when a later sibling migration exists.
      const migration = await import(
        new URL('../../migrations/1792190000000_admin-program-content.js', import.meta.url).href
      );
      const statements: string[] = [];
      migration.down({ sql: (sql: string) => statements.push(sql) });
      for (const sql of statements) await db.adminPool.query(sql);
      statements.length = 0;
      migration.up({ sql: (sql: string) => statements.push(sql) });
      for (const sql of statements) await db.adminPool.query(sql);
      const applicationId = randomUUID(),
        otherApplicationId = randomUUID(),
        adminId = randomUUID(),
        userId = randomUUID(),
        otherId = randomUUID();
      await db.adminPool.query(
        `INSERT INTO core.applications(id,key,name) VALUES($1,$2,'Authoring'),($3,$4,'Other')`,
        [applicationId, randomUUID(), otherApplicationId, randomUUID()],
      );
      await db.adminPool.query(
        `INSERT INTO core.application_users(application_id,id,email,role,email_verified_at) VALUES($1,$2,'author@example.test','admin',now()),($1,$3,'learner@example.test','user',now()),($4,$5,'other@example.test','admin',now())`,
        [applicationId, adminId, userId, otherApplicationId, otherId],
      );
      const actor: AdminActor = {
        applicationId,
        applicationUserId: adminId,
        token: 'admin',
        requestId: randomUUID(),
      };
      const other: AdminActor = {
        ...actor,
        applicationId: otherApplicationId,
        applicationUserId: otherId,
        token: 'other',
      };
      let writable = true;
      const profiles = new ProfileService(new ProfileRepository(db.runtimePool));
      const owner = new ProductAdminService(
        db.runtimePool,
        {
          getAdminAccess: async (token) =>
            ({
              ...(token === 'other' ? other : actor),
              permissions: writable ? ['content.write'] : [],
              mfaVerified: true,
              mfaEnrolled: true,
            }) as any,
          getAdminUser: async () => ({ id: userId, status: 'active' as const }),
        },
        profiles,
        DEFAULT_LEARNING_POLICY,
      );
      const packs = new WordPackRepository(db.runtimePool),
        query = listSchema.parse({});
      await t.test(
        'station settings are scoped, reach learner catalog/maps and match admin previews',
        async () => {
          const guidedId = (
            await db.runtimePool.query(
              `SELECT p.id FROM product_gotit.word_packs p JOIN product_gotit.word_tracks tr ON tr.id=p.track_id JOIN product_gotit.word_topics t ON t.id=tr.topic_id WHERE t.slug IN ('daily-english','english-learning-path-en-he') AND tr.source_language_code='en' AND tr.translation_language_code='he' ORDER BY p.sort_order LIMIT 1`,
            )
          ).rows[0].id;
          const original = (await owner.programContent.units(actor, query, guidedId)).data as any;
          assert.equal(original.learningPath.enabled, true);
          assert.equal(original.learningPath.stations.length, 3);
          const total = original.content.entries.length;
          const content = {
            ...original.content,
            stationSettings: {
              supported: { requiredWords: Math.min(8, total), durationMinutes: 7 },
              midpoint: {
                requiredWords: Math.max(Math.min(8, total), Math.ceil(total * 0.6)),
                durationMinutes: 9,
              },
              review: { requiredWords: total, durationMinutes: 12 },
            },
          };
          await owner.programContent.saveUnit(
            actor,
            guidedId,
            unitSaveSchema.parse({ ...command(), expectedRevision: 0, content }),
          );
          const live = await packs.lessonUnit(actor, guidedId);
          assert.equal(
            live.teacherStations[0]!.requiredWords,
            content.stationSettings.supported.requiredWords,
          );
          assert.equal(live.teacherStations[0]!.durationMinutes, 7);
          assert.equal(
            (await packs.detail(actor, guidedId)).pack.teacherStations[1]!.durationMinutes,
            9,
          );
          assert.equal(
            (await packs.lessonUnit(other, guidedId)).teacherStations[0]!.durationMinutes,
            5,
          );
          const preview = await owner.programContent.previewUnit(actor, {
            unitId: guidedId,
            content,
            station: 'supported',
          });
          assert.match(preview.data.contract.session.instructions, /"durationSeconds": 420/);
          const loaded = (await owner.programContent.units(actor, query, guidedId)).data as any;
          assert.equal(loaded.learningPath.stations[0].durationMinutes, 7);
          // Leave other integration cases at the original content baseline.
          await db.runtimePool.query(
            `DELETE FROM product_gotit.admin_unit_content WHERE application_id=$1 AND pack_id=$2 AND application_user_id IS NULL`,
            [applicationId, guidedId],
          );
        },
      );
      const row = (await owner.programContent.units(actor, query)).data[0] as any;
      const packId = row.packId;
      const original = (await owner.programContent.units(actor, query, packId)).data as any;
      const content = structuredClone(original.content);
      content.entries[0]!.translationText = 'administrator authored meaning';
      content.title = 'Authored unit title';
      content.materials.supported = lessonMaterialSchema.parse({
        readingPassage: 'The learner reads this exact passage.',
        teacherInstructions: 'Ask one fresh question.',
        realtimeInstructions: 'Use this lesson objective.',
      });
      const save = unitSaveSchema.parse({ ...command(), expectedRevision: 0, content });
      await t.test(
        'shared edits are scoped to the application, replay safely and reject conflicts',
        async () => {
          const result = await owner.programContent.saveUnit(actor, packId, save);
          assert.equal(result.data.revision, 1);
          assert.deepEqual(await owner.programContent.saveUnit(actor, packId, save), result);
          const catalog = (await owner.list(actor, 'catalog-programs', query, original.programId))
            .data as any;
          const otherCatalog = (
            await owner.list(other, 'catalog-programs', query, original.programId)
          ).data as any;
          assert.equal(catalog.units.find((unit: any) => unit.id === packId).title, content.title);
          assert.notEqual(
            otherCatalog.units.find((unit: any) => unit.id === packId).title,
            content.title,
          );
          assert.equal(
            (await packs.detail(actor, packId)).entries[0]!.translationText,
            'administrator authored meaning',
          );
          assert.notEqual(
            (await packs.detail(other, packId)).entries[0]!.translationText,
            'administrator authored meaning',
          );
          await assert.rejects(
            () => owner.programContent.saveUnit(actor, packId, { ...save, ...command() }),
            { code: 'CONFLICT' },
          );
          writable = false;
          await assert.rejects(
            () =>
              owner.programContent.saveUnit(actor, packId, {
                ...save,
                ...command(),
                expectedRevision: 1,
              }),
            { code: 'PERMISSION_REQUIRED' },
          );
          writable = true;
        },
      );
      await t.test(
        'learner edits use the existing semantic revision/reset transaction',
        async () => {
          await profiles.getProfile({ applicationId, applicationUserId: userId });
          await packs.add({ applicationId, applicationUserId: userId }, packId, {
            entryIds: [content.entries[0].id],
          });
          const id = `${userId}_${packId}`;
          const learner = (await owner.programContent.units(actor, query, id, true)).data as any;
          learner.content.entries[0]!.translationText = 'learner-specific meaning';
          const input = unitSaveSchema.parse({
            ...command(),
            expectedRevision: 0,
            content: learner.content,
          });
          const result = await owner.programContent.saveUnit(actor, id, input);
          assert.equal(result.data.applicationUserId, userId);
          const item = (
            await db.runtimePool.query(
              `SELECT li.learning_revision,li.learning_status FROM product_gotit.learning_item_pack_entries l JOIN product_gotit.learning_items li ON li.application_id=l.application_id AND li.application_user_id=l.application_user_id AND li.id=l.learning_item_id WHERE l.application_id=$1 AND l.application_user_id=$2 AND l.pack_id=$3`,
              [applicationId, userId, packId],
            )
          ).rows[0];
          assert.equal(item.learning_revision, 2);
          assert.equal(item.learning_status, 'new');
          assert.equal(
            (await packs.detail({ applicationId, applicationUserId: userId }, packId)).entries[0]!
              .translationText,
            'learner-specific meaning',
          );
          await assert.rejects(() => owner.programContent.units(other, query, id, true), {
            code: 'NOT_FOUND',
          });
          await assert.rejects(() => owner.programContent.saveUnit(other, id, input), {
            code: 'NOT_FOUND',
          });
        },
      );
      await t.test(
        'studio drafts, immutable published history, reading revisions and authoring receipts stay scoped',
        async () => {
          const studioPackId = (
            await db.runtimePool.query(
              `SELECT p.id FROM product_gotit.word_packs p JOIN product_gotit.word_tracks tr ON tr.id=p.track_id JOIN product_gotit.word_topics t ON t.id=tr.topic_id WHERE t.slug IN ('daily-english','english-learning-path-en-he') AND tr.source_language_code='en' AND tr.translation_language_code='he' ORDER BY p.sort_order LIMIT 1`,
            )
          ).rows[0].id;
          const current = (await owner.programContent.units(actor, query, studioPackId))
            .data as any;
          const draft = { ...structuredClone(current.content), title: 'Unpublished studio draft' };
          const draftInput = unitSaveSchema.parse({
            ...command(),
            expectedRevision: current.revision,
            content: draft,
          });
          const saved = await owner.programContent.draft(actor, studioPackId, draftInput);
          assert.deepEqual(
            await owner.programContent.draft(actor, studioPackId, draftInput),
            saved,
          );
          assert.equal(
            ((await owner.programContent.units(actor, query, studioPackId)).data as any).content
              .title,
            current.content.title,
          );
          const history = await owner.programContent.history(actor, studioPackId);
          assert.ok(history.data.some((row) => row.kind === 'draft'));
          assert.equal(history.data[0].content, undefined);
          const restored = await owner.programContent.history(
            actor,
            studioPackId,
            saved.data.id as string,
          );
          assert.equal(restored.data[0].content.title, draft.title);
          assert.equal((await owner.programContent.history(other, studioPackId)).data.length, 0);
          const reading = {
            id: 'intro',
            title: 'A short reading',
            passage: 'Hello, Maya.',
            after: 'supported:meeting' as const,
            estimatedMinutes: 2,
            questions: ['Who is greeted?'],
          };
          const scripted = adaptiveCurriculum(adaptiveLesson(300));
          for (const activity of scripted.activities)
            activity.requiredWords = [current.content.entries[0].sourceText];
          const scriptedMaterial = lessonMaterialSchema.parse({
            adaptationPolicy: 'authored_only',
            teachingPlan: scripted,
            words: [
              {
                sourceText: current.content.entries[0].sourceText,
                translationText: current.content.entries[0].translationText,
                exampleText: '',
              },
            ],
          });
          const nextContent = {
            ...current.content,
            readingSteps: [reading],
            materials: { ...current.content.materials, supported: scriptedMaterial },
          };
          await owner.programContent.saveUnit(
            actor,
            studioPackId,
            unitSaveSchema.parse({
              ...command(),
              expectedRevision: current.revision,
              content: nextContent,
            }),
          );
          const progress = new UnitReadingRepository(db.runtimePool);
          const service = new PrivateLessonService({
            model: 'fixture',
            voice: 'fixture',
            transcriptionModel: 'fixture',
            profiles,
            vocabulary: { learned: async () => ({ items: [] }) },
            wordPacks: packs,
            readingProgress: progress,
          });
          const map = await service.getLearningMap(actor, studioPackId);
          const resolved = await packs.lessonUnit(actor, studioPackId);
          assert.deepEqual(
            resolved.stageWordsByStation?.supported?.map((word) => word.sourceText),
            [current.content.entries[0].sourceText],
          );
          assert.equal((await service.getPreparedUnit(actor, studioPackId)).materials, undefined);
          assert.equal(map.readings[0]?.complete, false);
          await assert.rejects(
            () => service.completeReading(actor, studioPackId, 'intro', '0'.repeat(64)),
            { code: 'CONFLICT' },
          );
          const complete = await service.completeReading(
            actor,
            studioPackId,
            'intro',
            readingHash(reading),
          );
          assert.equal(complete.readings[0]?.complete, true);
          await service.completeReading(actor, studioPackId, 'intro', readingHash(reading));
          assert.equal((await progress.completed(other, studioPackId)).length, 0);
          assert.equal((await progress.completed(actor, studioPackId)).length, 1);
          const after = (await owner.programContent.units(actor, query, studioPackId)).data as any;
          await owner.programContent.saveUnit(
            actor,
            studioPackId,
            unitSaveSchema.parse({
              ...command(),
              expectedRevision: after.revision,
              content: { ...nextContent, readingSteps: [{ ...reading, passage: 'Hello, Alex.' }] },
            }),
          );
          assert.equal(
            (await service.getLearningMap(actor, studioPackId)).readings[0]?.complete,
            false,
          );
          let generations = 0;
          const authoringOwner: ProductAdminService = new ProductAdminService(
            db.runtimePool,
            {
              getAdminAccess: async () =>
                ({
                  ...actor,
                  permissions: ['content.write'],
                  mfaVerified: true,
                  mfaEnrolled: true,
                }) as any,
              getAdminUser: async () => ({ id: adminId, status: 'active' }),
            },
            profiles,
            DEFAULT_LEARNING_POLICY,
            {
              async generate(_scope, schema, name) {
                generations++;
                if (name === 'authoring_material') {
                  const strict = (node: any) => {
                    if (!node || typeof node !== 'object') return;
                    if (node.type === 'object') {
                      assert.equal(node.additionalProperties, false);
                      assert.deepEqual(
                        new Set(node.required),
                        new Set(Object.keys(node.properties ?? {})),
                      );
                    }
                    for (const value of Object.values(node))
                      if (typeof value === 'object')
                        Array.isArray(value) ? value.forEach(strict) : strict(value);
                  };
                  strict(z.toJSONSchema(schema, { io: 'input' }));
                  return schema.parse({
                    summary: 'Editable proposal',
                    durationMinutes: 5,
                    material: {
                      ...practiceMaterial,
                      objective: 'Directions',
                      prohibitedTopics: [],
                    },
                  });
                }
                if (name === 'private_lesson_answer')
                  return schema.parse({
                    result: 'independent',
                    feedback: 'A relevant question.',
                    retryQuestion: 'Ask for the missing information.',
                    evidenceQuote: 'Where is the station?',
                  });
                return schema.parse({ findings: [], summary: 'Reviewed' });
              },
              async transcribe() {
                return '';
              },
            },
          );
          const material = lessonMaterialSchema.parse({
            adaptationPolicy: 'authored_only',
            teachingPlan: adaptiveCurriculum(adaptiveLesson(300)),
          });
          const input = {
            ...command(),
            action: 'review' as const,
            instruction: '',
            context: {
              title: 'Travel',
              objective: 'Directions',
              targetLanguageCode: 'en',
              supportLanguageCode: 'he',
              level: 'A2' as const,
              durationMinutes: 5,
              words: [],
              ageGroup: 'adult' as const,
              literacy: 'independent' as const,
            },
            material,
          };
          const reviewed = await authoringOwner.authoring.run(actor, input);
          assert.deepEqual(await authoringOwner.authoring.run(actor, input), reviewed);
          assert.equal(generations, 1);
          await assert.rejects(
            () => authoringOwner.authoring.run(actor, { ...input, instruction: 'changed' }),
            { code: 'CONFLICT' },
          );
          const started = await authoringOwner.authoring.run(actor, {
            ...input,
            ...command(),
            action: 'start',
          });
          const rehearsal = started.data as any;
          const progressed = await authoringOwner.authoring.run(actor, {
            ...input,
            ...command(),
            action: 'act',
            rehearsal,
            command: {
              eventId: randomUUID(),
              revision: rehearsal.state.view.revision,
              activityId: rehearsal.state.view.activityId,
              action: 'answer',
              answer: 'Where is the station?',
              channel: 'text',
            },
          });
          assert.notEqual(
            (progressed.data as any).state.view.activityId,
            rehearsal.state.view.activityId,
          );
          const practiceMaterial = lessonMaterialSchema.parse({
            ...material,
            practice: {
              title: 'Directions practice',
              objective: 'Choose a direction',
              estimatedMinutes: 3,
              tasks: [0, 1, 2].map((index) => ({
                kind: 'choice',
                objective: 'Choose a direction',
                sourceActivityId: material.teachingPlan!.activities[index]!.id,
                prompt: 'Choose: left or right?',
                sourceQuote: 'Turn left.',
                choices: ['left', 'right'],
                tokens: [],
                listeningText: null,
                hint: 'Think of the direction.',
                explanation: 'Left is the requested direction.',
                expectedAnswer: 'left',
                acceptedAnswers: ['left'],
              })),
            },
          });
          const practice = await authoringOwner.authoring.run(actor, {
            ...input,
            ...command(),
            action: 'practice',
            material: practiceMaterial,
            practiceIndex: 0,
            practiceAnswer: 'left',
          });
          assert.equal((practice.data as any).practiceResult.attempts[0].result, 'correct');
          const proposal = await authoringOwner.authoring.run(actor, {
            ...input,
            ...command(),
            action: 'suggest',
            instruction: 'Keep the objective and prepare exact questions.',
          });
          assert.equal(
            (proposal.data as any).material.teachingPlan.activities.length,
            material.teachingPlan!.activities.length,
          );
          assert.equal(
            (
              await db.runtimePool.query(
                `SELECT count(*)::int AS n FROM product_gotit.learning_documents WHERE application_id=$1 AND application_user_id=$2 AND kind IN ('course','homework')`,
                [actor.applicationId, actor.applicationUserId],
              )
            ).rows[0].n,
            0,
          );
          const migration = await import(
            new URL('../../migrations/1792970000000_curriculum-studio.js', import.meta.url).href
          );
          const sql: string[] = [];
          migration.down({ sql: (value: string) => sql.push(value) });
          await assert.rejects(
            () => db.adminPool.query(sql[0]!),
            /Curriculum history or reading progress exists/,
          );
        },
      );
      await t.test(
        'published templates are discoverable, imported idempotently and keep answers private',
        async () => {
          const authored = structuredClone(plan);
          authored.units[0]!.lessons[0]!.material = lessonMaterialSchema.parse({
            teacherInstructions: 'A special teacher task',
            readingPassage: 'An exact reading passage',
            words: [{ sourceText: 'apple', translationText: 'fruit', exampleText: 'An apple.' }],
          });
          const saved = await owner.save(actor, 'programs', null, {
            ...command(),
            expectedRevision: null,
            document: {
              key: 'authored-template',
              title: 'Public program',
              content: { preferences, plan: authored },
            },
          });
          const id = saved.data.id as string;
          await owner.publish(actor, 'programs', id, {
            ...command(),
            expectedRevision: 0,
            expectedActiveId: null,
          });
          const store = new PostgresLearningDocumentStore(db.runtimePool),
            courses = new CourseService(store, profiles);
          const listing = await courses.list({ applicationId, applicationUserId: userId });
          assert.equal(listing.templates[0]?.id, id);
          assert.equal((await courses.list(other)).templates.length, 0);
          const eventId = randomUUID();
          const first = await courses.useTemplate(
            { applicationId, applicationUserId: userId },
            id,
            eventId,
          );
          assert.deepEqual(
            await courses.useTemplate({ applicationId, applicationUserId: userId }, id, eventId),
            first,
          );
          assert.ok(!JSON.stringify(first).includes('A special teacher task'));
          const context = await courses.lessonContext(
            { applicationId, applicationUserId: userId },
            first.id,
          );
          assert.equal(context.material?.readingPassage, 'An exact reading passage');
          const preview = await owner.programContent.preview(actor, {
            preferences,
            plan: authored,
            unitKey: authored.units[0]!.key,
            lessonIndex: 0,
          });
          assert.match(preview.data.contract.session.instructions, /A special teacher task/);
          const stored = await store.get({ applicationId, applicationUserId: userId }, first.id);
          assert.ok(stored?.kind === 'course');
          stored.evidence = [
            {
              lessonId: randomUUID(),
              version: 1,
              unitKey: authored.units[0]!.key,
              lessonIndex: 0,
              covered: true,
              independent: true,
              recordedAt: new Date().toISOString(),
            },
          ];
          await db.runtimePool.query(
            `UPDATE product_gotit.learning_documents SET document=$4::jsonb WHERE application_id=$1 AND application_user_id=$2 AND id=$3`,
            [applicationId, userId, first.id, JSON.stringify(stored)],
          );
          const revised = structuredClone(authored);
          revised.units[0]!.lessons[0]!.objective = 'A revised objective for this learner';
          const input = {
            ...command(),
            expectedRevision: 0,
            document: {
              key: first.id,
              title: revised.title,
              content: { preferences, plan: revised },
            },
          };
          await assert.rejects(
            () => owner.updateAssignment(actor, `${userId}_${first.id}`, input),
            { code: 'PLAN_INVALID' },
          );
          await owner.updateAssignment(actor, `${userId}_${first.id}`, {
            ...input,
            reviseCompleted: true,
          });
          await owner.activateAssignment(actor, `${userId}_${first.id}`, {
            ...command(),
            expectedRevision: 1,
          });
          const active = await courses.course(
            { applicationId, applicationUserId: userId },
            first.id,
          );
          assert.deepEqual(active.evidence, stored.evidence);
          assert.equal(publicCourse(active).progress.demonstrated, 0);
        },
      );
      await t.test(
        'lesson details and aggregates cannot cross application boundaries',
        async () => {
          const lesson = unitLesson(),
            id = lesson.id;
          lesson.wordPack!.packId = packId;
          const contract = buildRealtimeLessonContract(lesson, {
            model: 'fixture',
            transcriptionModel: 'fixture',
          });
          await new PostgresPrivateLessonJournal(db.runtimePool).create(
            { applicationId, applicationUserId: userId },
            { ...lesson, realtimeContract: contract },
          );
          const listed = await owner.programContent.lessons(actor, query);
          assert.equal((listed as any).summary.lessons, 1);
          assert.equal(
            ((await owner.programContent.lessons(actor, query, id)).data as any).realtimeContract
              .session.instructions,
            contract.session.instructions,
          );
          assert.equal(
            (
              (await owner.programContent.lessons(
                actor,
                listSchema.parse({ q: `${userId}_${packId}` }),
              )) as any
            ).total,
            1,
          );
          assert.equal(
            (
              (await owner.programContent.lessons(
                actor,
                listSchema.parse({ q: `${adminId}_${packId}` }),
              )) as any
            ).total,
            0,
          );
          await assert.rejects(() => owner.programContent.lessons(other, query, id), {
            code: 'NOT_FOUND',
          });
          assert.equal(
            ((await owner.programContent.lessons(other, query)) as any).summary.lessons,
            0,
          );
          const statements: string[] = [];
          migration.down({ sql: (sql: string) => statements.push(sql) });
          await assert.rejects(
            () => db.adminPool.query(statements[0]!),
            /Authored content or prompt snapshots exist/,
          );
        },
      );
    } finally {
      await db.dispose();
    }
  },
);
