-- ADR-064b: ImportJob.attemptCount + ImportJob.updatedAt. Forward-only, purely
-- additive (two new columns, one CHECK, one trigger, one index). RLS policy
-- tenant_isolation (FOR ALL, row predicate on "companyId") is column-agnostic
-- and therefore already covers the new columns; ENABLE + FORCE are restored
-- below after the backfill.
--
-- attemptCount: durable count of automatic dispatch/recovery enqueues (NOT
-- BullMQ-internal retries). ADD COLUMN with a constant default is a catalog-only
-- change on PG11+ (no table rewrite).
--
-- updatedAt: added nullable, historical rows backfilled to "createdAt", then
-- DEFAULT CURRENT_TIMESTAMP + NOT NULL. A BEFORE UPDATE trigger bumps it on every
-- UPDATE, so raw-SQL writers (apps/api import.processor.ts commit cursor) that
-- never mention the column still advance it.

-- AlterTable
ALTER TABLE "ImportJob" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ImportJob" ADD COLUMN "updatedAt" TIMESTAMP(3);

-- Backfill: velto_owner is NOBYPASSRLS and the table is FORCE RLS, so without
-- app.current_company_id the UPDATE would see zero rows. RLS is switched off
-- only for this cross-tenant backfill and restored (ENABLE + FORCE) in the same
-- migration transaction — pattern of 20261019110000. The bump trigger is
-- created only afterwards, so the backfill keeps "createdAt" verbatim.
ALTER TABLE "ImportJob" DISABLE ROW LEVEL SECURITY;
UPDATE "ImportJob" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
ALTER TABLE "ImportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImportJob" FORCE ROW LEVEL SECURITY;

ALTER TABLE "ImportJob" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "ImportJob" ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "ImportJob"
  ADD CONSTRAINT "ImportJob_attemptCount_nonneg_check" CHECK ("attemptCount" >= 0);

-- Trigger: every UPDATE (Prisma or raw SQL, any role incl. BYPASSRLS
-- velto_system) stamps the row's last state change.
CREATE FUNCTION velto_importjob_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Prisma stores DateTime as UTC in timestamp-without-tz; pin UTC so the
  -- value does not depend on the session TimeZone.
  NEW."updatedAt" := now() AT TIME ZONE 'UTC';
  RETURN NEW;
END;
$$;

CREATE TRIGGER importjob_set_updated_at
  BEFORE UPDATE ON "ImportJob"
  FOR EACH ROW EXECUTE FUNCTION velto_importjob_set_updated_at();

-- Cross-tenant recovery sweep (systemPrisma, status = 'PROCESSING', by age):
-- the existing ("companyId", "status") index cannot serve a status-only filter.
CREATE INDEX "ImportJob_status_updatedAt_idx" ON "ImportJob"("status", "updatedAt");
