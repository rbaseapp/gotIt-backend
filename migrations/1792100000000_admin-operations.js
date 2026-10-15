export const up = (pgm) =>
  pgm.sql(`
  ALTER TABLE product_gotit.ai_monthly_usage DROP CONSTRAINT ai_monthly_usage_generation_count_check;
  ALTER TABLE product_gotit.ai_monthly_usage ADD CONSTRAINT ai_monthly_usage_generation_count_check CHECK(generation_count>=0);
  CREATE TABLE product_gotit.admin_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL,
    resource text NOT NULL CHECK(resource IN ('prompts','policies','programs','support')),
    key text NOT NULL,title text NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
    revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
    status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived','open','pending','resolved')),
    content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
    application_user_id uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(application_id,id),UNIQUE(application_id,resource,key,version),
    FOREIGN KEY(application_id,application_user_id) REFERENCES product_gotit.user_profiles(application_id,application_user_id)
  );
  CREATE INDEX admin_documents_list ON product_gotit.admin_documents(application_id,resource,updated_at DESC);
  CREATE TABLE product_gotit.admin_active_revisions (
    application_id uuid NOT NULL,resource text NOT NULL,key text NOT NULL,document_id uuid NOT NULL,
    PRIMARY KEY(application_id,resource,key),
    FOREIGN KEY(application_id,document_id) REFERENCES product_gotit.admin_documents(application_id,id)
  );
  CREATE TABLE product_gotit.admin_audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL,actor_id uuid NOT NULL,
    action text NOT NULL,resource text NOT NULL,target_id uuid,reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
    metadata jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX admin_audit_app_time ON product_gotit.admin_audit_events(application_id,created_at DESC,id);
  CREATE TABLE product_gotit.admin_command_receipts (
    application_id uuid NOT NULL,actor_id uuid NOT NULL,operation_id uuid NOT NULL,
    fingerprint text NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(application_id,actor_id,operation_id)
  );
  CREATE TABLE product_gotit.ai_usage_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL,application_user_id uuid NOT NULL,
    operation text NOT NULL,operation_id text NOT NULL,provider text NOT NULL,model text,
    provider_response_id text,prompt_revision_id uuid,
    input_tokens integer CHECK(input_tokens>=0),output_tokens integer CHECK(output_tokens>=0),
    cached_input_tokens integer CHECK(cached_input_tokens>=0),
    status text NOT NULL CHECK(status IN ('completed','failed','unmeasured')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(application_id,provider,provider_response_id),
    FOREIGN KEY(application_id,application_user_id) REFERENCES product_gotit.user_profiles(application_id,application_user_id)
  );
  CREATE INDEX ai_usage_app_user_time ON product_gotit.ai_usage_events(application_id,application_user_id,created_at DESC);
  CREATE TABLE product_gotit.admin_quota_grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL,application_user_id uuid NOT NULL,
    amount integer NOT NULL CHECK(amount BETWEEN 1 AND 100),ends_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(application_id,application_user_id) REFERENCES product_gotit.user_profiles(application_id,application_user_id)
  );
  CREATE TABLE product_gotit.admin_generation_jobs (
    application_id uuid NOT NULL,actor_id uuid NOT NULL,operation_id uuid NOT NULL,
    fingerprint text NOT NULL,status text NOT NULL CHECK(status IN ('running','generated','completed','failed')),
    result jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(application_id,actor_id,operation_id)
  );
`);
export const down = (pgm) =>
  pgm.sql(`
  ALTER TABLE product_gotit.ai_monthly_usage DROP CONSTRAINT ai_monthly_usage_generation_count_check;
  ALTER TABLE product_gotit.ai_monthly_usage ADD CONSTRAINT ai_monthly_usage_generation_count_check CHECK(generation_count BETWEEN 0 AND 4);
  DROP TABLE product_gotit.admin_generation_jobs,product_gotit.admin_quota_grants,product_gotit.ai_usage_events,product_gotit.admin_command_receipts,product_gotit.admin_audit_events,product_gotit.admin_active_revisions,product_gotit.admin_documents;
`);
