-- Tenant-scoping hardening (VELTO-TZ.md 6.10 / SEC-001..005).
--
-- This migration is strictly additive with respect to data: it only drops and
-- re-creates *indexes*, never a column, table or row. Every unique index that
-- is replaced is replaced by a strictly WIDER one (companyId prepended), which
-- relaxes the constraint — no existing row can become invalid.
--
-- Four things are fixed here:
--   1. Cross-tenant natural keys (User.telegramId, *.clientId) that were
--      globally unique, so tenant A's write could collide with — and thereby
--      probe the existence of — a row in tenant B.
--   2. "Tenant" was the last table in the schema without RLS.
--   3. ProductCategory root-level uniqueness was silently unenforced.
--   4. FK columns could point at another tenant's row: a plain FK only checks
--      that the target id exists, not that it belongs to the same company.

-- ---------------------------------------------------------------------------
-- 1. Cross-tenant unique keys -> per-company unique keys
-- ---------------------------------------------------------------------------

-- DropIndex
DROP INDEX "Payment_clientId_key";

-- DropIndex
DROP INDEX "SalesOrder_clientId_key";

-- DropIndex
DROP INDEX "User_telegramId_key";

-- DropIndex
DROP INDEX "Visit_clientId_key";

-- CreateIndex
CREATE UNIQUE INDEX "Payment_companyId_clientId_key" ON "Payment"("companyId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_companyId_clientId_key" ON "SalesOrder"("companyId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "User_companyId_telegramId_key" ON "User"("companyId", "telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "Visit_companyId_clientId_key" ON "Visit"("companyId", "clientId");

-- ---------------------------------------------------------------------------
-- 2. Missing indexes on tenant-scoped FK columns (unindexed FKs force seq
--    scans under RLS, and make parent deletes/updates lock-heavy).
-- ---------------------------------------------------------------------------

-- CreateIndex
CREATE INDEX "Customer_priceListId_idx" ON "Customer"("priceListId");

-- CreateIndex
CREATE INDEX "Invoice_companyId_customerId_idx" ON "Invoice"("companyId", "customerId");

-- CreateIndex
CREATE INDEX "Payment_companyId_customerId_idx" ON "Payment"("companyId", "customerId");

-- CreateIndex
CREATE INDEX "Payment_collectedBy_idx" ON "Payment"("collectedBy");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_companyId_warehouseId_idx" ON "PurchaseOrder"("companyId", "warehouseId");

-- CreateIndex
CREATE INDEX "RouteStop_outletId_idx" ON "RouteStop"("outletId");

-- CreateIndex
CREATE INDEX "SalesOrder_companyId_outletId_idx" ON "SalesOrder"("companyId", "outletId");

-- CreateIndex
CREATE INDEX "SalesOrder_companyId_warehouseId_idx" ON "SalesOrder"("companyId", "warehouseId");

-- ---------------------------------------------------------------------------
-- 3. ProductCategory: root categories were never actually unique
--
-- `@@unique([companyId, name, parentId])` compiles to a btree unique index,
-- and in a btree NULL is never equal to NULL — so two root categories
-- ("parentId" IS NULL) with the same companyId+name did not conflict. Same
-- filtered-index technique as *_soft_delete_partial_unique; Prisma's schema
-- DSL cannot express `WHERE`.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "ProductCategory_companyId_name_root_key"
  ON "ProductCategory" ("companyId", "name")
  WHERE "parentId" IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Tenant: the last table without RLS
--
-- A Tenant row is reachable from the app role only through the company the
-- current request is scoped to. The legitimately cross-tenant paths (phone /
-- telegram lookup at login, platform-admin provisioning in bootstrap-owner.ts
-- and seed.ts, cross-tenant background jobs) all go through `systemPrisma`,
-- whose role is BYPASSRLS, so they are unaffected.
--
-- The subquery reads "Company", which itself has RLS restricting it to the
-- current company — consistent, and non-recursive (Company's policy does not
-- reference Tenant).
-- ---------------------------------------------------------------------------

ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Tenant" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Tenant"
  USING (id IN (
    SELECT "tenantId" FROM "Company"
    WHERE id = current_setting('app.current_company_id', true)::uuid
  ));

-- ---------------------------------------------------------------------------
-- 5. Cross-tenant foreign keys
--
-- Postgres FKs only prove the target id exists — nothing stops a SalesOrder in
-- company A from referencing a Customer in company B. RLS does not catch this
-- either: the write itself passes the policy because the *row being written*
-- carries the right companyId.
--
-- The textbook fix is a composite FK against `UNIQUE (companyId, id)` on the
-- parent. That is not usable here: Prisma cannot model a second, redundant FK
-- on the same column, so `prisma migrate dev` would propose dropping it on
-- every subsequent run (the same drift trap noted on Customer's pg_trgm
-- index). Converting the *existing* relations to composite FKs instead would
-- change the generated client's relation shape across apps/api — out of scope
-- for an additive migration, and it would require a column rewrite.
--
-- Triggers are used instead: invisible to `prisma migrate diff` (so no drift),
-- enforced for every writer including `velto_system`, and additive. Same
-- mechanism already used for the AuditLog append-only lock.
--
-- Note the parent lookups below are themselves subject to RLS. Under
-- `withTenant`, a reference to another tenant's parent simply returns no row,
-- so the check fails closed even before the companyId comparison.
-- ---------------------------------------------------------------------------

-- Child row carries its own companyId; it must equal the parent's.
CREATE OR REPLACE FUNCTION velto_assert_child_company_matches_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_table   text := TG_ARGV[0];
  fk_column      text := TG_ARGV[1];
  fk_value       uuid;
  child_company  uuid;
  parent_company uuid;
BEGIN
  fk_value := (to_jsonb(NEW) ->> fk_column)::uuid;
  IF fk_value IS NULL THEN
    RETURN NEW;
  END IF;

  child_company := (to_jsonb(NEW) ->> 'companyId')::uuid;

  EXECUTE format('SELECT "companyId" FROM %I WHERE "id" = $1', parent_table)
    INTO parent_company
    USING fk_value;

  IF parent_company IS NULL OR parent_company IS DISTINCT FROM child_company THEN
    RAISE EXCEPTION
      'cross-tenant reference: %.% = % is not visible in company %',
      TG_TABLE_NAME, fk_column, fk_value, child_company
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- Child row has no companyId of its own (line-item / join table); its two
-- parents must resolve to the same company.
CREATE OR REPLACE FUNCTION velto_assert_parents_same_company()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  a_table   text := TG_ARGV[0];
  a_column  text := TG_ARGV[1];
  b_table   text := TG_ARGV[2];
  b_column  text := TG_ARGV[3];
  a_value   uuid;
  b_value   uuid;
  a_company uuid;
  b_company uuid;
BEGIN
  a_value := (to_jsonb(NEW) ->> a_column)::uuid;
  b_value := (to_jsonb(NEW) ->> b_column)::uuid;
  IF a_value IS NULL OR b_value IS NULL THEN
    RETURN NEW;
  END IF;

  EXECUTE format('SELECT "companyId" FROM %I WHERE "id" = $1', a_table)
    INTO a_company USING a_value;
  EXECUTE format('SELECT "companyId" FROM %I WHERE "id" = $1', b_table)
    INTO b_company USING b_value;

  IF a_company IS NULL OR b_company IS NULL OR a_company IS DISTINCT FROM b_company THEN
    RAISE EXCEPTION
      'cross-tenant reference: %.% = % and %.% = % resolve to different companies',
      TG_TABLE_NAME, a_column, a_value, TG_TABLE_NAME, b_column, b_value
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER salesorder_customer_same_company
  BEFORE INSERT OR UPDATE ON "SalesOrder"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Customer', 'customerId');

CREATE TRIGGER salesorder_outlet_same_company
  BEFORE INSERT OR UPDATE ON "SalesOrder"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Outlet', 'outletId');

CREATE TRIGGER salesorder_warehouse_same_company
  BEFORE INSERT OR UPDATE ON "SalesOrder"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Warehouse', 'warehouseId');

CREATE TRIGGER stocklevel_product_warehouse_same_company
  BEFORE INSERT OR UPDATE ON "StockLevel"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_parents_same_company('Product', 'productId', 'Warehouse', 'warehouseId');

CREATE TRIGGER pricelistitem_pricelist_product_same_company
  BEFORE INSERT OR UPDATE ON "PriceListItem"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_parents_same_company('PriceList', 'priceListId', 'Product', 'productId');

CREATE TRIGGER routestop_route_outlet_same_company
  BEFORE INSERT OR UPDATE ON "RouteStop"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_parents_same_company('Route', 'routeId', 'Outlet', 'outletId');
