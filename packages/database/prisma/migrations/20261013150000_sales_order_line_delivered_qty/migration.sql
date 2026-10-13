-- F2.4 step 1: SalesOrderLine.deliveredQty (partial goods issue).
-- Forward-only, backward-compatible: new NOT NULL column with DEFAULT 0, so
-- existing writers that don't know the column keep working. No new table, so
-- RLS policies are unchanged (SalesOrderLine stays parent-subquery scoped).
--
-- Backfill: lines of orders already DELIVERED or CLOSED were fully issued, so
-- deliveredQty = qty. velto_owner is NOBYPASSRLS and both tables are FORCE RLS,
-- so without app.current_company_id the UPDATE (and the SalesOrder subquery in
-- the SalesOrderLine policy) would match zero rows. RLS is switched off only for
-- this cross-tenant backfill and restored (ENABLE + FORCE) in the same
-- migration transaction — same pattern as 20260806090000.

-- AlterTable
ALTER TABLE "SalesOrderLine" ADD COLUMN "deliveredQty" DECIMAL(18,3) NOT NULL DEFAULT 0;

-- Backfill
ALTER TABLE "SalesOrder" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "SalesOrderLine" DISABLE ROW LEVEL SECURITY;

UPDATE "SalesOrderLine" sol
SET "deliveredQty" = sol."qty"
FROM "SalesOrder" so
WHERE so."id" = sol."orderId"
  AND so."status" IN ('DELIVERED', 'CLOSED');

ALTER TABLE "SalesOrderLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SalesOrderLine" FORCE ROW LEVEL SECURITY;
ALTER TABLE "SalesOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SalesOrder" FORCE ROW LEVEL SECURITY;

-- Invariant: 0 <= deliveredQty <= qty (added after the backfill).
ALTER TABLE "SalesOrderLine"
  ADD CONSTRAINT "SalesOrderLine_deliveredQty_range_check"
  CHECK ("deliveredQty" >= 0 AND "deliveredQty" <= "qty");
