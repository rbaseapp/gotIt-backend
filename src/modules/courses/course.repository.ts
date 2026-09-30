import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../../shared/database/transaction.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { ProfileScope } from '../profile/profile.types.js';
import type { LearningDocument } from './course.schemas.js';

export const courseConflict = () =>
  new AppError(409, 'COURSE_CHANGED', 'Saved work has changed. Reload before continuing.');
export const courseNotFound = () =>
  new AppError(404, 'COURSE_NOT_FOUND', 'Learning activity not found');
export const commandFingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeValues = (scope: ProfileScope) => [scope.applicationId, scope.applicationUserId];
export interface LearningDocumentStore {
  get(scope: ProfileScope, id: string): Promise<LearningDocument | null>;
  list(scope: ProfileScope, kind: 'course' | 'homework'): Promise<LearningDocument[]>;
  replay(
    scope: ProfileScope,
    eventId: string,
    fingerprint: string,
  ): Promise<LearningDocument | null>;
  save(
    scope: ProfileScope,
    document: LearningDocument,
    expectedRevision: number | null,
    eventId: string,
    fingerprint: string,
  ): Promise<LearningDocument>;
}
export class PostgresLearningDocumentStore implements LearningDocumentStore {
  constructor(private readonly pool: Pool) {}
  async get(scope: ProfileScope, id: string) {
    return (
      ((
        await this.pool.query(
          'SELECT document FROM product_gotit.learning_documents WHERE application_id=$1 AND application_user_id=$2 AND id=$3',
          [...scopeValues(scope), id],
        )
      ).rows[0]?.document as LearningDocument | undefined) ?? null
    );
  }
  async list(scope: ProfileScope, kind: 'course' | 'homework') {
    return (
      await this.pool.query(
        'SELECT document FROM product_gotit.learning_documents WHERE application_id=$1 AND application_user_id=$2 AND kind=$3 ORDER BY updated_at DESC LIMIT 100',
        [...scopeValues(scope), kind],
      )
    ).rows.map((row) => row.document as LearningDocument);
  }
  async replay(scope: ProfileScope, eventId: string, fingerprint: string) {
    const row = (
      await this.pool.query(
        `SELECT c.fingerprint,c.response_document AS document FROM product_gotit.learning_commands c
      WHERE c.application_id=$1 AND c.application_user_id=$2 AND c.event_id=$3`,
        [...scopeValues(scope), eventId],
      )
    ).rows[0];
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw courseConflict();
    // Replay the committed snapshot. Later writes still require its revision;
    // an old receipt cannot overwrite newer preferences or progress.
    return row.document as LearningDocument;
  }
  async save(
    scope: ProfileScope,
    document: LearningDocument,
    expectedRevision: number | null,
    eventId: string,
    fingerprint: string,
  ) {
    return withTransaction(this.pool, async (tx) => {
      await tx.lock(['learning-command', ...scopeValues(scope), eventId]);
      const receipt = (
        await tx.query(
          'SELECT fingerprint,document_id,response_document FROM product_gotit.learning_commands WHERE application_id=$1 AND application_user_id=$2 AND event_id=$3',
          [...scopeValues(scope), eventId],
        )
      ).rows[0];
      if (receipt) {
        if (receipt.fingerprint !== fingerprint || receipt.document_id !== document.id)
          throw courseConflict();
        return receipt.response_document as LearningDocument;
      }
      const next = { ...document, revision: expectedRevision === null ? 0 : expectedRevision + 1 };
      if (expectedRevision === null) {
        const inserted = await tx.query(
          `INSERT INTO product_gotit.learning_documents(application_id,application_user_id,id,kind,revision,document)
          VALUES($1,$2,$3,$4,0,$5::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
          [...scopeValues(scope), document.id, document.kind, JSON.stringify(next)],
        );
        if (!inserted.rowCount) throw courseConflict();
      } else {
        const updated = await tx.query(
          `UPDATE product_gotit.learning_documents SET revision=$4,document=$5::jsonb,updated_at=now()
          WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND revision=$6 RETURNING id`,
          [
            ...scopeValues(scope),
            document.id,
            next.revision,
            JSON.stringify(next),
            expectedRevision,
          ],
        );
        if (!updated.rowCount) throw courseConflict();
      }
      await tx.query(
        'INSERT INTO product_gotit.learning_commands(application_id,application_user_id,event_id,document_id,fingerprint,response_document) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
        [...scopeValues(scope), eventId, document.id, fingerprint, JSON.stringify(next)],
      );
      return next;
    });
  }
}
