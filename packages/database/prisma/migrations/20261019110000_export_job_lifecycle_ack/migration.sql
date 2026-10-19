-- F5.3 / ADR-030 (TZ §7.x 1C export): ExportJob lifecycle + manual accountant ACK.
--
--   QUEUED -> PROCESSING
--   PROCESSING -> QUEUED (retry) | GENERATED | FAILED
--   GENERATED -> ACCOUNTING_ACCEPTED | FAILED_REVIEW   (manual ACK, checksum)
--   FAILED, ACCOUNTING_ACCEPTED, FAILED_REVIEW are terminal.
--
-- status/format move from free TEXT to enums. Both types are NEW (CREATE TYPE,
-- not ALTER TYPE ... ADD VALUE), so their values are usable in this same
-- transaction — no separate enum migration is needed.
--
-- Backfill (real values found: status PENDING/PROCESSING/DONE/FAILED, format
-- XML/EXCEL): PENDING -> QUEUED, DONE -> GENERATED, PROCESSING/FAILED kept;
-- format kept. Any other value aborts the migration instead of guessing.
--
-- fileUrl is NOT dropped here (apps/api still reads/writes it): storageKey is
-- added and backfilled from it; fileUrl is deprecated and goes in a later,
-- separate release (backup + recovery plan, §17).
--
-- Legacy DONE rows never got fileHash/recordCount (the processor did not
-- write them), so the "artifact present from GENERATED on" CHECK is added
-- NOT VALID: enforced for every new/updated row, legacy rows grandfathered.
-- Such a legacy row can never be ACKed (ackChecksum must equal a non-NULL
-- fileHash) — re-export instead. RLS on ExportJob is unchanged (companyId
-- policy, FORCE); no new table.

-- velto_owner is NOBYPASSRLS and the table is FORCE RLS, so without
-- app.current_company_id the pre-check/backfill below would see zero rows.
-- RLS is switched off only for this cross-tenant fix-up and restored
-- (ENABLE + FORCE) in the same migration transaction — pattern 20261014090000.
ALTER TABLE "ExportJob" DISABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 1. Fail loudly on values the mapping does not know.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad_status bigint;
  bad_format bigint;
BEGIN
  SELECT count(*) INTO bad_status FROM "ExportJob"
    WHERE "status" NOT IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED');
  SELECT count(*) INTO bad_format FROM "ExportJob"
    WHERE "format" NOT IN ('XML', 'EXCEL', 'CSV');
  IF bad_status > 0 OR bad_format > 0 THEN
    RAISE EXCEPTION 'ExportJob backfill: % row(s) with unknown status, % with unknown format', bad_status, bad_format;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Enums + the legacy-value mapping (kept as functions so the exact
--    backfill rule is covered by tenant-isolation.test.ts).
-- ---------------------------------------------------------------------------
CREATE TYPE "ExportJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'GENERATED', 'FAILED', 'ACCOUNTING_ACCEPTED', 'FAILED_REVIEW');
CREATE TYPE "ExportFormat" AS ENUM ('EXCEL', 'CSV', 'XML');

CREATE FUNCTION velto_export_job_status_from_legacy(legacy text) RETURNS "ExportJobStatus" AS $$
BEGIN
  RETURN CASE legacy
    WHEN 'PENDING'    THEN 'QUEUED'::"ExportJobStatus"
    WHEN 'PROCESSING' THEN 'PROCESSING'::"ExportJobStatus"
    WHEN 'DONE'       THEN 'GENERATED'::"ExportJobStatus"
    WHEN 'FAILED'     THEN 'FAILED'::"ExportJobStatus"
    ELSE NULL
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE FUNCTION velto_export_format_from_legacy(legacy text) RETURNS "ExportFormat" AS $$
BEGIN
  RETURN CASE legacy
    WHEN 'XML'   THEN 'XML'::"ExportFormat"
    WHEN 'EXCEL' THEN 'EXCEL'::"ExportFormat"
    WHEN 'CSV'   THEN 'CSV'::"ExportFormat"
    ELSE NULL
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

-- The partial unique index's predicate compares status to TEXT literals that
-- no longer exist in the enum; drop it and recreate it on the new values.
DROP INDEX "ExportJob_active_period_key";

-- NOT NULL on both columns rejects any NULL the mapping could return.
ALTER TABLE "ExportJob"
  ALTER COLUMN "status" TYPE "ExportJobStatus" USING velto_export_job_status_from_legacy("status"),
  ALTER COLUMN "status" SET DEFAULT 'QUEUED',
  ALTER COLUMN "format" TYPE "ExportFormat" USING velto_export_format_from_legacy("format");

-- ---------------------------------------------------------------------------
-- 3. New columns (all nullable — backward-compatible).
-- ---------------------------------------------------------------------------
ALTER TABLE "ExportJob"
  ADD COLUMN "storageKey"     TEXT,
  ADD COLUMN "fileName"       TEXT,
  ADD COLUMN "fileSize"       INTEGER,
  ADD COLUMN "generatedAt"    TIMESTAMP(3),
  ADD COLUMN "acknowledgedAt" TIMESTAMP(3),
  ADD COLUMN "acknowledgedBy" UUID,
  ADD COLUMN "ackChecksum"    TEXT,
  ADD COLUMN "ackNote"        VARCHAR(1000);

-- storageKey from the legacy public URL "<endpoint>/<bucket>/<key>"
-- (StorageService.upload); every 1C key starts with "exports/". A URL of any
-- other shape is preserved verbatim rather than lost.
UPDATE "ExportJob"
SET "storageKey" = coalesce(substring("fileUrl" from '(exports/.+)$'), "fileUrl")
WHERE "fileUrl" IS NOT NULL;

ALTER TABLE "ExportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExportJob" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 4. Row-shape CHECKs.
-- ---------------------------------------------------------------------------
ALTER TABLE "ExportJob"
  ADD CONSTRAINT "ExportJob_fileSize_nonneg_check"
  CHECK ("fileSize" IS NULL OR "fileSize" >= 0);

-- ACK columns exist only in the two ACK statuses; there they are complete,
-- the checksum matches the generated file, FAILED_REVIEW carries a reason.
-- (Explicit IS NOT NULL: a NULL comparison would make a CHECK pass.)
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_ack_shape_check" CHECK (
  CASE
    WHEN "status" IN ('ACCOUNTING_ACCEPTED', 'FAILED_REVIEW') THEN
      "acknowledgedBy" IS NOT NULL AND "acknowledgedAt" IS NOT NULL
      AND "ackChecksum" IS NOT NULL AND "fileHash" IS NOT NULL
      AND "ackChecksum" = "fileHash"
      AND ("status" <> 'FAILED_REVIEW' OR length(btrim(coalesce("ackNote", ''))) >= 3)
    ELSE
      "acknowledgedBy" IS NULL AND "acknowledgedAt" IS NULL
      AND "ackChecksum" IS NULL AND "ackNote" IS NULL
  END
);

-- From GENERATED on, the produced artifact must be fully described.
-- NOT VALID: legacy DONE rows (no hash/recordCount) are grandfathered.
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_generated_artifact_check" CHECK (
  "status" NOT IN ('GENERATED', 'ACCOUNTING_ACCEPTED', 'FAILED_REVIEW')
  OR ("fileHash" IS NOT NULL AND "storageKey" IS NOT NULL AND "recordCount" IS NOT NULL)
) NOT VALID;

-- ---------------------------------------------------------------------------
-- 5. acknowledgedBy FK + cross-tenant guard (pattern: 20261014090000).
--    RESTRICT: the acknowledging accountant's identity is evidence.
-- ---------------------------------------------------------------------------
ALTER TABLE "ExportJob"
  ADD CONSTRAINT "ExportJob_acknowledgedBy_fkey"
  FOREIGN KEY ("acknowledgedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ExportJob_acknowledgedBy_idx" ON "ExportJob"("acknowledgedBy");

CREATE TRIGGER exportjob_acknowledgedby_same_company
  BEFORE INSERT OR UPDATE OF "acknowledgedBy", "companyId" ON "ExportJob"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'acknowledgedBy');

-- At most one active export per company + kind + format + period.
CREATE UNIQUE INDEX "ExportJob_active_period_key"
  ON "ExportJob" ("companyId", "type", "format", "periodFrom", "periodTo")
  WHERE "status" IN ('QUEUED', 'PROCESSING');

-- ---------------------------------------------------------------------------
-- 6. Lifecycle triggers (fire for every role, including velto_system).
-- ---------------------------------------------------------------------------
CREATE FUNCTION velto_export_job_guard_insert() RETURNS trigger AS $$
BEGIN
  IF NEW."status" <> 'QUEUED' THEN
    RAISE EXCEPTION 'ExportJob must be inserted as QUEUED, not %', NEW."status"
      USING ERRCODE = '23514';
  END IF;
  IF NEW."fileHash" IS NOT NULL OR NEW."storageKey" IS NOT NULL OR NEW."recordCount" IS NOT NULL
     OR NEW."fileName" IS NOT NULL OR NEW."fileSize" IS NOT NULL OR NEW."generatedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'ExportJob must be inserted without a generated artifact'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION velto_export_job_guard_update() RETURNS trigger AS $$
DECLARE
  is_ack boolean := OLD."status" = 'GENERATED'
                    AND NEW."status" IN ('ACCOUNTING_ACCEPTED', 'FAILED_REVIEW');
BEGIN
  IF NEW."companyId" IS DISTINCT FROM OLD."companyId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'ExportJob %: companyId/createdAt are immutable', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'QUEUED'     AND NEW."status" = 'PROCESSING')
    OR (OLD."status" = 'PROCESSING' AND NEW."status" IN ('QUEUED', 'GENERATED', 'FAILED'))
    OR is_ack
  ) THEN
    RAISE EXCEPTION 'ExportJob %: transition % -> % is not allowed', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('GENERATED', 'ACCOUNTING_ACCEPTED', 'FAILED_REVIEW') AND (
       NEW."type", NEW."format", NEW."periodFrom", NEW."periodTo", NEW."fileHash", NEW."storageKey",
       NEW."fileName", NEW."fileSize", NEW."recordCount", NEW."mappingVersion", NEW."generatedAt"
     ) IS DISTINCT FROM (
       OLD."type", OLD."format", OLD."periodFrom", OLD."periodTo", OLD."fileHash", OLD."storageKey",
       OLD."fileName", OLD."fileSize", OLD."recordCount", OLD."mappingVersion", OLD."generatedAt"
     ) THEN
    RAISE EXCEPTION 'ExportJob %: generated file, period, type and format are immutable once %', OLD."id", OLD."status"
      USING ERRCODE = '23514';
  END IF;

  -- ACK columns are written exactly once, on the GENERATED -> ACK transition.
  IF NOT is_ack AND (NEW."acknowledgedAt", NEW."acknowledgedBy", NEW."ackChecksum", NEW."ackNote")
       IS DISTINCT FROM (OLD."acknowledgedAt", OLD."acknowledgedBy", OLD."ackChecksum", OLD."ackNote") THEN
    RAISE EXCEPTION 'ExportJob %: ACK columns are write-once (only on GENERATED -> ACCOUNTING_ACCEPTED/FAILED_REVIEW)', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exportjob_guard_insert
  BEFORE INSERT ON "ExportJob"
  FOR EACH ROW EXECUTE FUNCTION velto_export_job_guard_insert();
CREATE TRIGGER exportjob_guard_update
  BEFORE UPDATE ON "ExportJob"
  FOR EACH ROW EXECUTE FUNCTION velto_export_job_guard_update();

-- Export history is evidence (what was handed to accounting): no DELETE /
-- TRUNCATE, same mechanism as Payment/StockMovement (20261013120000).
CREATE TRIGGER exportjob_no_delete
  BEFORE DELETE ON "ExportJob"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
CREATE TRIGGER exportjob_no_truncate
  BEFORE TRUNCATE ON "ExportJob"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();
