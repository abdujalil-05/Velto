-- Suppliers ("yetkazib beruvchi") are removed entirely and replaced by
-- COURIERS ("kuryer"): the company's own delivery people, who take a finished
-- SalesOrder from the warehouse to the customer.
--
-- A courier is an ordinary "User" row carrying the new fixed system role
-- COURIER (see src/rbac-catalog.ts) — deliberately NOT a new entity, so
-- couriers reuse the existing agent Telegram login (User.telegramId,
-- POST /auth/telegram, Mini App) with no new auth code, and inherit "User"'s
-- existing tenant_isolation RLS policy unchanged.
--
-- This migration therefore:
--   1. clears/removes the demo rows that could not survive the swap,
--   2. re-points "SalesOrder"."supplierId" and "Route"."supplierId" at "User"
--      as "courierId" (FKs, indexes, CHECK and cross-tenant guard triggers
--      renamed with them),
--   3. drops the whole purchases/supplier table group together with its RLS
--      policies, triggers, indexes and the PurchaseOrderStatus enum.
--
-- No new tenant-scoped table is introduced: every surviving table keeps the
-- direct-companyId `tenant_isolation` policy (with FORCE) from
-- 20260730161500_rls_and_audit_lock. Policies are per *table*, not per column,
-- so a renamed column stays covered by the existing USING/WITH CHECK
-- expression. "AuditLog" is not touched anywhere below — it is append-only and
-- trigger-locked, and history that mentions a deleted supplier stays as it is.

-- ---------------------------------------------------------------------------
-- 1. Data steps (demo/seed data only — this is a pre-production MVP with no
--    real tenants; both statements below are no-ops on a fresh database)
--
--    RLS has to come off around them for exactly the reason documented in
--    20260806090000: migrations run as `velto`, not the BYPASSRLS
--    `velto_system` role, with no app.current_company_id set, so under FORCE
--    RLS the tenant_isolation policy would silently match zero rows in every
--    tenant and leave the rows behind to break the DDL below.
--
--    The cross-tenant FK guard triggers (20260808120000) have to come off for
--    the same reason, and this one is not optional: they fire BEFORE UPDATE on
--    every column, and their parent lookup ("SELECT companyId FROM Customer
--    WHERE id = ...") is itself subject to the parent table's RLS. With no
--    company context that lookup returns no row, so the trigger reads a
--    perfectly valid row as a cross-tenant reference and aborts the migration.
--    DISABLE TRIGGER USER leaves the internal FK/constraint triggers active.
-- ---------------------------------------------------------------------------

-- 1a. Orders keep their history but lose their deliverer: the FK is about to
--     point at "User" instead of "Supplier", so any stored supplier id would
--     be a dangling reference to a user that does not exist. Nulling is safe —
--     the column is nullable by design ("not dispatched yet" is a real state)
--     and no other column derives from it.
ALTER TABLE "SalesOrder" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "SalesOrder" DISABLE TRIGGER USER;
UPDATE "SalesOrder" SET "supplierId" = NULL WHERE "supplierId" IS NOT NULL;
ALTER TABLE "SalesOrder" ENABLE TRIGGER USER;
ALTER TABLE "SalesOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SalesOrder" FORCE ROW LEVEL SECURITY;

-- 1b. Supplier-served routes cannot merely be nulled: "Route" carries an
--     agent-XOR-deliverer CHECK, so a row with supplierId set and agentId NULL
--     has no valid post-migration shape (there is no courier to reassign it to
--     yet). Those routes are deleted, children first — RouteStop/RouteRun are
--     both ON DELETE RESTRICT. Agent-served routes (agentId NOT NULL) are
--     untouched, which is every route the seed creates.
ALTER TABLE "RouteStop" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "RouteRun" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Route" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Route" DISABLE TRIGGER USER;

DELETE FROM "RouteStop" WHERE "routeId" IN (
  SELECT "id" FROM "Route" WHERE "supplierId" IS NOT NULL AND "agentId" IS NULL
);
DELETE FROM "RouteRun" WHERE "routeId" IN (
  SELECT "id" FROM "Route" WHERE "supplierId" IS NOT NULL AND "agentId" IS NULL
);
DELETE FROM "Route" WHERE "supplierId" IS NOT NULL AND "agentId" IS NULL;

-- Any remaining route with a supplierId also has an agentId (it would have
-- violated the XOR otherwise), so it survives as a plain agent route.
UPDATE "Route" SET "supplierId" = NULL WHERE "supplierId" IS NOT NULL;

ALTER TABLE "Route" ENABLE TRIGGER USER;
ALTER TABLE "RouteStop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RouteStop" FORCE ROW LEVEL SECURITY;
ALTER TABLE "RouteRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RouteRun" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Route" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Route" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. Drop the Supplier-facing guards on the tables that survive
--
--    DROP TABLE would take the FK constraints with it, but NOT these triggers:
--    they name their parent table as a text argument to a shared function, so
--    they would survive the drop and fail at runtime on the first write.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS salesorder_supplier_same_company ON "SalesOrder";
DROP TRIGGER IF EXISTS route_supplier_same_company ON "Route";

-- ---------------------------------------------------------------------------
-- 3. supplierId -> courierId
--
--    RENAME COLUMN rather than drop+add: it keeps the column's position and
--    (after 1a/1b) its values, and is a catalog-only operation with no table
--    rewrite. Indexes are renamed for the same reason — Prisma identifies them
--    by name, so the name has to match the new schema or `migrate dev` would
--    propose dropping and recreating them on the next run.
-- ---------------------------------------------------------------------------

-- 3a. SalesOrder
ALTER TABLE "SalesOrder" DROP CONSTRAINT "SalesOrder_supplierId_fkey";
ALTER TABLE "SalesOrder" RENAME COLUMN "supplierId" TO "courierId";
ALTER INDEX "SalesOrder_companyId_supplierId_idx" RENAME TO "SalesOrder_companyId_courierId_idx";

-- ON DELETE SET NULL: an order is history and must survive its courier's user
-- row being removed. Deleting a user must never cascade into sales documents.
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_courierId_fkey"
  FOREIGN KEY ("courierId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3b. Route
ALTER TABLE "Route" DROP CONSTRAINT "Route_supplierId_fkey";
ALTER TABLE "Route" DROP CONSTRAINT "Route_agent_xor_supplier_check";
ALTER TABLE "Route" RENAME COLUMN "supplierId" TO "courierId";
ALTER INDEX "Route_companyId_supplierId_idx" RENAME TO "Route_companyId_courierId_idx";

-- ON DELETE RESTRICT, unlike SalesOrder above: SET NULL would leave a served
-- route with neither owner and violate the XOR below. Same reasoning (and the
-- same choice) as the Supplier FK it replaces — reassign the route before
-- deactivating the courier. "Route"."agentId" is already RESTRICT.
ALTER TABLE "Route" ADD CONSTRAINT "Route_courierId_fkey"
  FOREIGN KEY ("courierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Unchanged semantics, renamed constraint: a route is served either by an own
-- field agent or by a courier, never both and never neither.
-- `(a IS NULL) <> (b IS NULL)` is the XOR — it can never evaluate to UNKNOWN,
-- because IS NULL always yields true/false.
ALTER TABLE "Route" ADD CONSTRAINT "Route_agent_xor_courier_check"
  CHECK (("agentId" IS NULL) <> ("courierId" IS NULL));

-- 3c. Cross-tenant FK guards, re-pointed at "User" (20260808120000 pattern).
--     The FKs above only prove the target id exists; nothing in them stops
--     company A's order/route from naming company B's user as its courier, and
--     RLS does not catch it either because the row being written carries the
--     correct companyId. These fire for every writer including BYPASSRLS
--     `velto_system`, and return early when the column is NULL.
CREATE TRIGGER salesorder_courier_same_company
  BEFORE INSERT OR UPDATE ON "SalesOrder"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'courierId');

CREATE TRIGGER route_courier_same_company
  BEFORE INSERT OR UPDATE ON "Route"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'courierId');

-- ---------------------------------------------------------------------------
-- 4. Drop the supplier / purchase-order table group
--
--    DROP TABLE takes each table's RLS policies (`tenant_isolation`, created
--    with FORCE in 20260730161500 / 20260809120000 / 20260809140000 /
--    20260810150000), its own BEFORE INSERT OR UPDATE guard triggers, its
--    indexes, CHECKs and FKs with it — they are all dependent objects of the
--    table. Child tables first so no RESTRICT FK blocks the drop; no CASCADE
--    anywhere, so an unexpected dependency fails loudly instead of being
--    silently dropped along with the table.
-- ---------------------------------------------------------------------------

DROP TABLE "SupplierTelegramLinkCode";
DROP TABLE "SupplierTelegramLink";
DROP TABLE "SupplierRouteStop";
DROP TABLE "SupplierRoute";
DROP TABLE "PurchaseOrderLine";
DROP TABLE "PurchaseOrder";
DROP TABLE "Supplier";

-- Only PurchaseOrder used it.
DROP TYPE "PurchaseOrderStatus";
