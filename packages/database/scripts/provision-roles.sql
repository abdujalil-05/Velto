-- One-time, per-database provisioning script — run by a superuser (or the
-- managed-Postgres admin equivalent), connected to the TARGET database, when
-- standing up a new database. Idempotent: safe to re-run, and it MUST be
-- re-run after `prisma migrate reset` (which drops/recreates the public
-- schema and with it every schema-level grant).
-- This is NOT a Prisma migration: role creation needs CREATEROLE/superuser,
-- which none of the roles below have, and is not portable across providers.
--
-- Role model (VELTO-TZ.md 10.4 / 16.3 / SEC-001..005). None of these is a
-- superuser — a superuser (and any BYPASSRLS role) skips RLS entirely, even
-- with FORCE ROW LEVEL SECURITY, so tenant isolation would silently vanish:
--
--   velto_owner   Owns the database, schema objects and _prisma_migrations;
--                 runs migrations (DATABASE_MIGRATE_URL -> schema.prisma
--                 `directUrl`). NOBYPASSRLS, so as table owner it is still
--                 subject to the FORCE ROW LEVEL SECURITY on every table.
--                 Never used by the running application.
--   velto_app     The application role (DATABASE_URL). DML only — no DDL, no
--                 TRUNCATE (TRUNCATE ignores RLS), NOBYPASSRLS. Every query
--                 is RLS-bound; access goes through withTenant().
--   velto_system  BYPASSRLS, DML only (DATABASE_SYSTEM_URL). ONLY for login
--                 by phone (companyId is not part of the login request —
--                 VELTO-TZ.md 15.2), platform-admin provisioning and
--                 cross-tenant background jobs. Append-only triggers still
--                 apply to it.
--
-- Passwords below are local-dev/CI defaults. In any shared environment set
-- real ones afterwards: ALTER ROLE <name> PASSWORD '...';
--
-- Usage (as superuser, e.g. the docker bootstrap role `velto`):
--   psql "postgresql://velto:velto@localhost:5433/velto_dev" -v ON_ERROR_STOP=1 \
--     -f packages/database/scripts/provision-roles.sql
-- (psql rejects Prisma's `?schema=public` URL parameter — strip it.)

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'velto_owner') THEN
    CREATE ROLE velto_owner LOGIN PASSWORD 'velto_owner';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'velto_app') THEN
    CREATE ROLE velto_app LOGIN PASSWORD 'velto_app';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'velto_system') THEN
    CREATE ROLE velto_system LOGIN PASSWORD 'velto_system';
  END IF;
END
$$;

-- Enforce attributes even for pre-existing roles (fail closed on drift).
-- CREATEDB on the owner only so `prisma migrate dev` can create its shadow DB.
ALTER ROLE velto_owner  NOSUPERUSER NOBYPASSRLS NOCREATEROLE CREATEDB;
ALTER ROLE velto_app    NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
ALTER ROLE velto_system NOSUPERUSER BYPASSRLS   NOCREATEROLE NOCREATEDB;

-- velto_owner owns the database (and therefore, on PG15+, the public schema
-- via pg_database_owner) so it can run migrations and `migrate reset`.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO velto_owner', current_database());
END
$$;
ALTER SCHEMA public OWNER TO velto_owner;

-- Converge ownership of anything previously migrated by another role (e.g.
-- the docker bootstrap superuser), so later migrations can ALTER it.
-- Extension member objects stay with their extension.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid, c.relkind, quote_ident(c.relname) AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND pg_get_userbyid(c.relowner) <> 'velto_owner'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s public.%s OWNER TO velto_owner',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
      r.name);
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> 'velto_owner'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO velto_owner', r.sig);
  END LOOP;
END
$$;

-- Runtime roles: connect + resolve names in public + DML. Deliberately no
-- TRUNCATE/REFERENCES/TRIGGER and no CREATE on the schema.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO velto_app, velto_system', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO velto_app, velto_system;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM velto_app, velto_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO velto_app, velto_system;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO velto_app, velto_system;

-- Future objects created by migrations (run as velto_owner) get the same
-- grants automatically. Not schema-scoped, so they survive `migrate reset`
-- dropping the public schema (USAGE above still needs a re-run).
ALTER DEFAULT PRIVILEGES FOR ROLE velto_owner
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO velto_app, velto_system;
ALTER DEFAULT PRIVILEGES FOR ROLE velto_owner
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO velto_app, velto_system;
