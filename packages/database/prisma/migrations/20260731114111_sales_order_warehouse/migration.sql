-- AlterTable: add nullable first — `prisma migrate deploy` against a
-- non-empty SalesOrder table (any staging/UAT/prod environment that already
-- has orders) fails outright on a NOT NULL column with no default, so this
-- backfills existing rows from each company's oldest warehouse before the
-- NOT NULL constraint is applied below.
ALTER TABLE "SalesOrder" ADD COLUMN     "warehouseId" UUID;

-- Backfill: assign each pre-existing SalesOrder its company's oldest
-- warehouse (mirrors SalesService.resolveWarehouse's single-warehouse
-- default). A company with existing orders but zero warehouses is left
-- NULL and will fail the NOT NULL step below — that's a genuine data
-- inconsistency (orders can't have shipped from a warehouse that never
-- existed) that needs a manual decision, not a silent default.
UPDATE "SalesOrder" so
SET "warehouseId" = (
  SELECT w."id" FROM "Warehouse" w
  WHERE w."companyId" = so."companyId"
  ORDER BY w."createdAt" ASC
  LIMIT 1
)
WHERE so."warehouseId" IS NULL;

-- AlterTable
ALTER TABLE "SalesOrder" ALTER COLUMN "warehouseId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
