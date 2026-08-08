-- CreateTable
CREATE TABLE "ExportJob" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "fileUrl" TEXT,
    "errorLog" JSONB,
    "requestedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExportJob_companyId_status_idx" ON "ExportJob"("companyId", "status");

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant isolation (6.10/SEC-001..005) — same direct-companyId pattern as
-- every other tenant-scoped table, see 20260730161500_rls_and_audit_lock.
ALTER TABLE "ExportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExportJob" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ExportJob"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);
