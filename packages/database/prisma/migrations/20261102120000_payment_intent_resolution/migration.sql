-- PO decision (2026-11-02): durable server-side reconciliation decision for a
-- rejected offline payment intent (409 PAYMENT_IDEMPOTENCY_CONFLICT /
-- PAYMENT_IDEMPOTENCY_UNVERIFIABLE). Additive only: new enum + new table; no
-- existing table, row, policy or trigger is modified.
--
-- "Open" / REQUIRES_INVESTIGATION is the absence of a row. One decision per
-- (companyId, clientId); rows are append-only for every role.
-- paymentId is NOT NULL: these 409s only occur when Payment(companyId,
-- clientId) already exists (Payment_companyId_clientId_key), and the guard
-- below requires the referenced Payment to carry the same clientId and company.

-- CreateEnum
CREATE TYPE "PaymentReconciliationOutcome" AS ENUM ('EXISTING_PAYMENT_CONFIRMED', 'NOT_POSTED_CONFIRMED');

-- CreateTable
CREATE TABLE "PaymentIntentResolution" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "paymentId" UUID NOT NULL,
    "outcome" "PaymentReconciliationOutcome" NOT NULL,
    "reason" TEXT NOT NULL,
    "evidenceRef" TEXT,
    "actorId" UUID NOT NULL,
    "originalUserId" UUID NOT NULL,
    "rejectionAuditId" UUID,
    "traceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentIntentResolution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentIntentResolution_companyId_createdAt_idx" ON "PaymentIntentResolution"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentIntentResolution_paymentId_idx" ON "PaymentIntentResolution"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentIntentResolution_actorId_idx" ON "PaymentIntentResolution"("actorId");

-- CreateIndex
CREATE INDEX "PaymentIntentResolution_originalUserId_idx" ON "PaymentIntentResolution"("originalUserId");

-- CreateIndex
CREATE INDEX "PaymentIntentResolution_rejectionAuditId_idx" ON "PaymentIntentResolution"("rejectionAuditId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntentResolution_companyId_clientId_key" ON "PaymentIntentResolution"("companyId", "clientId");

-- AddForeignKey
ALTER TABLE "PaymentIntentResolution" ADD CONSTRAINT "PaymentIntentResolution_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntentResolution" ADD CONSTRAINT "PaymentIntentResolution_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntentResolution" ADD CONSTRAINT "PaymentIntentResolution_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntentResolution" ADD CONSTRAINT "PaymentIntentResolution_originalUserId_fkey" FOREIGN KEY ("originalUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntentResolution" ADD CONSTRAINT "PaymentIntentResolution_rejectionAuditId_fkey" FOREIGN KEY ("rejectionAuditId") REFERENCES "AuditLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Non-empty reason (evidenceRef for NOT_POSTED_CONFIRMED is service-enforced).
ALTER TABLE "PaymentIntentResolution" ADD CONSTRAINT "PaymentIntentResolution_reason_nonempty_check"
  CHECK (length(btrim("reason")) > 0);
ALTER TABLE "PaymentIntentResolution" ADD CONSTRAINT "PaymentIntentResolution_clientId_nonempty_check"
  CHECK (length(btrim("clientId")) > 0);

-- RLS (TZ §10.4 / SEC-001..005).
ALTER TABLE "PaymentIntentResolution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentIntentResolution" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PaymentIntentResolution"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

-- Cross-tenant FK guards (a plain FK check bypasses RLS). Same helper as
-- 20260808120000 / 20261102100000.
CREATE TRIGGER payment_intent_resolution_actor_same_company
  BEFORE INSERT ON "PaymentIntentResolution"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'actorId');
CREATE TRIGGER payment_intent_resolution_original_user_same_company
  BEFORE INSERT ON "PaymentIntentResolution"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'originalUserId');
CREATE TRIGGER payment_intent_resolution_audit_same_company
  BEFORE INSERT ON "PaymentIntentResolution"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('AuditLog', 'rejectionAuditId');

-- paymentId must be the same company's Payment AND carry this clientId.
-- Lookup runs as the invoking role, so under FORCE RLS another tenant's
-- Payment is invisible and also rejected.
CREATE FUNCTION velto_payment_intent_resolution_payment_guard() RETURNS trigger AS $$
DECLARE p_company uuid; p_client text;
BEGIN
  SELECT "companyId", "clientId" INTO p_company, p_client
    FROM "Payment" WHERE "id" = NEW."paymentId";
  IF p_company IS NULL OR p_company IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'cross-tenant reference: PaymentIntentResolution.paymentId = % is not visible in company %', NEW."paymentId", NEW."companyId"
      USING ERRCODE = '23514';
  END IF;
  IF p_client IS DISTINCT FROM NEW."clientId" THEN
    RAISE EXCEPTION 'PaymentIntentResolution: Payment % does not carry clientId %', NEW."paymentId", NEW."clientId"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_intent_resolution_payment_guard
  BEFORE INSERT ON "PaymentIntentResolution"
  FOR EACH ROW EXECUTE FUNCTION velto_payment_intent_resolution_payment_guard();

-- Append-only for every role, including velto_system and the owner
-- (pattern: AuditLog lock, 20260730161500 / 20260730224500).
CREATE FUNCTION velto_prevent_payment_intent_resolution_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PaymentIntentResolution is append-only: % is not allowed', TG_OP
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_intent_resolution_no_update
  BEFORE UPDATE ON "PaymentIntentResolution"
  FOR EACH ROW EXECUTE FUNCTION velto_prevent_payment_intent_resolution_mutation();
CREATE TRIGGER payment_intent_resolution_no_delete
  BEFORE DELETE ON "PaymentIntentResolution"
  FOR EACH ROW EXECUTE FUNCTION velto_prevent_payment_intent_resolution_mutation();
CREATE TRIGGER payment_intent_resolution_no_truncate
  BEFORE TRUNCATE ON "PaymentIntentResolution"
  FOR EACH STATEMENT EXECUTE FUNCTION velto_prevent_payment_intent_resolution_mutation();

-- Grants: none here. velto_app / velto_system receive DML on this table via
-- provision-roles.sql (ALTER DEFAULT PRIVILEGES FOR ROLE velto_owner), like
-- every other table; UPDATE/DELETE/TRUNCATE are blocked by the triggers above
-- for every role.
