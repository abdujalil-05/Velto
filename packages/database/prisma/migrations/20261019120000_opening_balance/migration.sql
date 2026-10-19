-- F6: opening balances (TZ §6.7.1 openingQty, §6.7.3; ADR-026 import rules).
-- Forward-only, backward-compatible: new enums/table, new columns that are
-- either nullable or NOT NULL with a default (fast default, no table rewrite,
-- no UPDATE trigger fires), Payment.method relaxed to NULL-able, new CHECKs
-- that every existing row already satisfies (no OPENING rows exist yet), new
-- partial unique indexes and triggers. No backfill.
--
-- Ledger shape of an opening balance (no new StockMovementType):
--   customer debt   -> Invoice  kind 'OPENING', no lines, no order, OB-... number
--   customer credit -> Payment  source 'OPENING', method/collector NULL, POSTED
--   stock qty       -> StockMovement ADJUST, refType 'OpeningBalance', refId = batch
-- All three point at an OpeningBalanceBatch (same company, matching kind,
-- still PREVIEWED at insert). The batch moves PREVIEWED -> POSTED -> VOIDED only:
--   -> POSTED  totals must equal its ledger rows (written in the same tx first)
--   -> VOIDED  every ledger row must already be compensated (invoice CANCELLED,
--              payment REVERSED via PaymentReversal, movement reversed)
-- Payment / StockMovement append-only guards are unchanged: an OPENING payment
-- is inserted as POSTED with NULL handover columns (passes payment_guard_insert
-- and Payment_handover_shape_check) and may only go POSTED -> REVERSED.

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('SALE', 'OPENING');

-- CreateEnum
CREATE TYPE "PaymentSource" AS ENUM ('COLLECTION', 'OPENING');

-- CreateEnum
CREATE TYPE "OpeningBalanceKind" AS ENUM ('CUSTOMER_BALANCE', 'STOCK');

-- CreateEnum
CREATE TYPE "OpeningBalanceStatus" AS ENUM ('PREVIEWED', 'POSTED', 'VOIDED');

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "externalDocRef" TEXT,
ADD COLUMN     "kind" "InvoiceKind" NOT NULL DEFAULT 'SALE',
ADD COLUMN     "openingBatchId" UUID;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "openingBatchId" UUID,
ADD COLUMN     "source" "PaymentSource" NOT NULL DEFAULT 'COLLECTION',
ALTER COLUMN "method" DROP NOT NULL;

-- CreateTable
CREATE TABLE "OpeningBalanceBatch" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "kind" "OpeningBalanceKind" NOT NULL,
    "asOfDate" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "importJobId" UUID,
    "status" "OpeningBalanceStatus" NOT NULL DEFAULT 'PREVIEWED',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "debtTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "creditTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "qtyTotal" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "createdBy" UUID NOT NULL,
    "postedBy" UUID,
    "postedAt" TIMESTAMP(3),
    "voidedBy" UUID,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpeningBalanceBatch_pkey" PRIMARY KEY ("id"),
    -- Totals are non-negative and belong to the batch kind.
    CONSTRAINT "OpeningBalanceBatch_totals_check" CHECK (
      "rowCount" >= 0 AND "debtTotal" >= 0 AND "creditTotal" >= 0 AND "qtyTotal" >= 0
      AND length(btrim("source")) > 0 AND length(btrim("fileHash")) > 0
      AND CASE "kind"
            WHEN 'STOCK' THEN "debtTotal" = 0 AND "creditTotal" = 0
            ELSE "qtyTotal" = 0
          END
    ),
    -- Row shape per status (actor/time written exactly at the transition).
    CONSTRAINT "OpeningBalanceBatch_status_shape_check" CHECK (
      CASE "status"
        WHEN 'PREVIEWED' THEN
          "postedBy" IS NULL AND "postedAt" IS NULL
          AND "voidedBy" IS NULL AND "voidedAt" IS NULL AND "voidReason" IS NULL
        WHEN 'POSTED' THEN
          "postedBy" IS NOT NULL AND "postedAt" IS NOT NULL
          AND "voidedBy" IS NULL AND "voidedAt" IS NULL AND "voidReason" IS NULL
        ELSE -- VOIDED
          "postedBy" IS NOT NULL AND "postedAt" IS NOT NULL
          AND "voidedBy" IS NOT NULL AND "voidedAt" IS NOT NULL
          AND length(btrim(coalesce("voidReason", ''))) > 0
      END
    )
);

-- CreateIndex
CREATE INDEX "OpeningBalanceBatch_companyId_kind_status_idx" ON "OpeningBalanceBatch"("companyId", "kind", "status");

-- CreateIndex
CREATE INDEX "OpeningBalanceBatch_importJobId_idx" ON "OpeningBalanceBatch"("importJobId");

-- CreateIndex
CREATE INDEX "OpeningBalanceBatch_createdBy_idx" ON "OpeningBalanceBatch"("createdBy");

-- CreateIndex
CREATE INDEX "OpeningBalanceBatch_postedBy_idx" ON "OpeningBalanceBatch"("postedBy");

-- CreateIndex
CREATE INDEX "OpeningBalanceBatch_voidedBy_idx" ON "OpeningBalanceBatch"("voidedBy");

-- CreateIndex
CREATE INDEX "Invoice_openingBatchId_idx" ON "Invoice"("openingBatchId");

-- CreateIndex
CREATE INDEX "Payment_openingBatchId_idx" ON "Payment"("openingBatchId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_openingBatchId_fkey" FOREIGN KEY ("openingBatchId") REFERENCES "OpeningBalanceBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_openingBatchId_fkey" FOREIGN KEY ("openingBatchId") REFERENCES "OpeningBalanceBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningBalanceBatch" ADD CONSTRAINT "OpeningBalanceBatch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningBalanceBatch" ADD CONSTRAINT "OpeningBalanceBatch_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "ImportJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningBalanceBatch" ADD CONSTRAINT "OpeningBalanceBatch_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningBalanceBatch" ADD CONSTRAINT "OpeningBalanceBatch_postedBy_fkey" FOREIGN KEY ("postedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningBalanceBatch" ADD CONSTRAINT "OpeningBalanceBatch_voidedBy_fkey" FOREIGN KEY ("voidedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Tenant isolation (§10.4 / SEC-001..005) — direct-companyId policy.
-- ---------------------------------------------------------------------------
ALTER TABLE "OpeningBalanceBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OpeningBalanceBatch" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OpeningBalanceBatch"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

-- Cross-tenant FK guards (pattern: 20261012170000_idempotency_record).
CREATE TRIGGER openingbatch_createdby_same_company
  BEFORE INSERT OR UPDATE ON "OpeningBalanceBatch"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'createdBy');
CREATE TRIGGER openingbatch_postedby_same_company
  BEFORE INSERT OR UPDATE ON "OpeningBalanceBatch"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'postedBy');
CREATE TRIGGER openingbatch_voidedby_same_company
  BEFORE INSERT OR UPDATE ON "OpeningBalanceBatch"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'voidedBy');
CREATE TRIGGER openingbatch_importjob_same_company
  BEFORE INSERT OR UPDATE ON "OpeningBalanceBatch"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('ImportJob', 'importJobId');
CREATE TRIGGER invoice_openingbatch_same_company
  BEFORE INSERT OR UPDATE ON "Invoice"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('OpeningBalanceBatch', 'openingBatchId');
CREATE TRIGGER payment_openingbatch_same_company
  BEFORE INSERT OR UPDATE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('OpeningBalanceBatch', 'openingBatchId');

-- ---------------------------------------------------------------------------
-- Batch lifecycle (fires for every role, including velto_system).
-- ---------------------------------------------------------------------------
CREATE FUNCTION velto_opening_batch_guard_insert() RETURNS trigger AS $$
BEGIN
  IF NEW."status" <> 'PREVIEWED' THEN
    RAISE EXCEPTION 'OpeningBalanceBatch must be inserted as PREVIEWED, not %', NEW."status"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION velto_opening_batch_guard_update() RETURNS trigger AS $$
DECLARE
  void_cols CONSTANT text[] := ARRAY['status', 'updatedAt', 'voidedBy', 'voidedAt', 'voidReason'];
  ledger_debt   numeric;
  ledger_credit numeric;
  ledger_qty    numeric;
BEGIN
  IF (NEW."companyId", NEW."kind", NEW."createdBy", NEW."createdAt")
     IS DISTINCT FROM (OLD."companyId", OLD."kind", OLD."createdBy", OLD."createdAt") THEN
    RAISE EXCEPTION 'OpeningBalanceBatch %: companyId/kind/createdBy/createdAt are immutable', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  -- Re-preview: file, date and totals may still be replaced.
  IF OLD."status" = 'PREVIEWED' AND NEW."status" = 'PREVIEWED' THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'PREVIEWED' AND NEW."status" = 'POSTED' THEN
    -- The ledger rows are written in the same transaction before this flip;
    -- the frozen totals must be exactly what was posted.
    SELECT coalesce(sum(i."total"), 0) INTO ledger_debt
      FROM "Invoice" i WHERE i."openingBatchId" = NEW."id";
    SELECT coalesce(sum(p."amount"), 0) INTO ledger_credit
      FROM "Payment" p WHERE p."openingBatchId" = NEW."id";
    SELECT coalesce(sum(sm."qty"), 0) INTO ledger_qty
      FROM "StockMovement" sm
      WHERE sm."refType" = 'OpeningBalance' AND sm."refId" = NEW."id" AND sm."reversesMovementId" IS NULL;
    IF ledger_debt <> NEW."debtTotal" OR ledger_credit <> NEW."creditTotal" OR ledger_qty <> NEW."qtyTotal" THEN
      RAISE EXCEPTION 'OpeningBalanceBatch %: totals (debt %, credit %, qty %) do not match posted ledger rows (debt %, credit %, qty %)',
        NEW."id", NEW."debtTotal", NEW."creditTotal", NEW."qtyTotal", ledger_debt, ledger_credit, ledger_qty
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'POSTED' AND NEW."status" = 'VOIDED' THEN
    IF (to_jsonb(NEW) - void_cols) IS DISTINCT FROM (to_jsonb(OLD) - void_cols) THEN
      RAISE EXCEPTION 'OpeningBalanceBatch %: a POSTED batch is frozen; void may only set status/voidedBy/voidedAt/voidReason', OLD."id"
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM "Invoice" i WHERE i."openingBatchId" = OLD."id" AND i."status" <> 'CANCELLED')
       OR EXISTS (SELECT 1 FROM "Payment" p WHERE p."openingBatchId" = OLD."id" AND p."status" <> 'REVERSED')
       OR EXISTS (
         SELECT 1 FROM "StockMovement" sm
         WHERE sm."refType" = 'OpeningBalance' AND sm."refId" = OLD."id" AND sm."reversesMovementId" IS NULL
           AND NOT EXISTS (SELECT 1 FROM "StockMovement" r WHERE r."reversesMovementId" = sm."id")
       ) THEN
      RAISE EXCEPTION 'OpeningBalanceBatch %: void requires every ledger row compensated first (invoice CANCELLED, payment REVERSED, movement reversed)', OLD."id"
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'OpeningBalanceBatch %: % -> % is not allowed (POSTED is frozen, VOIDED is terminal)', OLD."id", OLD."status", NEW."status"
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER openingbatch_guard_insert
  BEFORE INSERT ON "OpeningBalanceBatch"
  FOR EACH ROW EXECUTE FUNCTION velto_opening_batch_guard_insert();
CREATE TRIGGER openingbatch_guard_update
  BEFORE UPDATE ON "OpeningBalanceBatch"
  FOR EACH ROW EXECUTE FUNCTION velto_opening_batch_guard_update();
CREATE TRIGGER openingbatch_no_delete
  BEFORE DELETE ON "OpeningBalanceBatch"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
CREATE TRIGGER openingbatch_no_truncate
  BEFORE TRUNCATE ON "OpeningBalanceBatch"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

-- A ledger row may only be attached to a same-company batch of the right kind
-- that is still PREVIEWED (rows are written by the post transaction, before
-- the PREVIEWED -> POSTED flip). Under RLS another tenant's batch is
-- invisible, so it reads as "not found".
CREATE FUNCTION velto_assert_opening_batch_open(batch_id uuid, company_id uuid, want_kind "OpeningBalanceKind")
RETURNS void AS $$
DECLARE
  b_company uuid;
  b_kind    "OpeningBalanceKind";
  b_status  "OpeningBalanceStatus";
BEGIN
  SELECT b."companyId", b."kind", b."status" INTO b_company, b_kind, b_status
    FROM "OpeningBalanceBatch" b WHERE b."id" = batch_id FOR SHARE;
  IF NOT FOUND OR b_company IS DISTINCT FROM company_id THEN
    RAISE EXCEPTION 'cross-tenant reference: OpeningBalanceBatch % is not visible in company %', batch_id, company_id
      USING ERRCODE = '23514';
  END IF;
  IF b_kind <> want_kind THEN
    RAISE EXCEPTION 'OpeningBalanceBatch % is %, expected %', batch_id, b_kind, want_kind
      USING ERRCODE = '23514';
  END IF;
  IF b_status <> 'PREVIEWED' THEN
    RAISE EXCEPTION 'OpeningBalanceBatch % is %, ledger rows can only be added while PREVIEWED', batch_id, b_status
      USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Invoice: kind OPENING
-- ---------------------------------------------------------------------------
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_opening_shape_check" CHECK (
  CASE "kind"
    WHEN 'OPENING' THEN
      "openingBatchId" IS NOT NULL AND "orderId" IS NULL AND "total" > 0 AND "number" LIKE 'OB-%'
    ELSE
      "openingBatchId" IS NULL
  END
  AND ("externalDocRef" IS NULL OR length(btrim("externalDocRef")) > 0)
);

-- One opening invoice per (customer, external document).
CREATE UNIQUE INDEX "Invoice_opening_externalDocRef_key" ON "Invoice"("companyId", "customerId", "externalDocRef")
  WHERE "kind" = 'OPENING' AND "externalDocRef" IS NOT NULL;

CREATE FUNCTION velto_invoice_opening_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'OPENING' THEN
      PERFORM velto_assert_opening_batch_open(NEW."openingBatchId", NEW."companyId", 'CUSTOMER_BALANCE');
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."kind", NEW."openingBatchId", NEW."externalDocRef")
     IS DISTINCT FROM (OLD."kind", OLD."openingBatchId", OLD."externalDocRef") THEN
    RAISE EXCEPTION 'Invoice %: kind/openingBatchId/externalDocRef are immutable', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  IF OLD."kind" = 'OPENING' AND (NEW."companyId", NEW."number", NEW."customerId", NEW."orderId", NEW."total", NEW."createdAt")
     IS DISTINCT FROM (OLD."companyId", OLD."number", OLD."customerId", OLD."orderId", OLD."total", OLD."createdAt") THEN
    RAISE EXCEPTION 'Invoice %: an OPENING invoice may only change status', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_opening_guard
  BEFORE INSERT OR UPDATE ON "Invoice"
  FOR EACH ROW EXECUTE FUNCTION velto_invoice_opening_guard();

-- An OPENING invoice is a bare debt figure: no lines.
CREATE FUNCTION velto_invoice_line_not_opening() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Invoice" i WHERE i."id" = NEW."invoiceId" AND i."kind" = 'OPENING') THEN
    RAISE EXCEPTION 'InvoiceLine: invoice % is an OPENING invoice and has no lines', NEW."invoiceId"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoiceline_not_opening
  BEFORE INSERT OR UPDATE ON "InvoiceLine"
  FOR EACH ROW EXECUTE FUNCTION velto_invoice_line_not_opening();

-- ---------------------------------------------------------------------------
-- Payment: source OPENING
-- ---------------------------------------------------------------------------
-- OPENING <=> method NULL; OPENING => no collector, has batch, POSTED (or
-- REVERSED by a later void), never handed over. COLLECTION => method set, no
-- batch. Complements (does not replace) Payment_handover_shape_check, whose
-- `method IN (...)` terms are NULL-tolerant; this CHECK is what makes a NULL
-- method impossible for every non-OPENING row.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_source_shape_check" CHECK (
  CASE "source"
    WHEN 'OPENING' THEN
      "method" IS NULL AND "collectedBy" IS NULL AND "openingBatchId" IS NOT NULL
      AND "status" IN ('POSTED', 'REVERSED') AND "amount" > 0 AND "number" LIKE 'OB-%'
      AND "handoverActorId" IS NULL AND "handoverAt" IS NULL
      AND "handoverCashSessionId" IS NULL AND "handoverRejectReason" IS NULL
    ELSE
      "method" IS NOT NULL AND "openingBatchId" IS NULL
  END
);

-- One live opening credit per customer (a voided one is REVERSED).
CREATE UNIQUE INDEX "Payment_opening_customer_key" ON "Payment"("companyId", "customerId")
  WHERE "source" = 'OPENING' AND "status" <> 'REVERSED';

CREATE FUNCTION velto_payment_opening_guard_insert() RETURNS trigger AS $$
BEGIN
  IF NEW."source" = 'OPENING' THEN
    PERFORM velto_assert_opening_batch_open(NEW."openingBatchId", NEW."companyId", 'CUSTOMER_BALANCE');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_opening_guard_insert
  BEFORE INSERT ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION velto_payment_opening_guard_insert();

-- ---------------------------------------------------------------------------
-- StockMovement: opening stock (ADJUST, refType 'OpeningBalance')
-- ---------------------------------------------------------------------------
-- NOT VALID is unnecessary: no existing row uses refType 'OpeningBalance'.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_opening_shape_check" CHECK (
  "refType" IS DISTINCT FROM 'OpeningBalance'
  OR "reversesMovementId" IS NOT NULL
  OR ("type" = 'ADJUST' AND "refId" IS NOT NULL AND "qty" > 0)
);

-- One opening quantity per product per warehouse (reversal rows excluded).
CREATE UNIQUE INDEX "StockMovement_opening_product_warehouse_key" ON "StockMovement"("companyId", "productId", "warehouseId")
  WHERE "refType" = 'OpeningBalance' AND "reversesMovementId" IS NULL;

-- Batch total / void checks look movements up by batch.
CREATE INDEX "StockMovement_opening_refId_idx" ON "StockMovement"("refId")
  WHERE "refType" = 'OpeningBalance';

CREATE FUNCTION velto_stock_movement_opening_guard_insert() RETURNS trigger AS $$
BEGIN
  IF NEW."refType" = 'OpeningBalance' AND NEW."reversesMovementId" IS NULL THEN
    PERFORM velto_assert_opening_batch_open(NEW."refId", NEW."companyId", 'STOCK');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stockmovement_opening_guard_insert
  BEFORE INSERT ON "StockMovement"
  FOR EACH ROW EXECUTE FUNCTION velto_stock_movement_opening_guard_insert();

-- Runtime DML grants (guarded for role-less shadow databases). DELETE is
-- granted for Prisma parity but the trigger above rejects it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velto_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "OpeningBalanceBatch" TO velto_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velto_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "OpeningBalanceBatch" TO velto_system;
  END IF;
END
$$;
