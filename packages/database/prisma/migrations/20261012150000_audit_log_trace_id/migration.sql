-- TZ 11.4 / PLAN F1.1b: audit rows record the request trace ID.
-- Forward-only, backward-compatible: nullable column, no default, no backfill
-- (historical rows keep NULL). AuditLog append-only triggers fire only on row
-- UPDATE/DELETE and statement TRUNCATE (DML), not on DDL, so ADD COLUMN is
-- unaffected. The existing tenant_isolation RLS policy and FORCE ROW LEVEL
-- SECURITY are row-level and remain in force unchanged.
ALTER TABLE "AuditLog" ADD COLUMN "traceId" TEXT;
