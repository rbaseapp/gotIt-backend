import { z } from 'zod';
import { AppError } from '../../shared/errors/app-error.js';
import { LibraryRepository } from '../library/library.repository.js';
import { lookupText } from '../capture/capture.validation.js';
import {
  coursePlanSchema,
  coursePreferencesSchema,
  type CourseLessonContext,
} from '../courses/course.schemas.js';
import {
  buildRealtimeLessonContract,
  type RealtimeDefaults,
} from '../private-lessons/private-lesson.realtime.js';
import type { PrivateLessonPlan } from '../private-lessons/private-lesson.prompt.js';
import { unitContentSchema } from './admin.unit-content.js';
import { commandSchema, listSchema } from './admin.schemas.js';
import type { AdminActor, ProductAdminService } from './admin.service.js';
import { supportsTeacherStations, teacherStations } from '../word-packs/teacher-stations.js';

export const unitIdSchema = z
  .string()
  .min(36)
  .max(73)
  .refine((id) => {
    const parts = id.split('_');
    return parts.length <= 2 && parts.every((part) => z.uuid().safeParse(part).success);
  });
export const unitSaveSchema = commandSchema
  .extend({ expectedRevision: z.number().int().nonnegative(), content: unitContentSchema })
  .strict();
export const lessonPreviewSchema = z
  .object({
    preferences: coursePreferencesSchema,
    plan: coursePlanSchema,
    unitKey: z.string().max(70),
    lessonIndex: z.number().int().min(0).max(9),
  })
  .strict();
export const unitPreviewSchema = z
  .object({
    unitId: unitIdSchema,
    content: unitContentSchema,
    station: z.enum(['supported', 'midpoint', 'review']),
  })
  .strict();
const missing = () => new AppError(404, 'NOT_FOUND', 'Learning content not found');
const conflict = () =>
  new AppError(409, 'CONFLICT', 'Learning content changed; reload before saving');
export class ProgramAdmin {
  constructor(
    private readonly owner: ProductAdminService,
    private readonly defaults: RealtimeDefaults,
  ) {}
  async previewUnit(actor: AdminActor, input: z.infer<typeof unitPreviewSchema>) {
    await this.units(actor, listSchema.parse({}), input.unitId, input.unitId.includes('_'));
    const packId = input.unitId.split('_').at(-1)!;
    const metadata = (
      await this.owner.db.query(
        `SELECT p.module_number,tr.source_language_code,tr.translation_language_code,tr.cefr_from FROM product_gotit.word_packs p JOIN product_gotit.word_tracks tr ON tr.id=p.track_id WHERE p.id=$1`,
        [packId],
      )
    ).rows[0];
    if (!metadata) throw missing();
    const plan: PrivateLessonPlan = {
      id: packId,
      durationSeconds:
        teacherStations(input.content.entries.length, 0, input.content.stationSettings).find(
          (station) => station.station === input.station,
        )!.durationMinutes * 60,
      targetLanguageCode: metadata.source_language_code,
      supportLanguageCode: metadata.translation_language_code,
      level: metadata.cefr_from,
      lessonMode: metadata.cefr_from === 'A1' ? 'absolute_beginner' : 'standard',
      teachingLanguage: 'support',
      topic: input.content.title,
      grammarFocus: null,
      focusAreas: ['speaking', 'vocabulary'],
      customFocus: null,
      correctionMode: 'recast',
      vocabularyMode: 'learned',
      teacherVoice: 'female',
      speechRate: 'normal',
      interests: [],
      targets: [],
      continuity: null,
      wordPack: {
        packId,
        title: input.content.title,
        moduleNumber: metadata.module_number,
        targetLanguageCode: metadata.source_language_code,
        supportLanguageCode: metadata.translation_language_code,
        level: metadata.cefr_from,
        station: input.station,
        introduced: input.content.entries.length,
        completed: 0,
        total: input.content.entries.length,
        teacherStations: [],
        words: input.content.entries.map((entry) => ({
          ...entry,
          introduced: true,
          learningItemId: null,
        })),
        material: input.content.materials[input.station],
      },
    };
    const runtime = await this.owner.runtime(actor, actor.requestId);
    return {
      data: {
        id: packId,
        kind: 'unit-preview',
        contract: buildRealtimeLessonContract(plan, this.defaults, runtime.prompts['lesson-live']),
      },
    };
  }
  async units(actor: AdminActor, query: z.infer<typeof listSchema>, id?: string, learners = false) {
    await this.owner.access(actor);
    const source = learners
      ? `SELECT up.application_user_id::text||'_'||p.id::text AS id,up.application_user_id AS "applicationUserId",p.id AS "packId",COALESCE((SELECT c.content->>'title' FROM product_gotit.admin_unit_content c WHERE c.application_id=$1 AND c.pack_id=p.id AND (c.application_user_id=up.application_user_id OR c.application_user_id IS NULL) ORDER BY c.application_user_id NULLS LAST LIMIT 1),p.title) AS title,t.title AS program,tr.title AS track,up.status FROM product_gotit.user_word_packs up JOIN product_gotit.word_packs p ON p.id=up.pack_id JOIN product_gotit.word_tracks tr ON tr.id=p.track_id JOIN product_gotit.word_topics t ON t.id=tr.topic_id WHERE up.application_id=$1`
      : `SELECT p.id::text AS id,NULL::uuid AS "applicationUserId",p.id AS "packId",COALESCE((SELECT c.content->>'title' FROM product_gotit.admin_unit_content c WHERE c.application_id=$1 AND c.pack_id=p.id AND c.application_user_id IS NULL),p.title) AS title,t.title AS program,tr.title AS track,CASE WHEN p.is_active THEN 'active' ELSE 'inactive' END AS status FROM product_gotit.word_packs p JOIN product_gotit.word_tracks tr ON tr.id=p.track_id JOIN product_gotit.word_topics t ON t.id=tr.topic_id WHERE $1::uuid IS NOT NULL`;
    if (!id) {
      const filter = `($2::text IS NULL OR r.title ILIKE $2 OR r.program ILIKE $2 OR r.id ILIKE $2)`;
      const values = [
        actor.applicationId,
        query.q ? `%${query.q.replace(/[\\%_]/g, '\\$&')}%` : null,
      ];
      const total = (
        await this.owner.db.query(
          `SELECT count(*)::int AS n FROM (${source}) r WHERE ${filter}`,
          values,
        )
      ).rows[0].n;
      const data = (
        await this.owner.db.query(
          `SELECT * FROM (${source}) r WHERE ${filter} ORDER BY r."${['id', 'title', 'status', 'applicationUserId'].includes(query.sort) ? query.sort : 'title'}" ${query.order},r.id LIMIT $3 OFFSET $4`,
          [...values, query.perPage, (query.page - 1) * query.perPage],
        )
      ).rows;
      return { data, total };
    }
    const parts = unitIdSchema.parse(id).split('_');
    const userId = parts.length === 2 ? parts[0]! : null,
      packId = parts.at(-1)!;
    const detailSource = userId
      ? `SELECT up.application_user_id::text||'_'||p.id::text AS id,up.application_user_id AS "applicationUserId",p.id AS "packId",p.title FROM product_gotit.user_word_packs up JOIN product_gotit.word_packs p ON p.id=up.pack_id WHERE up.application_id=$1`
      : source;
    const row = (
      await this.owner.db.query(`SELECT * FROM (${detailSource}) r WHERE id=$2`, [
        actor.applicationId,
        id,
      ])
    ).rows[0];
    if (!row) throw missing();
    const overrides = (
      await this.owner.db.query(
        `SELECT revision,content,application_user_id FROM product_gotit.admin_unit_content WHERE application_id=$1 AND pack_id=$2 AND (application_user_id IS NULL OR application_user_id=$3) ORDER BY application_user_id NULLS LAST`,
        [actor.applicationId, packId, userId],
      )
    ).rows;
    const own = overrides.find((item) => item.application_user_id === userId);
    const inherited = own ?? overrides[0];
    const metadata = (
      await this.owner.db.query(
        `SELECT t.id AS "programId",t.title AS "programTitle",t.slug,tr.source_language_code,tr.translation_language_code FROM product_gotit.word_packs p JOIN product_gotit.word_tracks tr ON tr.id=p.track_id JOIN product_gotit.word_topics t ON t.id=tr.topic_id WHERE p.id=$1`,
        [packId],
      )
    ).rows[0];
    const entries = (
      await this.owner.db.query(
        `SELECT e.id,COALESCE(li.source_text,e.source_text) AS "sourceText",COALESCE((SELECT translation_text FROM product_gotit.item_translations t WHERE t.application_id=li.application_id AND t.application_user_id=li.application_user_id AND t.learning_item_id=li.id AND t.is_current AND t.is_primary LIMIT 1),e.translation_text) AS "translationText",e.example_text AS "exampleText",li.id AS "learningItemId",li.updated_at AS "expectedUpdatedAt" FROM product_gotit.word_pack_entries e LEFT JOIN product_gotit.learning_item_pack_entries link ON link.application_id=$1 AND link.application_user_id=$3 AND link.pack_id=e.pack_id AND link.entry_id=e.id LEFT JOIN product_gotit.learning_items li ON li.application_id=link.application_id AND li.application_user_id=link.application_user_id AND li.id=link.learning_item_id AND li.deleted_at IS NULL WHERE e.pack_id=$2 ORDER BY e.sort_order,e.id`,
        [actor.applicationId, packId, userId],
      )
    ).rows;
    const content: z.infer<typeof unitContentSchema> = inherited
      ? unitContentSchema.parse(inherited.content)
      : {
          title: row.title,
          entries: entries.map(({ learningItemId: _item, expectedUpdatedAt, ...entry }) => ({
            ...entry,
            ...(expectedUpdatedAt ? { expectedUpdatedAt: expectedUpdatedAt.toISOString() } : {}),
          })),
          materials: {},
        };
    if (userId)
      for (const entry of entries) {
        const item = content.entries.find((candidate) => candidate.id === entry.id);
        if (item && entry.learningItemId)
          Object.assign(item, {
            sourceText: entry.sourceText,
            translationText: entry.translationText,
            expectedUpdatedAt: entry.expectedUpdatedAt?.toISOString(),
          });
      }
    return {
      data: {
        ...row,
        revision: own?.revision ?? 0,
        inherited: !own && Boolean(inherited),
        content,
        programId: metadata.programId,
        programTitle: metadata.programTitle,
        learningPath: {
          enabled: supportsTeacherStations(
            metadata.slug,
            metadata.source_language_code,
            metadata.translation_language_code,
          ),
          stations: supportsTeacherStations(
            metadata.slug,
            metadata.source_language_code,
            metadata.translation_language_code,
          )
            ? teacherStations(content.entries.length, 0, content.stationSettings)
            : [],
        },
      },
    };
  }
  saveUnit(actor: AdminActor, id: string, input: z.infer<typeof unitSaveSchema>) {
    const parts = unitIdSchema.parse(id).split('_'),
      userId = parts.length === 2 ? parts[0]! : null,
      packId = parts.at(-1)!;
    return this.owner.command(
      actor,
      'content.write',
      'unit.save',
      'catalog-units',
      packId,
      { ...input, unitId: id },
      async (tx) => {
        await tx.lock(['admin-unit', actor.applicationId, packId, userId ?? 'default']);
        if (
          userId &&
          !(
            await tx.query(
              `SELECT 1 FROM product_gotit.user_word_packs WHERE application_id=$1 AND application_user_id=$2 AND pack_id=$3`,
              [actor.applicationId, userId, packId],
            )
          ).rowCount
        )
          throw missing();
        const old = (
          await tx.query(
            `SELECT revision FROM product_gotit.admin_unit_content WHERE application_id=$1 AND pack_id=$2 AND application_user_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`,
            [actor.applicationId, packId, userId],
          )
        ).rows[0];
        if ((old?.revision ?? 0) !== input.expectedRevision) throw conflict();
        const entries = (
          await tx.query(
            `SELECT id FROM product_gotit.word_pack_entries WHERE pack_id=$1 ORDER BY id`,
            [packId],
          )
        ).rows;
        if (
          entries.length !== input.content.entries.length ||
          new Set(input.content.entries.map((entry) => entry.id)).size !== entries.length ||
          entries.some((row) => !input.content.entries.some((entry) => entry.id === row.id))
        )
          throw new AppError(
            400,
            'VALIDATION_ERROR',
            'Keep the unit entry identities; edit their content',
          );
        const senses = input.content.entries.map((entry) =>
          JSON.stringify([lookupText(entry.sourceText), lookupText(entry.translationText)]),
        );
        if (new Set(senses).size !== senses.length)
          throw new AppError(400, 'VALIDATION_ERROR', 'Duplicate word senses');
        if (input.content.stationSettings) {
          const metadata = (
            await tx.query(
              `SELECT t.slug,tr.source_language_code,tr.translation_language_code FROM product_gotit.word_packs p JOIN product_gotit.word_tracks tr ON tr.id=p.track_id JOIN product_gotit.word_topics t ON t.id=tr.topic_id WHERE p.id=$1`,
              [packId],
            )
          ).rows[0];
          if (
            !metadata ||
            !supportsTeacherStations(
              metadata.slug,
              metadata.source_language_code,
              metadata.translation_language_code,
            )
          )
            throw new AppError(
              400,
              'VALIDATION_ERROR',
              'Teacher stations are not enabled for this unit',
            );
        }
        if (userId) {
          const repository = new LibraryRepository(this.owner.db);
          for (const entry of [...input.content.entries].sort((a, b) => a.id.localeCompare(b.id))) {
            const link = (
              await tx.query(
                `SELECT li.id,li.source_text,(SELECT translation_text FROM product_gotit.item_translations t WHERE t.application_id=li.application_id AND t.application_user_id=li.application_user_id AND t.learning_item_id=li.id AND t.is_primary AND t.is_current LIMIT 1) AS translation FROM product_gotit.learning_item_pack_entries l JOIN product_gotit.learning_items li ON li.application_id=l.application_id AND li.application_user_id=l.application_user_id AND li.id=l.learning_item_id AND li.deleted_at IS NULL WHERE l.application_id=$1 AND l.application_user_id=$2 AND l.pack_id=$3 AND l.entry_id=$4`,
                [actor.applicationId, userId, packId, entry.id],
              )
            ).rows[0];
            if (
              link &&
              (link.source_text !== entry.sourceText || link.translation !== entry.translationText)
            )
              await repository.editInTransaction(
                tx,
                { applicationId: actor.applicationId, applicationUserId: userId },
                link.id,
                {
                  sourceText: entry.sourceText,
                  translation: { text: entry.translationText, variants: [] },
                  ...(entry.expectedUpdatedAt
                    ? { expectedUpdatedAt: entry.expectedUpdatedAt }
                    : {}),
                },
              );
          }
        }
        const revision = (old?.revision ?? 0) + 1;
        await tx.query(
          `INSERT INTO product_gotit.admin_unit_content(application_id,pack_id,application_user_id,revision,content) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(application_id,pack_id,application_user_id) DO UPDATE SET revision=EXCLUDED.revision,content=EXCLUDED.content,updated_at=now()`,
          [actor.applicationId, packId, userId, revision, JSON.stringify(input.content)],
        );
        return {
          id,
          revision,
          title: input.content.title,
          applicationUserId: userId,
          content: input.content,
        };
      },
    );
  }
  async lessons(actor: AdminActor, query: z.infer<typeof listSchema>, id?: string) {
    await this.owner.access(actor);
    const values = [
      actor.applicationId,
      id ?? null,
      query.q ? `%${query.q.replace(/[\\%_]/g, '\\$&')}%` : null,
    ];
    const where = `application_id=$1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id=$2) AND ($3::text IS NULL OR topic ILIKE $3 OR application_user_id::text ILIKE $3 OR course_context->>'courseId' ILIKE $3 OR word_pack_context->>'packId' ILIKE $3 OR (application_user_id::text||'_'||(word_pack_context->>'packId')) ILIKE $3 OR (application_user_id::text||'_'||(course_context->>'courseId')) ILIKE $3 OR EXISTS(SELECT 1 FROM product_gotit.learning_documents d WHERE d.application_id=private_lesson_sessions.application_id AND d.application_user_id=private_lesson_sessions.application_user_id AND d.id::text=private_lesson_sessions.course_context->>'courseId' AND (d.document->'adminAssignment'->>'templateId' ILIKE $3 OR d.document->'templateSource'->>'id' ILIKE $3)))`;
    const summary = (
      await this.owner.db.query(
        `SELECT count(*)::int AS lessons,count(*) FILTER(WHERE status='completed')::int AS completed,count(DISTINCT application_user_id)::int AS learners,COALESCE(sum(actual_duration_seconds),0)::bigint AS "durationSeconds",round(avg((report->'assessment'->'lessonPerformance'->>'independence')::numeric),1) AS "averageIndependence" FROM product_gotit.private_lesson_sessions WHERE ${where}`,
        values,
      )
    ).rows[0];
    Object.assign(
      summary,
      (
        await this.owner.db.query(
          `SELECT count(*)::int AS "homeworkCount",COALESCE(sum(jsonb_array_length(COALESCE(document->'progress','[]'::jsonb))),0)::int AS "practiceTasks",COALESCE(sum((SELECT count(*) FROM jsonb_array_elements(COALESCE(document->'progress','[]'::jsonb)) p WHERE p->>'done'='true')),0)::int AS "completedTasks",COALESCE(sum((SELECT COALESCE(sum(jsonb_array_length(COALESCE(p->'attempts','[]'::jsonb))),0) FROM jsonb_array_elements(COALESCE(document->'progress','[]'::jsonb)) p)),0)::int AS "practiceAttempts" FROM product_gotit.learning_documents WHERE application_id=$1 AND kind='homework' AND id IN (SELECT id FROM product_gotit.private_lesson_sessions WHERE ${where})`,
          values,
        )
      ).rows[0],
    );
    const rows = (
      await this.owner.db.query(
        `SELECT id,application_user_id AS "applicationUserId",topic AS title,status,started_at AS "createdAt",actual_duration_seconds AS "durationSeconds",level,report->'assessment'->'lessonPerformance' AS performance,course_context->>'courseId' AS "courseId",word_pack_context->>'packId' AS "packId"${id ? ',report,course_context AS course,word_pack_context AS unit,realtime_contract AS "realtimeContract"' : ''} FROM product_gotit.private_lesson_sessions WHERE ${where} ORDER BY started_at DESC,id LIMIT $4 OFFSET $5`,
        [...values, id ? 1 : query.perPage, id ? 0 : (query.page - 1) * query.perPage],
      )
    ).rows;
    if (id) {
      if (!rows[0]) throw missing();
      rows[0].homework =
        (
          await this.owner.db.query(
            `SELECT document->'content' AS content,document->'progress' AS progress,revision FROM product_gotit.learning_documents WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND kind='homework'`,
            [actor.applicationId, rows[0].applicationUserId, id],
          )
        ).rows[0] ?? null;
      return { data: rows[0] };
    }
    return { data: rows, total: summary.lessons, summary };
  }
  async preview(actor: AdminActor, input: z.infer<typeof lessonPreviewSchema>) {
    await this.owner.access(actor);
    const unit = input.plan.units.find((unit) => unit.key === input.unitKey),
      lesson = unit?.lessons[input.lessonIndex];
    if (!unit || !lesson) throw missing();
    const prefs = input.preferences;
    const course: CourseLessonContext = {
      courseId: '00000000-0000-4000-8000-000000000001',
      version: 1,
      unitKey: unit.key,
      lessonIndex: input.lessonIndex,
      courseTitle: input.plan.title,
      unitTitle: unit.title,
      lessonTitle: lesson.title,
      level: unit.level,
      objective: lesson.objective,
      successTask: unit.successTask,
      isUnitCheck: input.lessonIndex === unit.lessons.length - 1,
      grammar: unit.grammar,
      vocabulary: unit.vocabulary,
      preferences: prefs,
      homework: '[]',
      ...(lesson.material ? { material: lesson.material } : {}),
    };
    const plan: PrivateLessonPlan = {
      id: course.courseId,
      course,
      durationSeconds: prefs.minutesPerLesson * 60,
      targetLanguageCode: prefs.targetLanguageCode,
      supportLanguageCode: prefs.supportLanguageCode,
      lessonMode: prefs.absoluteBeginner && unit.level === 'A1' ? 'absolute_beginner' : 'standard',
      teachingLanguage: 'support',
      level: unit.level,
      topic: lesson.title,
      grammarFocus: unit.grammar.join('; ').slice(0, 160) || null,
      focusAreas: ['speaking', 'grammar'],
      customFocus: null,
      correctionMode: prefs.path === 'grammar' ? 'deep_explanation' : 'recast',
      vocabularyMode: 'none',
      teacherVoice: 'female',
      speechRate: 'normal',
      interests: prefs.interests,
      targets: [],
      continuity: null,
    };
    const runtime = await this.owner.runtime(actor, actor.requestId);
    return {
      data: {
        id: unit.key + '_' + input.lessonIndex,
        kind: 'curriculum-preview',
        contract: buildRealtimeLessonContract(plan, this.defaults, runtime.prompts['lesson-live']),
      },
    };
  }
}
