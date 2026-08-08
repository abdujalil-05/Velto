-- Product simplification: drop credit-limit/ON_HOLD order approval, drop
-- INN (tin) everywhere, hard-block visit GPS (drop the reason bypass), and
-- add RouteRun to back a new explicit "finish route" action.

-- --- 1. OrderStatus: drop ON_HOLD -------------------------------------------
-- Backfill first: any existing ON_HOLD order becomes SUBMITTED (the status it
-- would have had before the credit-limit gate ever ran) so the enum swap
-- below never hits a row with a value that's about to stop existing. This
-- migration runs as `velto` (not the BYPASSRLS `velto_system` role) with no
-- app.current_company_id set, so the tenant_isolation policy would silently
-- match zero rows across every tenant — RLS has to come off for this
-- cross-tenant UPDATE, same as any other migration-time backfill.
ALTER TABLE "SalesOrder" DISABLE ROW LEVEL SECURITY;
UPDATE "SalesOrder" SET "status" = 'SUBMITTED' WHERE "status" = 'ON_HOLD';
ALTER TABLE "SalesOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SalesOrder" FORCE ROW LEVEL SECURITY;

CREATE TYPE "OrderStatus_new" AS ENUM ('DRAFT', 'SUBMITTED', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED');
ALTER TABLE "SalesOrder" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "SalesOrder" ALTER COLUMN "status" TYPE "OrderStatus_new" USING ("status"::text::"OrderStatus_new");
ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";
DROP TYPE "OrderStatus_old";
ALTER TABLE "SalesOrder" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- --- 2. Drop credit limit ----------------------------------------------------
ALTER TABLE "Customer" DROP COLUMN "creditLimit";

-- --- 3. Drop INN (tin) --------------------------------------------------------
DROP INDEX "Customer_companyId_tin_idx";
ALTER TABLE "Company" DROP COLUMN "tin";
ALTER TABLE "Customer" DROP COLUMN "tin";
ALTER TABLE "Supplier" DROP COLUMN "tin";

-- --- 4. Visit: hard GPS block, drop the reason-bypass -----------------------
ALTER TABLE "Visit" DROP COLUMN "reasonIfFar";
ALTER TABLE "Visit" ALTER COLUMN "gpsOk" DROP NOT NULL;

-- --- 5. RouteRun: backs the new "finish route" action -----------------------
CREATE TABLE "RouteRun" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RouteRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RouteRun_routeId_date_key" ON "RouteRun"("routeId", "date");
CREATE INDEX "RouteRun_companyId_idx" ON "RouteRun"("companyId");

ALTER TABLE "RouteRun" ADD CONSTRAINT "RouteRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RouteRun" ADD CONSTRAINT "RouteRun_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant isolation (6.10/SEC-001..005) — same direct-companyId pattern as
-- every other tenant-scoped table, see 20260730161500_rls_and_audit_lock.
ALTER TABLE "RouteRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RouteRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RouteRun"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);
