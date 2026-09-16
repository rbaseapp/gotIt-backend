/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.sql(`ALTER TABLE product_gotit.item_occurrences
    ADD COLUMN capture_request_hash text,
    ADD COLUMN capture_receipt jsonb,
    ADD CONSTRAINT item_occurrences_capture_receipt_check CHECK (
      (capture_request_hash IS NULL AND capture_receipt IS NULL) OR
      (capture_request_hash IS NOT NULL AND capture_receipt IS NOT NULL
       AND client_event_id IS NOT NULL AND capture_request_hash ~ '^[0-9a-f]{64}$'
       AND jsonb_typeof(capture_receipt) = 'object'
       AND capture_receipt @> '{"version":1}'::jsonb
       AND capture_receipt->'httpStatus' IN ('200'::jsonb, '201'::jsonb)
       AND jsonb_typeof(capture_receipt->'capture') = 'object') IS TRUE
    )`);
};
/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.sql(`ALTER TABLE product_gotit.item_occurrences
    DROP CONSTRAINT item_occurrences_capture_receipt_check,
    DROP COLUMN capture_receipt, DROP COLUMN capture_request_hash`);
};
