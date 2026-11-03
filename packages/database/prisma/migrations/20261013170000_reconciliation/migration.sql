-- F2.5 (§6.4, §6.5): projection drift reconciliation (StockLevel vs
-- StockMovement ledger, Customer.cachedBalance vs invoice/payment ledger).
-- Forward-only, backward-compatible: new enums + tables only, nothing existing changes.

-- CreateEnum
CREATE TYPE "ReconciliationKind" AS ENUM ('STOCK', 'BALANCE');

-- CreateEnum
CREATE TYPE "ReconciliationTrigger" AS ENUM ('SCHEDULED', 'MANUAL');

-- CreateEnum
CREATE TYPE "ReconciliationFindingStatus" AS ENUM ('OPEN', 'FIXED');

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "trigger" "ReconciliationTrigger" NOT NULL,
    "triggeredById" UUID,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "stockChecked" INTEGER NOT NULL DEFAULT 0,
    "stockFindings" INTEGER NOT NULL DEFAULT 0,
    "balanceChecked" INTEGER NOT NULL DEFAULT 0,
    "balanceFindings" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReconciliationRun_counts_check" CHECK (
      "stockChecked" >= 0 AND "stockFindings" >= 0 AND "balanceChecked" >= 0 AND "balanceFindings" >= 0
    ),
    CONSTRAINT "ReconciliationRun_finished_check" CHECK ("finishedAt" IS NULL OR "finishedAt" >= "startedAt"),
    -- A MANUAL run always records who started it.
    CONSTRAINT "ReconciliationRun_trigger_check" CHECK ("trigger" <> 'MANUAL' OR "triggeredById" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "ReconciliationFinding" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "lastRunId" UUID NOT NULL,
    "kind" "ReconciliationKind" NOT NULL,
    "status" "ReconciliationFindingStatus" NOT NULL DEFAULT 'OPEN',
    "productId" UUID,
    "warehouseId" UUID,
    "customerId" UUID,
    "expectedOnHand" DECIMAL(18,3),
    "actualOnHand" DECIMAL(18,3),
    "diffOnHand" DECIMAL(18,3),
    "expectedReserved" DECIMAL(18,3),
    "actualReserved" DECIMAL(18,3),
    "diffReserved" DECIMAL(18,3),
    "expectedBalance" DECIMAL(18,2),
    "actualBalance" DECIMAL(18,2),
    "diffBalance" DECIMAL(18,2),
    "fixedAt" TIMESTAMP(3),
    "fixedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationFinding_pkey" PRIMARY KEY ("id"),
    -- Per-kind shape: STOCK carries (product, warehouse) + qty columns only;
    -- BALANCE carries customer + money columns only. diff = actual − expected.
    CONSTRAINT "ReconciliationFinding_kind_shape_check" CHECK (
      ("kind" = 'STOCK'
        AND "productId" IS NOT NULL AND "warehouseId" IS NOT NULL AND "customerId" IS NULL
        AND "expectedOnHand" IS NOT NULL AND "actualOnHand" IS NOT NULL AND "diffOnHand" IS NOT NULL
        AND "expectedReserved" IS NOT NULL AND "actualReserved" IS NOT NULL AND "diffReserved" IS NOT NULL
        AND "diffOnHand" = "actualOnHand" - "expectedOnHand"
        AND "diffReserved" = "actualReserved" - "expectedReserved"
        AND "expectedBalance" IS NULL AND "actualBalance" IS NULL AND "diffBalance" IS NULL)
      OR
      ("kind" = 'BALANCE'
        AND "customerId" IS NOT NULL AND "productId" IS NULL AND "warehouseId" IS NULL
        AND "expectedBalance" IS NOT NULL AND "actualBalance" IS NOT NULL AND "diffBalance" IS NOT NULL
        AND "diffBalance" = "actualBalance" - "expectedBalance"
        AND "expectedOnHand" IS NULL AND "actualOnHand" IS NULL AND "diffOnHand" IS NULL
        AND "expectedReserved" IS NULL AND "actualReserved" IS NULL AND "diffReserved" IS NULL)
    ),
    -- FIXED <-> fixedAt + fixedBy set; OPEN <-> both null.
    CONSTRAINT "ReconciliationFinding_status_check" CHECK (
      ("status" = 'OPEN' AND "fixedAt" IS NULL AND "fixedById" IS NULL)
      OR ("status" = 'FIXED' AND "fixedAt" IS NOT NULL AND "fixedById" IS NOT NULL)
    )
);

-- CreateIndex
CREATE INDEX "ReconciliationRun_companyId_startedAt_idx" ON "ReconciliationRun"("companyId", "startedAt");

-- CreateIndex
CREATE INDEX "ReconciliationFinding_companyId_status_kind_idx" ON "ReconciliationFinding"("companyId", "status", "kind");

-- CreateIndex
CREATE INDEX "ReconciliationFinding_runId_idx" ON "ReconciliationFinding"("runId");

-- CreateIndex
CREATE INDEX "ReconciliationFinding_lastRunId_idx" ON "ReconciliationFinding"("lastRunId");

-- Dedupe (SQL-only; Prisma 6 cannot model partial indexes): at most one OPEN
-- finding per (companyId, kind, subject). A repeat run updates the OPEN row
-- (lastRunId/values) instead of inserting; FIXED rows are history and unlimited.
CREATE UNIQUE INDEX "ReconciliationFinding_open_stock_key"
  ON "ReconciliationFinding"("companyId", "productId", "warehouseId")
  WHERE "status" = 'OPEN' AND "kind" = 'STOCK';
CREATE UNIQUE INDEX "ReconciliationFinding_open_balance_key"
  ON "ReconciliationFinding"("companyId", "customerId")
  WHERE "status" = 'OPEN' AND "kind" = 'BALANCE';

-- AddForeignKey
ALTER TABLE "ReconciliationRun" ADD CONSTRAINT "ReconciliationRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationRun" ADD CONSTRAINT "ReconciliationRun_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationFinding" ADD CONSTRAINT "ReconciliationFinding_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationFinding" ADD CONSTRAINT "ReconciliationFinding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationFinding" ADD CONSTRAINT "ReconciliationFinding_lastRunId_fkey" FOREIGN KEY ("lastRunId") REFERENCES "ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationFinding" ADD CONSTRAINT "ReconciliationFinding_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationFinding" ADD CONSTRAINT "ReconciliationFinding_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationFinding" ADD CONSTRAINT "ReconciliationFinding_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationFinding" ADD CONSTRAINT "ReconciliationFinding_fixedById_fkey" FOREIGN KEY ("fixedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant isolation (§10.4 / SEC-001..005) — direct-companyId policy.
ALTER TABLE "ReconciliationRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReconciliationRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ReconciliationRun"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "ReconciliationFinding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReconciliationFinding" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ReconciliationFinding"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

-- Cross-tenant FK guards (pattern: 20261012170000_idempotency_record).
CREATE TRIGGER reconciliationrun_triggeredby_same_company
  BEFORE INSERT OR UPDATE ON "ReconciliationRun"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'triggeredById');
CREATE TRIGGER reconciliationfinding_run_same_company
  BEFORE INSERT OR UPDATE ON "ReconciliationFinding"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('ReconciliationRun', 'runId');
CREATE TRIGGER reconciliationfinding_lastrun_same_company
  BEFORE INSERT OR UPDATE ON "ReconciliationFinding"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('ReconciliationRun', 'lastRunId');
CREATE TRIGGER reconciliationfinding_product_same_company
  BEFORE INSERT OR UPDATE ON "ReconciliationFinding"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Product', 'productId');
CREATE TRIGGER reconciliationfinding_warehouse_same_company
  BEFORE INSERT OR UPDATE ON "ReconciliationFinding"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Warehouse', 'warehouseId');
CREATE TRIGGER reconciliationfinding_customer_same_company
  BEFORE INSERT OR UPDATE ON "ReconciliationFinding"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Customer', 'customerId');
CREATE TRIGGER reconciliationfinding_fixedby_same_company
  BEFORE INSERT OR UPDATE ON "ReconciliationFinding"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'fixedById');

-- Runtime DML grants (see 20261012170000_idempotency_record for rationale).
-- velto_system: the scheduled cross-tenant job enumerates companies, then
-- writes via withTenant; granted for parity with other tenant tables.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velto_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ReconciliationRun", "ReconciliationFinding" TO velto_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velto_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ReconciliationRun", "ReconciliationFinding" TO velto_system;
  END IF;
END
$$;
