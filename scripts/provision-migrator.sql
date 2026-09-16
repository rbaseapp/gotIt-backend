-- Review and execute once as the verified database administrator.
-- Requires scripts/provision-runtime.sql to have created gotit_runtime first.
-- Set the migrator password separately (psql: \password gotit_migrator).
CREATE ROLE gotit_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
DO $gotit_admin_membership$
BEGIN
  -- Required by PostgreSQL before the administrator can transfer ownership to
  -- a newly-created role and temporarily SET ROLE for compatibility grants.
  EXECUTE format('GRANT gotit_migrator TO %I WITH SET TRUE',session_user);
END
$gotit_admin_membership$;
CREATE SCHEMA IF NOT EXISTS gotit_migrations AUTHORIZATION gotit_migrator;
ALTER SCHEMA gotit_migrations OWNER TO gotit_migrator;
GRANT USAGE,CREATE ON SCHEMA product_gotit TO gotit_migrator;

DO $gotit_ownership$
DECLARE object_record record;
BEGIN
  -- Ownership changes are confined to the GotIt product and migration metadata.
  -- Core tables, public.pgmigrations and historical migration files are untouched.
  FOR object_record IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='product_gotit' AND c.relkind IN('r','p')
  LOOP
    EXECUTE format('ALTER TABLE product_gotit.%I OWNER TO gotit_migrator',object_record.relname);
  END LOOP;
  IF to_regclass('gotit_migrations.pgmigrations') IS NOT NULL THEN
    ALTER TABLE gotit_migrations.pgmigrations OWNER TO gotit_migrator;
    ALTER SEQUENCE IF EXISTS gotit_migrations.pgmigrations_id_seq OWNER TO gotit_migrator;
  END IF;
END
$gotit_ownership$;

-- Grant after ownership moves: ALTER OWNER rewrites owner ACL entries. The role
-- creator can SET ROLE to the role it created; the legacy identity remains
-- session_user and is deliberately retained during the deployment transition.
SET ROLE gotit_migrator;
DO $gotit_legacy_access$
DECLARE object_record record;
BEGIN
  FOR object_record IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='product_gotit' AND c.relkind IN('r','p')
  LOOP
    EXECUTE format(
      'GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE product_gotit.%I TO %I',
      object_record.relname,
      session_user
    );
  END LOOP;
END
$gotit_legacy_access$;
RESET ROLE;

ALTER DEFAULT PRIVILEGES FOR ROLE gotit_migrator IN SCHEMA product_gotit
  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO gotit_runtime;
-- gotit_migrator intentionally receives no Core-table privileges or database CREATE.
-- Keep its connection out of the running Web service's environment.
