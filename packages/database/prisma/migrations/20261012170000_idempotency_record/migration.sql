-- F1.3 / §10.5: HTTP Idempotency-Key replay store (tenant-scoped).
-- Forward-only, backward-compatible: new table only, nothing existing changes.

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "route" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_companyId_key_key" ON "IdempotencyRecord"("companyId", "key");

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (§10.4 / SEC-001..005) — same direct-companyId policy
-- pattern as the other tenant-root tables.
ALTER TABLE "IdempotencyRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdempotencyRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "IdempotencyRecord"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

-- Cross-tenant FK guard (same as 20260808120000_tenant_scoped_keys_and_fk_guards):
-- the stored userId must belong to the row's own company.
CREATE TRIGGER idempotencyrecord_user_same_company
  BEFORE INSERT OR UPDATE ON "IdempotencyRecord"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'userId');

-- Runtime DML grants. ALTER DEFAULT PRIVILEGES FOR ROLE velto_owner
-- (scripts/provision-roles.sql) already covers this when velto_owner runs the
-- migration; granted explicitly so the table is usable regardless of which
-- role applied it. Guarded so environments without the roles (e.g. a bare
-- shadow database) don't fail.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velto_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "IdempotencyRecord" TO velto_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velto_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "IdempotencyRecord" TO velto_system;
  END IF;
END
$$;
