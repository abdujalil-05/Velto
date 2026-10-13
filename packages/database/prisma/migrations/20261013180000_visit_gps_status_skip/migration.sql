-- F3 step 1: Visit GPS status + skipped stops, per-company GPS thresholds.
-- Forward-only, backward-compatible: only nullable columns, NOT NULL columns
-- with defaults, a relaxed NOT NULL (latitude/longitude) and a new enum value.
-- No new table, so RLS policies are unchanged (Visit/Company keep their
-- direct-companyId / own-id policies from 20260730161500).
--
-- Backfill of "Visit"."gpsStatus" (pre-F3 every visit has coordinates, and
-- per the old schema comment gpsOk NULL meant "outlet has no coordinates, the
-- check could not run"):
--   gpsOk = true  -> VERIFIED
--   gpsOk = false -> OUTSIDE_RADIUS
--   gpsOk IS NULL -> OUTLET_NO_COORDS (coordinates present), NO_FIX (absent)
-- velto_owner is NOBYPASSRLS and Visit is FORCE RLS, so RLS is switched off
-- only for this cross-tenant backfill and restored (ENABLE + FORCE) in the
-- same migration transaction — same pattern as 20261013150000.
--
-- gpsOk stays as a trigger-maintained derived column (not GENERATED: existing
-- writers still INSERT gpsOk, which a generated column would reject):
-- trigger "Visit_gps_sync" overwrites it from gpsStatus, and CHECK
-- "Visit_gpsOk_derived_check" guards the invariant if the trigger is ever
-- dropped. For writers that predate F3 (insert coordinates + gpsOk, no GPS
-- metadata, gpsStatus left at the NO_FIX default) the trigger derives
-- gpsStatus from gpsOk with the backfill rule above.

-- AlterEnum (the new value is only compared as text below — an enum literal
-- added in the same transaction cannot be used as an enum constant).
ALTER TYPE "VisitOutcome" ADD VALUE 'SKIPPED';

-- CreateEnum
CREATE TYPE "GpsStatus" AS ENUM ('VERIFIED', 'OUTSIDE_RADIUS', 'LOW_ACCURACY', 'NO_PERMISSION', 'NO_FIX', 'OUTLET_NO_COORDS');

-- AlterTable: Company thresholds
ALTER TABLE "Company"
  ADD COLUMN "visitGpsRadiusM" INTEGER NOT NULL DEFAULT 150,
  ADD COLUMN "gpsMaxAccuracyM" INTEGER NOT NULL DEFAULT 100;

ALTER TABLE "Company"
  ADD CONSTRAINT "Company_visitGpsRadiusM_range_check"
  CHECK ("visitGpsRadiusM" BETWEEN 10 AND 5000);
ALTER TABLE "Company"
  ADD CONSTRAINT "Company_gpsMaxAccuracyM_range_check"
  CHECK ("gpsMaxAccuracyM" BETWEEN 5 AND 1000);

-- AlterTable: Visit
ALTER TABLE "Visit"
  ALTER COLUMN "latitude" DROP NOT NULL,
  ALTER COLUMN "longitude" DROP NOT NULL,
  ADD COLUMN "gpsStatus" "GpsStatus" NOT NULL DEFAULT 'NO_FIX',
  ADD COLUMN "gpsAccuracyM" DECIMAL(8,2),
  ADD COLUMN "gpsCapturedAt" TIMESTAMP(3),
  ADD COLUMN "distanceM" DECIMAL(10,2),
  ADD COLUMN "skipReason" TEXT;

-- Backfill
ALTER TABLE "Visit" DISABLE ROW LEVEL SECURITY;

UPDATE "Visit"
SET "gpsStatus" = CASE
  WHEN "gpsOk" IS TRUE THEN 'VERIFIED'::"GpsStatus"
  WHEN "gpsOk" IS FALSE THEN 'OUTSIDE_RADIUS'::"GpsStatus"
  WHEN "latitude" IS NOT NULL THEN 'OUTLET_NO_COORDS'::"GpsStatus"
  ELSE 'NO_FIX'::"GpsStatus"
END;

ALTER TABLE "Visit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Visit" FORCE ROW LEVEL SECURITY;

-- Invariants (added after the backfill).
ALTER TABLE "Visit"
  ADD CONSTRAINT "Visit_coords_pair_check"
  CHECK (("latitude" IS NULL) = ("longitude" IS NULL));

ALTER TABLE "Visit"
  ADD CONSTRAINT "Visit_gpsStatus_coords_check"
  CHECK (("gpsStatus" IN ('NO_PERMISSION', 'NO_FIX')) = ("latitude" IS NULL));

ALTER TABLE "Visit"
  ADD CONSTRAINT "Visit_gpsOk_derived_check"
  CHECK ("gpsOk" IS NOT DISTINCT FROM CASE "gpsStatus"
    WHEN 'VERIFIED' THEN TRUE
    WHEN 'OUTSIDE_RADIUS' THEN FALSE
    WHEN 'LOW_ACCURACY' THEN FALSE
    ELSE NULL
  END);

ALTER TABLE "Visit"
  ADD CONSTRAINT "Visit_gps_metrics_nonneg_check"
  CHECK (("gpsAccuracyM" IS NULL OR "gpsAccuracyM" >= 0) AND ("distanceM" IS NULL OR "distanceM" >= 0));

ALTER TABLE "Visit"
  ADD CONSTRAINT "Visit_skipReason_check"
  CHECK (
    (("outcome"::text = 'SKIPPED') = ("skipReason" IS NOT NULL))
    AND ("skipReason" IS NULL OR btrim("skipReason") <> '')
  );

-- Trigger: keep gpsOk derived from gpsStatus; derive gpsStatus for pre-F3 writers.
CREATE FUNCTION "visit_gps_sync"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     AND NEW."gpsStatus" = 'NO_FIX'
     AND NEW."latitude" IS NOT NULL
     AND NEW."gpsAccuracyM" IS NULL
     AND NEW."gpsCapturedAt" IS NULL
     AND NEW."distanceM" IS NULL THEN
    NEW."gpsStatus" := CASE
      WHEN NEW."gpsOk" IS TRUE THEN 'VERIFIED'::"GpsStatus"
      WHEN NEW."gpsOk" IS FALSE THEN 'OUTSIDE_RADIUS'::"GpsStatus"
      ELSE 'OUTLET_NO_COORDS'::"GpsStatus"
    END;
  END IF;

  NEW."gpsOk" := CASE NEW."gpsStatus"
    WHEN 'VERIFIED' THEN TRUE
    WHEN 'OUTSIDE_RADIUS' THEN FALSE
    WHEN 'LOW_ACCURACY' THEN FALSE
    ELSE NULL
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Visit_gps_sync"
  BEFORE INSERT OR UPDATE ON "Visit"
  FOR EACH ROW EXECUTE FUNCTION "visit_gps_sync"();
