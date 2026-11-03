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
-- Mode (psql variable `velto_env`, values `dev` | `production`):
--   dev         NEW roles get the guessable local defaults (password = role
--               name) and velto_owner keeps CREATEDB (only `prisma migrate
--               dev` needs it, for its shadow database).
--   production  NEW roles are created WITHOUT a password (login impossible
--               until an operator sets one interactively: `\password <role>`
--               in psql — never in argv/history), and velto_owner is
--               NOCREATEDB. Existing roles' passwords are never touched.
-- `velto_env` is REQUIRED — the environment is never inferred from the
-- database name (an accidental name match must not hand out guessable
-- passwords). Missing, unknown or contradicting the connection -> abort
-- before anything is changed (fail closed):
--   dev         requires current_database() to end in _dev/_ci/_test/_load
--               (docker init `velto_dev`, CI `velto_ci`, `velto_test`) AND
--               every other non-template database in the cluster (except
--               `postgres`) to carry a dev/scratch token — roles are
--               cluster-wide, so a dev DB inside a production cluster aborts.
--   production  aborts if current_database() ends in _dev/_ci/_test/_load.
--
-- Usage (as superuser, e.g. the docker bootstrap role `velto`):
--   psql "postgresql://velto:velto@localhost:5433/velto_dev" -v ON_ERROR_STOP=1 \
--     -v velto_env=dev -f packages/database/scripts/provision-roles.sql
--   production: psql -d <prod_db> -v ON_ERROR_STOP=1 -v velto_env=production -f ...
-- docker-compose runs it on first init via docker-initdb-provision-roles.sh
-- (initdb cannot pass psql variables to a bare .sql file).
-- (psql rejects Prisma's `?schema=public` URL parameter — strip it.)
-- Backup role velto_backup: separate opt-in script provision-backup-role.sql.

-- Fail fast even when the caller forgot -v ON_ERROR_STOP=1: the guard below
-- must abort the script, not let it continue in dev mode.
\set ON_ERROR_STOP on
\if :{?velto_env}
\else
DO $$
BEGIN
  RAISE EXCEPTION 'provision-roles.sql: velto_env is required (no autodetect from the database name)'
    USING HINT = 'pass -v velto_env=dev|production';
END
$$;
\endif
SELECT set_config('velto.provision_env', :'velto_env', false) AS env \gset provision_
DO $$
DECLARE
  env text := current_setting('velto.provision_env');
  devname boolean := current_database() ~ '_(dev|ci|test|load)$';
  bad text;
BEGIN
  IF env NOT IN ('dev', 'production') THEN
    RAISE EXCEPTION 'velto_env must be dev or production, got %', env;
  END IF;
  IF env = 'production' AND devname THEN
    RAISE EXCEPTION 'velto_env=production contradicts dev/test database name %', current_database()
      USING HINT = 'use -v velto_env=dev for a dev/CI database, or connect to the production database';
  END IF;
  IF env = 'dev' THEN
    IF NOT devname THEN
      RAISE EXCEPTION 'velto_env=dev requires a database name ending in _dev/_ci/_test/_load, got %', current_database()
        USING HINT = 'production database: pass -v velto_env=production';
    END IF;
    -- Roles are CLUSTER-wide: dev mode also requires every other non-template
    -- database (except `postgres`) to carry a dev/scratch token
    -- (velto_ci_20261102, velto_mfa_smoke, velto_restore_drill_*, ...).
    SELECT string_agg(datname, ', ' ORDER BY datname) INTO bad
    FROM pg_catalog.pg_database
    WHERE NOT datistemplate AND datname <> 'postgres'
      AND datname !~ '(^|_)(dev|ci|test|load|local|smoke|drill|synth|scratch|tmp)(_|$)';
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'refusing velto_env=dev: cluster has non-dev database(s): %', bad
        USING HINT = 'production cluster: pass -v velto_env=production';
    END IF;
  END IF;
END
$$;

DO $$
DECLARE
  dev boolean := current_setting('velto.provision_env') = 'dev';
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['velto_owner', 'velto_app', 'velto_system'] LOOP
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      IF dev THEN
        EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', r, r);
      ELSE
        EXECUTE format('CREATE ROLE %I LOGIN PASSWORD NULL', r);
        RAISE NOTICE 'created % without password: set it with \password %', r, r;
      END IF;
    END IF;
  END LOOP;
  -- CREATEDB on the owner only in dev, for `prisma migrate dev`'s shadow DB.
  IF dev THEN
    ALTER ROLE velto_owner CREATEDB;
  ELSE
    ALTER ROLE velto_owner NOCREATEDB;
  END IF;
END
$$;

-- Enforce attributes even for pre-existing roles (fail closed on drift).
ALTER ROLE velto_owner  NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
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
