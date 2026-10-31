-- ADR-058: mandatory TOTP MFA — DB layer.
-- Forward-only, backward-compatible: two new tables + one nullable column on
-- "RefreshToken". No existing row is rewritten.

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN "mfaId" UUID;

-- CreateTable
CREATE TABLE "UserMfa" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "secretCiphertext" BYTEA NOT NULL,
    "secretIv" BYTEA NOT NULL,
    "secretTag" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "lastUsedStep" BIGINT NOT NULL DEFAULT -1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMfa_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserMfa_keyVersion_check" CHECK ("keyVersion" >= 1),
    CONSTRAINT "UserMfa_lastUsedStep_check" CHECK ("lastUsedStep" >= -1)
);

-- CreateTable
CREATE TABLE "UserMfaRecoveryCode" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserMfaRecoveryCode_pkey" PRIMARY KEY ("id"),
    -- Only an argon2id hash is ever stored, never the plain code.
    CONSTRAINT "UserMfaRecoveryCode_codeHash_argon2id_check" CHECK ("codeHash" LIKE '$argon2id$%')
);

-- CreateIndex
CREATE UNIQUE INDEX "UserMfa_userId_key" ON "UserMfa"("userId");
CREATE INDEX "UserMfa_companyId_idx" ON "UserMfa"("companyId");
CREATE INDEX "UserMfaRecoveryCode_userId_usedAt_idx" ON "UserMfaRecoveryCode"("userId", "usedAt");
CREATE INDEX "UserMfaRecoveryCode_companyId_idx" ON "UserMfaRecoveryCode"("companyId");
CREATE INDEX "RefreshToken_mfaId_idx" ON "RefreshToken"("mfaId");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_mfaId_fkey" FOREIGN KEY ("mfaId") REFERENCES "UserMfa"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserMfa" ADD CONSTRAINT "UserMfa_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserMfa" ADD CONSTRAINT "UserMfa_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserMfaRecoveryCode" ADD CONSTRAINT "UserMfaRecoveryCode_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserMfaRecoveryCode" ADD CONSTRAINT "UserMfaRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (§10.4 / SEC-001..005) — same direct-companyId policy
-- pattern as the other tenant-root tables.
ALTER TABLE "UserMfa" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserMfa" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "UserMfa"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "UserMfaRecoveryCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserMfaRecoveryCode" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "UserMfaRecoveryCode"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

-- Cross-tenant FK guards (20260808120000_tenant_scoped_keys_and_fk_guards):
-- the stored userId must belong to the row's own company.
CREATE TRIGGER usermfa_user_same_company
  BEFORE INSERT OR UPDATE ON "UserMfa"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'userId');

CREATE TRIGGER usermfarecoverycode_user_same_company
  BEFORE INSERT OR UPDATE ON "UserMfaRecoveryCode"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'userId');

-- "RefreshToken" has no companyId (parent-subquery policy via User), so the
-- generic guard does not fit: a session may only point at the SAME user's
-- CONFIRMED UserMfa. Fires only when mfaId is set/changed, so revoking or
-- rotating an existing token is never blocked; ON DELETE SET NULL writes NULL
-- and passes.
CREATE OR REPLACE FUNCTION velto_assert_refresh_token_mfa_matches_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mfa_user      uuid;
  mfa_confirmed timestamp(3);
BEGIN
  IF NEW."mfaId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "userId", "confirmedAt" INTO mfa_user, mfa_confirmed
    FROM "UserMfa" WHERE "id" = NEW."mfaId";

  IF mfa_user IS NULL OR mfa_user IS DISTINCT FROM NEW."userId" OR mfa_confirmed IS NULL THEN
    RAISE EXCEPTION
      'RefreshToken.mfaId = % is not a confirmed MFA of user %', NEW."mfaId", NEW."userId"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER refreshtoken_mfa_same_user
  BEFORE INSERT OR UPDATE OF "mfaId", "userId" ON "RefreshToken"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_refresh_token_mfa_matches_user();

-- Runtime DML grants (same guarded pattern as 20261012170000_idempotency_record).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velto_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "UserMfa", "UserMfaRecoveryCode" TO velto_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velto_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "UserMfa", "UserMfaRecoveryCode" TO velto_system;
  END IF;
END
$$;
