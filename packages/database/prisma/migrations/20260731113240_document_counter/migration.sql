-- CreateTable
CREATE TABLE "DocumentCounter" (
    "companyId" UUID NOT NULL,
    "docType" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentCounter_pkey" PRIMARY KEY ("companyId","docType","year")
);

-- AddForeignKey
ALTER TABLE "DocumentCounter" ADD CONSTRAINT "DocumentCounter_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "Customer_name_trgm_idx" RENAME TO "Customer_name_idx";

-- Tenant isolation (6.10 / SEC-001..005) — same direct-companyId policy
-- pattern as the other tenant-root tables.
ALTER TABLE "DocumentCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentCounter" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DocumentCounter"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);
