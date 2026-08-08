-- One-time, per-environment provisioning script — run once by a superuser
-- (or the managed-Postgres equivalent) when standing up a new database.
-- This is NOT a Prisma migration: role creation requires superuser/CREATEROLE
-- privilege that the app's own migration role does not have, and is not
-- portable across managed Postgres providers.
--
-- Creates `velto_system`: a BYPASSRLS role used ONLY for the small set of
-- operations that must legitimately see across tenants before a company
-- context is known — namely resolving a user by phone during
-- `POST /auth/login` (companyId is intentionally not part of the login
-- request, see VELTO-TZ.md 15.2), and background jobs that operate across
-- all tenants (outbox relay, balance drift reconciliation). Application code
-- must never use this role for ordinary per-tenant reads/writes — those go
-- through the RLS-bound `velto` role via packages/database's withTenant().
--
-- Usage: psql "$DATABASE_URL" -f scripts/provision-roles.sql
-- (connect as a superuser, e.g. the local `postgres`/OS-user role, not `velto`)

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'velto_system') THEN
    CREATE ROLE velto_system LOGIN PASSWORD 'velto_system' BYPASSRLS;
  END IF;
END
$$;

-- `prisma migrate reset` drops and recreates the public schema, which does
-- not carry over USAGE to velto_system — without this, every unqualified
-- query from that role fails with "relation does not exist" (Postgres hides
-- the real "permission denied for schema" behind that message when the
-- role can't even see the schema to resolve the name).
GRANT USAGE ON SCHEMA public TO velto_system;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO velto_system;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO velto_system;

-- Keep future tables (new Prisma migrations, owned by `velto`) grant-covered
-- for velto_system automatically.
ALTER DEFAULT PRIVILEGES FOR ROLE velto IN SCHEMA public GRANT ALL ON TABLES TO velto_system;
ALTER DEFAULT PRIVILEGES FOR ROLE velto IN SCHEMA public GRANT ALL ON SEQUENCES TO velto_system;
