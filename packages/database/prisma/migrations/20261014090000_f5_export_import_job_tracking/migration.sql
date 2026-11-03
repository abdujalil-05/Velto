-- F5 step 1: ExportJob / ImportJob tracking columns (TZ §9 1C export, import).
-- Forward-only, backward-compatible: every new column is nullable or has a
-- DEFAULT, so current writers (export-1c, import) keep working unchanged. No
-- new table, so RLS policies / FORCE are untouched.
--
-- ExportJob.format already exists ("XML" | "EXCEL") — no new format column.
-- ExportJob statuses in use: PENDING PROCESSING DONE FAILED. "Active" =
-- PENDING or PROCESSING; a DONE/FAILED job never blocks a re-export.

-- ---------------------------------------------------------------------------
-- ExportJob
-- ---------------------------------------------------------------------------
ALTER TABLE "ExportJob"
  ADD COLUMN "fileHash"       TEXT,
  ADD COLUMN "recordCount"    INTEGER,
  ADD COLUMN "mappingVersion" INTEGER,
  ADD COLUMN "attemptCount"   INTEGER NOT NULL DEFAULT 0;

-- sha256 hex, lower-case. Nullable until DONE (not enforced against status so
-- the current processor, which does not write it yet, keeps working).
ALTER TABLE "ExportJob"
  ADD CONSTRAINT "ExportJob_fileHash_sha256_check"
  CHECK ("fileHash" IS NULL OR "fileHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "ExportJob"
  ADD CONSTRAINT "ExportJob_recordCount_nonneg_check"
  CHECK ("recordCount" IS NULL OR "recordCount" >= 0);
ALTER TABLE "ExportJob"
  ADD CONSTRAINT "ExportJob_mappingVersion_positive_check"
  CHECK ("mappingVersion" IS NULL OR "mappingVersion" >= 1);
ALTER TABLE "ExportJob"
  ADD CONSTRAINT "ExportJob_attemptCount_nonneg_check"
  CHECK ("attemptCount" >= 0);

-- Existing duplicate active jobs would make the unique index below fail to
-- build. Keep the newest active job per key, mark older ones FAILED.
-- velto_owner is NOBYPASSRLS and the table is FORCE RLS, so without
-- app.current_company_id the UPDATE would match zero rows; RLS is switched off
-- only for this cross-tenant fix-up and restored (ENABLE + FORCE) in the same
-- migration transaction — same pattern as 20261013150000.
ALTER TABLE "ExportJob" DISABLE ROW LEVEL SECURITY;

UPDATE "ExportJob" e
SET "status" = 'FAILED',
    "errorLog" = jsonb_build_object('message', 'superseded by a newer active export for the same period (F5 migration)'),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE e."status" IN ('PENDING', 'PROCESSING')
  AND EXISTS (
    SELECT 1 FROM "ExportJob" n
    WHERE n."companyId" = e."companyId"
      AND n."type" = e."type"
      AND n."format" = e."format"
      AND n."periodFrom" = e."periodFrom"
      AND n."periodTo" = e."periodTo"
      AND n."status" IN ('PENDING', 'PROCESSING')
      AND (n."createdAt", n."id") > (e."createdAt", e."id")
  );

ALTER TABLE "ExportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExportJob" FORCE ROW LEVEL SECURITY;

-- At most one active export per company + kind + format + period.
CREATE UNIQUE INDEX "ExportJob_active_period_key"
  ON "ExportJob" ("companyId", "type", "format", "periodFrom", "periodTo")
  WHERE "status" IN ('PENDING', 'PROCESSING');

-- Cross-tenant guard for the pre-existing requestedBy FK (was missing).
CREATE TRIGGER exportjob_requestedby_same_company
  BEFORE INSERT OR UPDATE OF "requestedBy", "companyId" ON "ExportJob"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'requestedBy');

-- ---------------------------------------------------------------------------
-- ImportJob
-- ---------------------------------------------------------------------------
ALTER TABLE "ImportJob"
  ADD COLUMN "createdBy" UUID,
  ADD COLUMN "progress"  INTEGER;

ALTER TABLE "ImportJob"
  ADD CONSTRAINT "ImportJob_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ImportJob"
  ADD CONSTRAINT "ImportJob_progress_range_check"
  CHECK ("progress" IS NULL OR ("progress" >= 0 AND "progress" <= 100));

CREATE TRIGGER importjob_createdby_same_company
  BEFORE INSERT OR UPDATE OF "createdBy", "companyId" ON "ImportJob"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'createdBy');

-- Listing by company, newest first.
CREATE INDEX "ImportJob_companyId_createdAt_idx" ON "ImportJob" ("companyId", "createdAt" DESC);
