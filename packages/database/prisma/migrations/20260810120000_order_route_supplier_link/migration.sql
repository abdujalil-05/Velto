-- Supplier ("yetkazib beruvchi" = deliverer) links on SalesOrder and Route.
--
-- Strictly additive: two nullable columns, two indexes, two FKs, two guard
-- triggers. No column is dropped or narrowed, no existing row can become
-- invalid, and nothing already stored changes value — every existing reader
-- keeps returning exactly the rows it returned before this migration.
--
-- Deliberately NOT done here:
--   * "Route"."agentId" stays NOT NULL. A supplier-served route still carries
--     its owning agent, because RouteRun/Visit and the 9.4 route-finish
--     completion rule all assume every Route has an agent; making it nullable
--     would silently weaken those readers instead of extending them.
--   * No new RLS policy. "SalesOrder" and "Route" are already tenant-scoped by
--     the direct-companyId `tenant_isolation` policies created (with FORCE) in
--     20260730161500_rls_and_audit_lock, and a policy is per *table*, not per
--     column — a new column on an RLS-protected table is covered by the
--     existing USING/WITH CHECK expression the moment it exists. Adding a
--     second policy would be worse than useless: multiple permissive policies
--     on one table are OR-ed together, so it could only ever widen access.
--   * "AuditLog"'s append-only triggers are untouched.

-- ---------------------------------------------------------------------------
-- 1. Columns
--
-- Nullable, and nullable is the correct shape rather than a default: most
-- orders ship from an own warehouse and most routes are pure agent work, so
-- "no deliverer" is a real state, not a missing value.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN "supplierId" UUID;

-- AlterTable
ALTER TABLE "Route" ADD COLUMN "supplierId" UUID;

-- ---------------------------------------------------------------------------
-- 2. Indexes
--
-- companyId first, matching every other tenant-scoped index in the schema:
-- under RLS the companyId predicate is always present, so a supplierId-only
-- index would not be usable as a leading-column lookup. Unindexed FK columns
-- also make parent deletes lock-heavy — and both FKs below are ON DELETE SET
-- NULL, which rewrites every referencing child row.
-- ---------------------------------------------------------------------------

-- CreateIndex
CREATE INDEX "SalesOrder_companyId_supplierId_idx" ON "SalesOrder"("companyId", "supplierId");

-- CreateIndex
CREATE INDEX "Route_companyId_supplierId_idx" ON "Route"("companyId", "supplierId");

-- ---------------------------------------------------------------------------
-- 3. Foreign keys
--
-- ON DELETE SET NULL, not RESTRICT (which is what the other Supplier FKs use):
-- an order/route is history and must survive the deliverer record being
-- removed, and deleting a supplier must never cascade into deleting sales
-- documents. Supplier is soft-deleted (`deletedAt`) in normal operation
-- anyway, so this path is the exception, not the rule.
-- ---------------------------------------------------------------------------

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. Cross-tenant FK guards (20260808120000 pattern)
--
-- The FKs above only prove the target Supplier id exists. Nothing in them
-- stops company A's SalesOrder/Route from naming company B's supplier as its
-- deliverer, and RLS does not catch it either, because the row being written
-- carries the correct companyId. These BEFORE INSERT OR UPDATE triggers fire
-- for every writer including BYPASSRLS `velto_system`, and return early when
-- the column is NULL (so an unassigned order/route, and the SET NULL rewrite
-- performed by the FKs above, are both unaffected).
-- ---------------------------------------------------------------------------

CREATE TRIGGER salesorder_supplier_same_company
  BEFORE INSERT OR UPDATE ON "SalesOrder"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Supplier', 'supplierId');

CREATE TRIGGER route_supplier_same_company
  BEFORE INSERT OR UPDATE ON "Route"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Supplier', 'supplierId');
