-- DropIndex
DROP INDEX "Customer_companyId_code_key";

-- DropIndex
DROP INDEX "Product_companyId_sku_key";

-- CreateIndex
CREATE INDEX "Customer_companyId_code_idx" ON "Customer"("companyId", "code");

-- CreateIndex
CREATE INDEX "Product_companyId_sku_idx" ON "Product"("companyId", "sku");

-- Partial unique indexes: uniqueness only applies to live rows, so a
-- soft-deleted Customer.code / Product.sku can be reused (6.1 "Soft delete
-- tarixiy hujjatlarga tegmaydi" — old documents keep their snapshot, but the
-- business key itself should be free again once the row is gone from view).
-- Prisma's schema DSL has no way to express a filtered unique index, hence
-- hand-written raw SQL here instead of a `@@unique` in schema.prisma.
CREATE UNIQUE INDEX "Customer_companyId_code_live_key"
  ON "Customer" ("companyId", "code")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "Product_companyId_sku_live_key"
  ON "Product" ("companyId", "sku")
  WHERE "deletedAt" IS NULL;
