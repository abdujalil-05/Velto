-- ADR-058 follow-up: one-time out-of-band MFA enrollment code, required for a
-- user's FIRST TOTP enrollment so a password alone cannot bind an attacker's
-- authenticator. Forward-only, purely additive: one new table, no existing
-- row/column touched.

-- CreateTable
CREATE TABLE "MfaEnrollmentCode" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaEnrollmentCode_pkey" PRIMARY KEY ("id"),
    -- Only a sha256 hex digest is ever stored, never the plain code.
    CONSTRAINT "MfaEnrollmentCode_codeHash_sha256_check" CHECK ("codeHash" ~ '^[0-9a-f]{64}$')
);

-- CreateIndex
CREATE UNIQUE INDEX "MfaEnrollmentCode_codeHash_key" ON "MfaEnrollmentCode"("codeHash");
CREATE INDEX "MfaEnrollmentCode_userId_usedAt_idx" ON "MfaEnrollmentCode"("userId", "usedAt");
CREATE INDEX "MfaEnrollmentCode_companyId_idx" ON "MfaEnrollmentCode"("companyId");
CREATE INDEX "MfaEnrollmentCode_createdById_idx" ON "MfaEnrollmentCode"("createdById");

-- AddForeignKey
ALTER TABLE "MfaEnrollmentCode" ADD CONSTRAINT "MfaEnrollmentCode_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MfaEnrollmentCode" ADD CONSTRAINT "MfaEnrollmentCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MfaEnrollmentCode" ADD CONSTRAINT "MfaEnrollmentCode_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant isolation (§10.4 / SEC-001..005) — same direct-companyId policy as "UserMfa".
ALTER TABLE "MfaEnrollmentCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MfaEnrollmentCode" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MfaEnrollmentCode"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

-- Cross-tenant FK guards: both the target user and the issuer (when set) must
-- belong to the row's own company. The guard passes a NULL createdById.
CREATE TRIGGER mfaenrollmentcode_user_same_company
  BEFORE INSERT OR UPDATE ON "MfaEnrollmentCode"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'userId');

CREATE TRIGGER mfaenrollmentcode_createdby_same_company
  BEFORE INSERT OR UPDATE ON "MfaEnrollmentCode"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'createdById');

-- Runtime DML grants (mirrors "UserMfa", 20261031100000_user_mfa).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velto_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "MfaEnrollmentCode" TO velto_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velto_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "MfaEnrollmentCode" TO velto_system;
  END IF;
END
$$;
