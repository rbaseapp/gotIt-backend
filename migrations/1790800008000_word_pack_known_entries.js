export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE product_gotit.user_word_pack_known_entries (
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      pack_id uuid NOT NULL,
      entry_id uuid NOT NULL,
      known_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(application_id,application_user_id,pack_id,entry_id),
      CONSTRAINT user_word_pack_known_entries_user_fkey
        FOREIGN KEY(application_id,application_user_id)
        REFERENCES core.application_users(application_id,id) ON DELETE CASCADE,
      CONSTRAINT user_word_pack_known_entries_entry_fkey
        FOREIGN KEY(pack_id,entry_id)
        REFERENCES product_gotit.word_pack_entries(pack_id,id) ON DELETE CASCADE
    );
    CREATE INDEX user_word_pack_known_entries_pack_idx
      ON product_gotit.user_word_pack_known_entries(application_id,application_user_id,pack_id);
  `);
};

export const down = (pgm) => {
  pgm.sql('DROP TABLE product_gotit.user_word_pack_known_entries');
};
