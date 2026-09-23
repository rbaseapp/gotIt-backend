export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE product_gotit.ai_monthly_usage (
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      usage_month date NOT NULL,
      generation_count integer NOT NULL CHECK(generation_count BETWEEN 0 AND 4),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(application_id,application_user_id,usage_month),
      FOREIGN KEY(application_id,application_user_id)
        REFERENCES core.application_users(application_id,id) ON DELETE CASCADE
    );
  `);
};

export const down = (pgm) => {
  pgm.dropTable({ schema: 'product_gotit', name: 'ai_monthly_usage' });
};
