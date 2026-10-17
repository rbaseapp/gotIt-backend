/** Historical reconciliation has its own bounded quota; release old shared-quota waits. */
export const up = (pgm) =>
  pgm.sql(`
    UPDATE product_gotit.concept_assignment_jobs
    SET next_attempt_at=now(),last_error=NULL
    WHERE priority=0 AND status='pending' AND claim_id IS NULL
      AND last_error='CONCEPT_DAILY_LIMIT_REACHED';
  `);

// Retain successful assignments, descriptors and retry state on application rollback.
export const down = () => {};
