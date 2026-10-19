-- F8.1 / ADR-029 extension (security audit): every payment a SALES_AGENT enters
-- goes through handover, whatever the method (CASH/CARD/TRANSFER) — otherwise an
-- agent could book collected cash as "CARD" and close debt with no cashier.
-- Forward-only, backward-compatible: relaxes Payment_handover_shape_check (only
-- widens what is allowed; every existing row still satisfies it), and adds a
-- DB-level self-resolve ban to the PENDING_HANDOVER transitions (same meaning as
-- the service's PaymentHandoverSelfResolve). Insert guard and allocation guard
-- are method-agnostic and stay unchanged.

ALTER TABLE "Payment" DROP CONSTRAINT "Payment_handover_shape_check";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_handover_shape_check" CHECK (
  CASE "status"
    WHEN 'PENDING_HANDOVER' THEN
      "method" IN ('CASH', 'CARD', 'TRANSFER') AND "collectedBy" IS NOT NULL
      AND "handoverActorId" IS NULL AND "handoverAt" IS NULL
      AND "handoverCashSessionId" IS NULL AND "handoverRejectReason" IS NULL
    WHEN 'REJECTED' THEN
      "method" IN ('CASH', 'CARD', 'TRANSFER') AND "collectedBy" IS NOT NULL
      AND "handoverActorId" IS NOT NULL AND "handoverAt" IS NOT NULL
      AND "handoverCashSessionId" IS NULL
      AND length(btrim(coalesce("handoverRejectReason", ''))) > 0
    ELSE -- POSTED / REVERSED: direct entry (all NULL) or accepted handover
      "handoverRejectReason" IS NULL
      AND (
        ("handoverActorId" IS NULL AND "handoverAt" IS NULL AND "handoverCashSessionId" IS NULL)
        OR ("handoverActorId" IS NOT NULL AND "handoverAt" IS NOT NULL AND "handoverCashSessionId" IS NOT NULL
            AND "method" IN ('CASH', 'CARD', 'TRANSFER') AND "collectedBy" IS NOT NULL)
      )
  END
);

-- Same body as 20261019100100_payment_handover plus the self-resolve ban on
-- both PENDING_HANDOVER exits. Same function name, so payment_guard_update
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

  IF OLD."status" = 'PENDING_HANDOVER' AND NEW."status" IN ('POSTED', 'REJECTED')
     AND NEW."handoverActorId" IS NOT NULL
     AND NEW."handoverActorId" = OLD."collectedBy" THEN
    RAISE EXCEPTION 'Payment handover: collector may not resolve their own handover'
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
