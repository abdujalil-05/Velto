-- Supplier Telegram integration + pickup location (M09 purchases, 5.3
-- "In-app + Telegram"); tenant isolation per VELTO-TZ.md 6.10 / SEC-001..005.
--
-- Strictly additive: one new table, three new nullable columns on "Supplier".
-- No column is dropped, no NOT NULL is relaxed, no existing row can become
-- invalid.
--
-- Suppliers are external counterparties, not "User" rows, so their Telegram id
-- deliberately does NOT go on "User"."telegramId" — that column is what the
-- login path (auth.service.ts) resolves an account against, and a supplier
-- contact must never be resolvable as a tenant user. A separate 1:1 side table
-- keeps the two lookups disjoint.

-- ---------------------------------------------------------------------------
-- 1. Supplier pickup location
-- ---------------------------------------------------------------------------

ALTER TABLE "Supplier" ADD COLUMN "pickupAddress" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "pickupLatitude" DECIMAL(10,7);
ALTER TABLE "Supplier" ADD COLUMN "pickupLongitude" DECIMAL(10,7);

-- ---------------------------------------------------------------------------
-- 2. SupplierTelegramLink
-- ---------------------------------------------------------------------------

CREATE TABLE "SupplierTelegramLink" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "supplierId" UUID NOT NULL,
  "telegramId" BIGINT NOT NULL,
  "username" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupplierTelegramLink_pkey" PRIMARY KEY ("id")
);

-- One Telegram account per supplier.
CREATE UNIQUE INDEX "SupplierTelegramLink_supplierId_key"
  ON "SupplierTelegramLink"("supplierId");

-- Per-company, NOT global: a global unique on telegramId is a cross-tenant
-- constraint, so tenant A's write could collide with — and thereby probe the
-- existence of — a row in tenant B. Same reasoning as
-- "User_companyId_telegramId_key" (20260808120000).
CREATE UNIQUE INDEX "SupplierTelegramLink_companyId_telegramId_key"
  ON "SupplierTelegramLink"("companyId", "telegramId");

CREATE INDEX "SupplierTelegramLink_companyId_idx"
  ON "SupplierTelegramLink"("companyId");

ALTER TABLE "SupplierTelegramLink"
  ADD CONSTRAINT "SupplierTelegramLink_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SupplierTelegramLink"
  ADD CONSTRAINT "SupplierTelegramLink_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. RLS — direct companyId column, with FORCE so the owning app role is not
--    exempt. If `app.current_company_id` was never set, current_setting(...,
--    true) is NULL, the policy is false, and access fails closed.
-- ---------------------------------------------------------------------------

ALTER TABLE "SupplierTelegramLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierTelegramLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SupplierTelegramLink"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- 4. Cross-tenant FK guard (20260808120000 pattern)
--
-- The FK above only proves the Supplier id exists — nothing in it stops a link
-- row in company A from pointing at a Supplier in company B, and RLS does not
-- catch it either because the row being written carries the correct companyId.
-- The trigger fires for every writer, including BYPASSRLS `velto_system`.
-- ---------------------------------------------------------------------------

CREATE TRIGGER suppliertelegramlink_supplier_same_company
  BEFORE INSERT OR UPDATE ON "SupplierTelegramLink"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Supplier', 'supplierId');

-- Existing gap closed while we are here: PurchaseOrder.supplierId had no such
-- guard, so a purchase order in company A could reference company B's supplier.
-- Additive and consistent with the salesorder_* triggers.
CREATE TRIGGER purchaseorder_supplier_same_company
  BEFORE INSERT OR UPDATE ON "PurchaseOrder"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Supplier', 'supplierId');
