-- F8.1 / ADR-029 (TZ §6.5, §6.7.2, §5.4.2 F-01): payment handover.
-- Forward-only, backward-compatible: four nullable columns, FKs, indexes, a
-- row-shape CHECK and trigger changes. No backfill: every existing row is
-- POSTED or REVERSED with NULL handover columns, which is exactly the shape
-- of a payment entered directly by a cashier/office (validated by the CHECK).
--
-- Payment stays append-only. The only in-place changes ever allowed:
--   PENDING_HANDOVER -> POSTED    set handoverActorId/At/CashSessionId; the
--                                 session must be the actor's own OPEN shift
--   PENDING_HANDOVER -> REJECTED  set handoverActorId/At/RejectReason
--   POSTED           -> REVERSED  unchanged F2.1 rule (PaymentReversal first)
-- number/customerId/amount/method/collectedBy/clientId/createdAt never change,
-- and the handover columns are write-once (only on the PENDING_HANDOVER exit).
-- New rows may only be inserted as PENDING_HANDOVER or POSTED, with NULL
-- handover columns. PaymentAllocation may only point at a POSTED payment (no
-- FIFO while in transit). RLS on Payment is unchanged (companyId policy).

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "handoverActorId" UUID,
ADD COLUMN "handoverAt" TIMESTAMP(3),
ADD COLUMN "handoverCashSessionId" UUID,
ADD COLUMN "handoverRejectReason" TEXT;

-- Row shape per status.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_handover_shape_check" CHECK (
  CASE "status"
    WHEN 'PENDING_HANDOVER' THEN
      "method" = 'CASH' AND "collectedBy" IS NOT NULL
      AND "handoverActorId" IS NULL AND "handoverAt" IS NULL
      AND "handoverCashSessionId" IS NULL AND "handoverRejectReason" IS NULL
    WHEN 'REJECTED' THEN
      "method" = 'CASH' AND "collectedBy" IS NOT NULL
      AND "handoverActorId" IS NOT NULL AND "handoverAt" IS NOT NULL
      AND "handoverCashSessionId" IS NULL
      AND length(btrim(coalesce("handoverRejectReason", ''))) > 0
    ELSE -- POSTED / REVERSED: direct entry (all NULL) or accepted handover
      "handoverRejectReason" IS NULL
      AND (
        ("handoverActorId" IS NULL AND "handoverAt" IS NULL AND "handoverCashSessionId" IS NULL)
        OR ("handoverActorId" IS NOT NULL AND "handoverAt" IS NOT NULL AND "handoverCashSessionId" IS NOT NULL
            AND "method" = 'CASH' AND "collectedBy" IS NOT NULL)
      )
  END
);

-- CreateIndex
CREATE INDEX "Payment_companyId_status_idx" ON "Payment"("companyId", "status");

-- CreateIndex
CREATE INDEX "Payment_handoverActorId_idx" ON "Payment"("handoverActorId");

-- CreateIndex
CREATE INDEX "Payment_handoverCashSessionId_idx" ON "Payment"("handoverCashSessionId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_handoverActorId_fkey" FOREIGN KEY ("handoverActorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_handoverCashSessionId_fkey" FOREIGN KEY ("handoverCashSessionId") REFERENCES "CashSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cross-tenant FK guards (pattern: 20261012170000_idempotency_record).
CREATE TRIGGER payment_handover_actor_same_company
  BEFORE INSERT OR UPDATE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'handoverActorId');
CREATE TRIGGER payment_handover_cash_session_same_company
  BEFORE INSERT OR UPDATE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('CashSession', 'handoverCashSessionId');

-- Insert: only PENDING_HANDOVER or POSTED, never pre-resolved.
CREATE FUNCTION velto_payment_guard_insert() RETURNS trigger AS $$
BEGIN
  IF NEW."status" NOT IN ('PENDING_HANDOVER', 'POSTED') THEN
    RAISE EXCEPTION 'Payment must be inserted as PENDING_HANDOVER or POSTED, not %', NEW."status"
      USING ERRCODE = '23514';
  END IF;
  IF NEW."handoverActorId" IS NOT NULL OR NEW."handoverAt" IS NOT NULL
     OR NEW."handoverCashSessionId" IS NOT NULL OR NEW."handoverRejectReason" IS NOT NULL THEN
    RAISE EXCEPTION 'Payment handover columns are set only by the PENDING_HANDOVER transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_guard_insert
  BEFORE INSERT ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION velto_payment_guard_insert();

-- Update: replaces the F2.1 body (POSTED -> REVERSED only) with the
-- three permitted transitions. Same function name, so payment_guard_update
-- keeps firing it.
CREATE OR REPLACE FUNCTION velto_payment_guard_update() RETURNS trigger AS $$
DECLARE
  handover_cols CONSTANT text[] := ARRAY['handoverActorId', 'handoverAt', 'handoverCashSessionId', 'handoverRejectReason'];
  session_user_id uuid;
  session_closed_at timestamp(3);
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'updatedAt' - handover_cols)
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updatedAt' - handover_cols) THEN
    RAISE EXCEPTION 'Payment is append-only: only status and handover resolution may change'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'PENDING_HANDOVER' AND NEW."status" = 'POSTED' THEN
    -- Shape (actor/at/session NOT NULL, reason NULL) is the CHECK's job; the
    -- session must be the accepting actor's own shift and still open. FOR
    -- SHARE serialises against a concurrent close of that shift.
    SELECT cs."userId", cs."closedAt" INTO session_user_id, session_closed_at
      FROM "CashSession" cs WHERE cs."id" = NEW."handoverCashSessionId" FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Payment handover: cash session % not found', NEW."handoverCashSessionId"
        USING ERRCODE = '23514';
    END IF;
    IF session_closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Payment handover: cash session % is closed', NEW."handoverCashSessionId"
        USING ERRCODE = '23514';
    END IF;
    IF session_user_id IS DISTINCT FROM NEW."handoverActorId" THEN
      RAISE EXCEPTION 'Payment handover: cash session % does not belong to the accepting user', NEW."handoverCashSessionId"
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'PENDING_HANDOVER' AND NEW."status" = 'REJECTED' THEN
    RETURN NEW; -- actor/at/reason enforced by Payment_handover_shape_check
  END IF;

  IF OLD."status" = 'POSTED' AND NEW."status" = 'REVERSED' THEN
    IF (to_jsonb(NEW) - 'status' - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updatedAt') THEN
      RAISE EXCEPTION 'Payment is append-only: reversal may not change handover columns'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "PaymentReversal" r WHERE r."reversesPaymentId" = OLD."id") THEN
      RAISE EXCEPTION 'Payment % cannot be REVERSED without a PaymentReversal row', OLD."id"
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Payment is append-only: status % -> % is not allowed', OLD."status", NEW."status"
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

-- Allocation (FIFO or manual advance) only against a POSTED payment: a
-- PENDING_HANDOVER payment is "in transit" and must not reduce debt.
CREATE FUNCTION velto_payment_allocation_requires_posted() RETURNS trigger AS $$
DECLARE
  payment_status "PaymentStatus";
BEGIN
  SELECT p."status" INTO payment_status FROM "Payment" p WHERE p."id" = NEW."paymentId";
  IF payment_status IS DISTINCT FROM 'POSTED' THEN
    RAISE EXCEPTION 'PaymentAllocation requires a POSTED payment (payment % is %)', NEW."paymentId", payment_status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER paymentallocation_requires_posted
  BEFORE INSERT ON "PaymentAllocation"
  FOR EACH ROW EXECUTE FUNCTION velto_payment_allocation_requires_posted();
