-- ADR-060: Notification becomes a deduplicated, retryable Telegram delivery
-- record (durable outbox, ADR-047 pattern). Forward-only, purely additive (one
-- enum, eight nullable/defaulted columns, two CHECKs, one unique index, one
-- partial index, one trigger). No data is deleted or rewritten except the
-- updatedAt backfill (= createdAt). RLS policy tenant_isolation (FOR ALL, row
-- predicate on "companyId", WITH CHECK = USING) is column-agnostic and
-- therefore already covers the new columns; table-level DML grants for
-- velto_app/velto_system (provision-roles.sql, no column-level grants) cover
-- them too. ENABLE + FORCE are restored below after the backfill.
--
-- telegramStatus NULL = pre-migration legacy row: never swept by the worker.
-- dedupKey NULL rows stay distinct under the unique index (Postgres default
-- NULLS DISTINCT), so legacy rows are unaffected.

-- CreateEnum
CREATE TYPE "NotificationTelegramStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- AlterTable (constant defaults / nullable: catalog-only on PG11+, no rewrite)
ALTER TABLE "Notification" ADD COLUMN "updatedAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN "dedupKey" TEXT;
ALTER TABLE "Notification" ADD COLUMN "telegramStatus" "NotificationTelegramStatus";
ALTER TABLE "Notification" ADD COLUMN "telegramAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Notification" ADD COLUMN "telegramNextAttemptAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN "telegramClaimedAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN "telegramSentAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN "telegramLastError" TEXT;

-- Backfill: velto_owner is NOBYPASSRLS and the table is FORCE RLS, so without
-- app.current_company_id the UPDATE would see zero rows. RLS is switched off
-- only for this cross-tenant backfill and restored (ENABLE + FORCE) in the same
-- migration transaction — pattern of 20261031120000. The bump trigger is
-- created only afterwards, so the backfill keeps "createdAt" verbatim.
ALTER TABLE "Notification" DISABLE ROW LEVEL SECURITY;
UPDATE "Notification" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Notification" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Notification" ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_telegramAttempts_nonneg_check" CHECK ("telegramAttempts" >= 0);
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_telegramLastError_len_check"
  CHECK ("telegramLastError" IS NULL OR char_length("telegramLastError") <= 500);

-- Trigger: every UPDATE (Prisma or raw SQL, any role incl. BYPASSRLS
-- velto_system sweep) stamps the row's last state change.
CREATE FUNCTION velto_notification_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Prisma stores DateTime as UTC in timestamp-without-tz; pin UTC so the
  -- value does not depend on the session TimeZone.
  NEW."updatedAt" := now() AT TIME ZONE 'UTC';
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_set_updated_at
  BEFORE UPDATE ON "Notification"
  FOR EACH ROW EXECUTE FUNCTION velto_notification_set_updated_at();

-- CreateIndex: per-recipient idempotency of alerts (e.g. "payment.reverse:<id>").
CREATE UNIQUE INDEX "Notification_companyId_recipientId_dedupKey_key"
  ON "Notification"("companyId", "recipientId", "dedupKey");

-- Cross-tenant delivery sweep (systemPrisma): only live rows, legacy NULL and
-- terminal SENT/FAILED/SKIPPED rows never enter the index.
CREATE INDEX "Notification_telegram_sweep_idx"
  ON "Notification"("telegramStatus", "telegramNextAttemptAt")
  WHERE "telegramStatus" IN ('PENDING', 'SENDING');
