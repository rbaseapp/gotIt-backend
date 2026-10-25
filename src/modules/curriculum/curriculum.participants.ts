import { privateLessonTeachers } from '../private-lessons/private-lesson.teachers.js';
import type { DatabaseTransaction } from '../../shared/database/transaction.js';
import type { ProfileScope } from '../profile/profile.types.js';

export async function curriculumTeacherVoice(
  db: Pick<DatabaseTransaction, 'query'>,
  scope: ProfileScope,
  completedLessonSource?: string,
): Promise<'female' | 'male'> {
  const owner = [scope.applicationId, scope.applicationUserId];
  if (completedLessonSource) {
    const lesson = (
      await db.query(
        `SELECT teacher_voice FROM product_gotit.private_lesson_sessions
        WHERE application_id=$1 AND application_user_id=$2 AND id::text=$3
        AND status='completed' AND deleted_at IS NULL`,
        [...owner, completedLessonSource],
      )
    ).rows[0];
    if (lesson?.teacher_voice === 'male' || lesson?.teacher_voice === 'female')
      return lesson.teacher_voice;
  }
  const preference = (
    await db.query(
      `SELECT teacher_voice FROM product_gotit.private_lesson_preferences
      WHERE application_id=$1 AND application_user_id=$2
      AND split_part(target_language_code,'-',1)='en'
      ORDER BY updated_at DESC LIMIT 1`,
      owner,
    )
  ).rows[0];
  return preference?.teacher_voice === 'male' ? 'male' : 'female';
}

/** Resolve authored participant slots from the server's selected tutor, never learner input. */
export function curriculumParticipants<T>(value: T, voice: 'female' | 'male'): T {
  const names: Record<string, string> = {
    teacherName: privateLessonTeachers[voice].name,
    teacherNameHe: voice === 'male' ? 'מייק' : "רייצ'ל",
  };
  const resolve = (part: unknown): unknown => {
    if (typeof part === 'string')
      return part.replace(/\{\{(teacherName|teacherNameHe)\}\}/gu, (_, key: string) => names[key]!);
    if (Array.isArray(part)) return part.map(resolve);
    if (part && typeof part === 'object')
      return Object.fromEntries(Object.entries(part).map(([key, item]) => [key, resolve(item)]));
    return part;
  };
  return resolve(value) as T;
}
