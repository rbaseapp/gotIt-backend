-- Run under the dedicated migration administrator, on the verified database.
-- Set credentials separately (for psql: \password gotit_runtime).
CREATE ROLE gotit_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA product_gotit TO gotit_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA product_gotit TO gotit_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA product_gotit
  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO gotit_runtime;
-- The migration owner must be the same role that executes future migrations.
-- Never grant access to core.* or schema/table creation to the runtime role.
