-- Opt-in, per-database provisioning of the read-only BACKUP role
-- `velto_backup` (PO-approved, F-5). Run by a superuser, connected to the
-- TARGET database, AFTER provision-roles.sql. Idempotent; re-run after
-- `prisma migrate reset` (schema-level grants are dropped with the schema).
-- NOT run by docker init / CI: dev and CI do not need a BYPASSRLS backup role.
--
-- Why BYPASSRLS (proven on PG16 with the real schema, see
-- scripts/backup-role-proof.sh): every tenant table is FORCE ROW LEVEL
-- SECURITY. pg_dump sets row_security=off, so a NOBYPASSRLS reader (plain
-- SELECT grants OR pg_read_all_data) fails with
--   ERROR: query would be affected by row-level security policy for table "AuditLog"
-- and with --enable-row-security it exits 0 but dumps 0 tenant rows (no
-- app.current_company_id) — a silently empty backup. Only a BYPASSRLS role
-- produces a complete dump without being superuser.
--
-- Least privilege otherwise: LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
-- NOREPLICATION, no role memberships, SELECT only (no INSERT/UPDATE/DELETE/
-- TRUNCATE/REFERENCES/TRIGGER), sessions read-only by default, 2 connections.
-- Explicit, schema-scoped grants rather than pg_read_all_data: the latter is
-- cluster-wide (every database, every schema, incl. future ones). With
-- explicit grants a table created by a role other than the owner below is
-- not readable -> pg_dump fails LOUDLY ("permission denied"), never silently
-- incomplete. Not velto_system (that role has DML).
--
-- Password: created WITHOUT one. Set it interactively (never argv/history):
--   psql -d <db>  then  \password velto_backup
-- and restrict it in pg_hba.conf to local socket / 127.0.0.1 only.
--
-- Usage (as superuser):
--   psql -d <db> -v ON_ERROR_STOP=1 -f packages/database/scripts/provision-backup-role.sql
--   hosts whose schema owner is not velto_owner: add -v owner_role=<owner>

\if :{?owner_role}
\else
\set owner_role velto_owner
\endif

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'velto_backup') THEN
    CREATE ROLE velto_backup LOGIN PASSWORD NULL;
    RAISE NOTICE 'created velto_backup without password: set it with \password velto_backup';
  END IF;
END
$$;

-- Enforce attributes even for a pre-existing role (fail closed on drift).
ALTER ROLE velto_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  BYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE velto_backup SET default_transaction_read_only = on;

-- No inherited privileges from any other role (e.g. velto_system, pg_write_all_data).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT g.rolname FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
    JOIN pg_catalog.pg_roles u ON u.oid = m.member
    WHERE u.rolname = 'velto_backup'
  LOOP
    EXECUTE format('REVOKE %I FROM velto_backup', r.rolname);
  END LOOP;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO velto_backup', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO velto_backup;

-- Read-only on everything in public, incl. _prisma_migrations and sequences.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM velto_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO velto_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM velto_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO velto_backup;

-- Future objects created by migrations (run as the owner role).
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" GRANT SELECT ON TABLES TO velto_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" GRANT SELECT ON SEQUENCES TO velto_backup;
