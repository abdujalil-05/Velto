-- One-time codes for linking a supplier's Telegram account (M09 purchases,
-- 5.3 "In-app + Telegram"); tenant isolation per VELTO-TZ.md 6.10 / SEC-001..005.
--
-- Strictly additive: one new table. No column, constraint or row on any
-- existing table is dropped, narrowed or rewritten, so no stored row can
-- become invalid.
--
-- Background: "SupplierTelegramLink" (20260809120000) has been READ by
-- sales.service.ts and notifications.service.ts since it shipped, but nothing
-- ever WROTE it — there was no flow to link a supplier's Telegram account at
-- all. This table is that missing flow's state:
--
--   admin generates a code in the web UI
--     -> supplier sends `/start <code>` to the bot
--     -> webhook redeems the code and creates the "SupplierTelegramLink"
--
-- Suppliers are external counterparties, never "User" rows (see the comment on
-- 20260809120000), so this deliberately does not reuse the existing
-- phone-contact linking path, which links "User"."telegramId".

-- ---------------------------------------------------------------------------
-- 1. SupplierTelegramLinkCode
-- ---------------------------------------------------------------------------

CREATE TABLE "SupplierTelegramLinkCode" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "supplierId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupplierTelegramLinkCode_pkey" PRIMARY KEY ("id")
);

-- GLOBALLY unique, deliberately NOT ("companyId", "code").
--
-- The Telegram webhook resolves this code BEFORE any companyId is known: an
-- incoming update carries only a chat id and the text of `/start <code>`,
-- so there is no tenant to scope the lookup to. Exactly the same cross-tenant
-- constraint as the phone lookup at login (auth.service.ts, TZ 15.2), and it
-- must be served the same way — read it through `velto_system` (BYPASSRLS),
-- then switch to `withTenant(row."companyId", ...)` for the redemption write.
--
-- This is the one place a global unique is acceptable despite the existence-
-- probing argument documented on "User_companyId_telegramId_key"
-- (20260808120000): "telegramId"/"phone" are attacker-supplied natural keys,
-- whereas "code" is a high-entropy, short-lived, single-use secret that we
-- generate. There is nothing to guess and the row is dead after "expiresAt".
-- The generator must therefore stay CSPRNG-based — a guessable code would turn
-- this index into a cross-tenant existence oracle.
CREATE UNIQUE INDEX "SupplierTelegramLinkCode_code_key"
  ON "SupplierTelegramLinkCode"("code");

CREATE INDEX "SupplierTelegramLinkCode_companyId_supplierId_idx"
  ON "SupplierTelegramLinkCode"("companyId", "supplierId");

-- Unindexed FK columns force seq scans under RLS and make parent
-- deletes/updates lock-heavy (same reasoning as 20260808120000 section 2).
CREATE INDEX "SupplierTelegramLinkCode_createdById_idx"
  ON "SupplierTelegramLinkCode"("createdById");

ALTER TABLE "SupplierTelegramLinkCode"
  ADD CONSTRAINT "SupplierTelegramLinkCode_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CASCADE, unlike every other Supplier FK in the schema (PurchaseOrder, Route,
-- SupplierRoute, SupplierTelegramLink are all RESTRICT). Those guard real
-- business documents that must never vanish silently; a pending link code is
-- worthless once its supplier is gone, and leaving it behind would keep a
-- redeemable secret alive with no supplier to attach the resulting link to.
ALTER TABLE "SupplierTelegramLinkCode"
  ADD CONSTRAINT "SupplierTelegramLinkCode_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupplierTelegramLinkCode"
  ADD CONSTRAINT "SupplierTelegramLinkCode_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. RLS — direct companyId column, with FORCE so the owning app role is not
--    exempt. If `app.current_company_id` was never set, current_setting(...,
--    true) is NULL, the policy evaluates false, and access fails closed.
--
--    Note this is what makes the global unique on "code" safe to *store*
--    without also making it readable: only `velto_system` can resolve a code
--    without a company context, which is precisely the webhook's one job.
-- ---------------------------------------------------------------------------

ALTER TABLE "SupplierTelegramLinkCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierTelegramLinkCode" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SupplierTelegramLinkCode"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- 3. Cross-tenant FK guards (20260808120000 /
--    `salesorder_supplier_same_company` pattern)
--
-- The FKs above only prove the target ids exist — nothing in them stops a code
-- row in company A from pointing at company B's Supplier or User, and RLS does
-- not catch it either because the row being written carries the correct
-- companyId. Both triggers fire for every writer, including BYPASSRLS
-- `velto_system` — which matters more here than usual, since the webhook path
-- is BYPASSRLS by design.
-- ---------------------------------------------------------------------------

CREATE TRIGGER suppliertelegramlinkcode_supplier_same_company
  BEFORE INSERT OR UPDATE ON "SupplierTelegramLinkCode"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Supplier', 'supplierId');

CREATE TRIGGER suppliertelegramlinkcode_createdby_same_company
  BEFORE INSERT OR UPDATE ON "SupplierTelegramLinkCode"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'createdById');
