-- F2.1: payment / stock-movement reversal + append-only locks.
-- Forward-only, backward-compatible: new enum/column with a default, new
-- nullable columns, new table, new triggers. No existing data is rewritten.
--
-- * Payment.status (POSTED/REVERSED, default POSTED). The only in-place change
--   ever allowed on a Payment is POSTED -> REVERSED (+ updatedAt), and only once
--   a PaymentReversal row for it exists.
-- * PaymentReversal: append-only, one per payment, tenant-scoped.
-- * StockMovement.reversesMovementId (unique, self-FK) + reason: a reversal is
--   a new compensating movement; the original is never touched.
-- * Payment, PaymentAllocation, StockMovement, PaymentReversal: UPDATE/DELETE/
--   TRUNCATE blocked by trigger for every role, including velto_system.
-- Closed-cash-session / exported-to-1C prohibitions are service-layer checks.

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('POSTED', 'REVERSED');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "status" "PaymentStatus" NOT NULL DEFAULT 'POSTED';

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN "reason" TEXT,
ADD COLUMN "reversesMovementId" UUID;

-- A reversal must say why.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_reversal_reason_check"
  CHECK ("reversesMovementId" IS NULL OR length(btrim(coalesce("reason", ''))) > 0);
-- A movement cannot reverse itself.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_reversal_not_self_check"
  CHECK ("reversesMovementId" IS NULL OR "reversesMovementId" <> "id");

-- CreateTable
CREATE TABLE "PaymentReversal" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "reversesPaymentId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentReversal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PaymentReversal_reason_check" CHECK (length(btrim("reason")) > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentReversal_reversesPaymentId_key" ON "PaymentReversal"("reversesPaymentId");

-- CreateIndex
CREATE INDEX "PaymentReversal_companyId_idx" ON "PaymentReversal"("companyId");

-- CreateIndex
CREATE INDEX "PaymentReversal_actorId_idx" ON "PaymentReversal"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_reversesMovementId_key" ON "StockMovement"("reversesMovementId");

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_reversesMovementId_fkey" FOREIGN KEY ("reversesMovementId") REFERENCES "StockMovement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_reversesPaymentId_fkey" FOREIGN KEY ("reversesPaymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant isolation (§10.4 / SEC-001..005) — direct-companyId policy.
ALTER TABLE "PaymentReversal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentReversal" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PaymentReversal"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

-- Cross-tenant FK guards (pattern: 20261012170000_idempotency_record).
CREATE TRIGGER paymentreversal_payment_same_company
  BEFORE INSERT OR UPDATE ON "PaymentReversal"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Payment', 'reversesPaymentId');
CREATE TRIGGER paymentreversal_actor_same_company
  BEFORE INSERT OR UPDATE ON "PaymentReversal"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'actorId');
CREATE TRIGGER stockmovement_reverses_same_company
  BEFORE INSERT OR UPDATE ON "StockMovement"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('StockMovement', 'reversesMovementId');

-- ---------------------------------------------------------------------------
-- Append-only locks (TZ 6.1: no hard delete / in-place edit of financial rows
-- and stock movements — corrections are reversals). Reuses
-- prevent_append_only_mutation() from 20261012120000_restore_purchasing.
-- Audit (grep, 2026-10-13): no code path UPDATEs/DELETEs Payment,
-- PaymentAllocation or StockMovement; Customer.cachedBalance / StockLevel are
-- separate projection tables and stay writable.
-- ---------------------------------------------------------------------------

-- Payment: only POSTED -> REVERSED (+ updatedAt), after its PaymentReversal row.
CREATE FUNCTION velto_payment_guard_update() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updatedAt') THEN
    RAISE EXCEPTION 'Payment is append-only: only status POSTED -> REVERSED may change'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (OLD."status" = 'POSTED' AND NEW."status" = 'REVERSED') THEN
    RAISE EXCEPTION 'Payment is append-only: status % -> % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "PaymentReversal" r WHERE r."reversesPaymentId" = OLD."id") THEN
    RAISE EXCEPTION 'Payment % cannot be REVERSED without a PaymentReversal row', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_guard_update
  BEFORE UPDATE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION velto_payment_guard_update();
CREATE TRIGGER payment_no_delete
  BEFORE DELETE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
CREATE TRIGGER payment_no_truncate
  BEFORE TRUNCATE ON "Payment"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER paymentallocation_no_update
  BEFORE UPDATE ON "PaymentAllocation"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
CREATE TRIGGER paymentallocation_no_delete
  BEFORE DELETE ON "PaymentAllocation"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
CREATE TRIGGER paymentallocation_no_truncate
  BEFORE TRUNCATE ON "PaymentAllocation"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER stockmovement_no_update
  BEFORE UPDATE ON "StockMovement"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
CREATE TRIGGER stockmovement_no_delete
  BEFORE DELETE ON "StockMovement"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
CREATE TRIGGER stockmovement_no_truncate
  BEFORE TRUNCATE ON "StockMovement"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER paymentreversal_no_update
  BEFORE UPDATE ON "PaymentReversal"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
CREATE TRIGGER paymentreversal_no_delete
  BEFORE DELETE ON "PaymentReversal"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
CREATE TRIGGER paymentreversal_no_truncate
  BEFORE TRUNCATE ON "PaymentReversal"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

-- Runtime DML grants (guarded for role-less shadow databases). UPDATE/DELETE
-- are granted for Prisma parity but the triggers above reject them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velto_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "PaymentReversal" TO velto_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velto_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "PaymentReversal" TO velto_system;
  END IF;
END
$$;
