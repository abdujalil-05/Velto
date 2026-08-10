-- Supplier pickup routes (M09 purchases). Tenant isolation per
-- VELTO-TZ.md 6.10 / SEC-001..005; RLS shape follows
-- 20260730161500_rls_and_audit_lock, FK guards follow 20260808120000.
--
-- Strictly additive: two new tables. Nothing on "Route"/"RouteStop"/"RouteRun"
-- is touched — no column, index, policy or trigger of theirs is altered — so
-- every existing reader (routes service, miniapp sync, 9.4 route-finish rule)
-- keeps returning exactly the rows it returned before this migration.
--
-- Why separate tables instead of a discriminator column on "Route": "Route" is
-- outbound field-agent work, keyed on a NOT NULL "agentId" with "RouteStop"
-- rows that join a real "Outlet". A supplier pickup has neither. Folding it in
-- would require making "agentId"/"outletId" nullable (weakening the invariant
-- existing readers rely on) or would make those readers start seeing pickup
-- rows. Independent tables avoid both.

-- ---------------------------------------------------------------------------
-- 1. SupplierRoute
-- ---------------------------------------------------------------------------

CREATE TABLE "SupplierRoute" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "supplierId" UUID NOT NULL,
  -- ISO-8601 weekday, 1 = Monday .. 7 = Sunday (same encoding as Route.weekday).
  "weekday" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupplierRoute_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierRoute_companyId_supplierId_idx"
  ON "SupplierRoute"("companyId", "supplierId");

CREATE INDEX "SupplierRoute_companyId_weekday_idx"
  ON "SupplierRoute"("companyId", "weekday");

ALTER TABLE "SupplierRoute"
  ADD CONSTRAINT "SupplierRoute_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SupplierRoute"
  ADD CONSTRAINT "SupplierRoute_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SupplierRoute"
  ADD CONSTRAINT "SupplierRoute_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7);

-- ---------------------------------------------------------------------------
-- 2. SupplierRouteStop
-- ---------------------------------------------------------------------------

CREATE TABLE "SupplierRouteStop" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "routeId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "pickupAddress" TEXT NOT NULL,
  -- DECIMAL(10,7), never DOUBLE PRECISION: same shape as Visit.latitude and
  -- Supplier.pickupLatitude so the existing GPS-radius helpers apply unchanged.
  -- Nullable because an address-only pickup point is valid.
  "latitude" DECIMAL(10,7),
  "longitude" DECIMAL(10,7),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupplierRouteStop_pkey" PRIMARY KEY ("id")
);

-- Scoped to the parent route, which is itself company-scoped, so this unique
-- index cannot collide across tenants.
CREATE UNIQUE INDEX "SupplierRouteStop_routeId_sequence_key"
  ON "SupplierRouteStop"("routeId", "sequence");

CREATE INDEX "SupplierRouteStop_companyId_routeId_idx"
  ON "SupplierRouteStop"("companyId", "routeId");

CREATE INDEX "SupplierRouteStop_companyId_latitude_longitude_idx"
  ON "SupplierRouteStop"("companyId", "latitude", "longitude");

ALTER TABLE "SupplierRouteStop"
  ADD CONSTRAINT "SupplierRouteStop_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SupplierRouteStop"
  ADD CONSTRAINT "SupplierRouteStop_routeId_fkey"
  FOREIGN KEY ("routeId") REFERENCES "SupplierRoute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SupplierRouteStop"
  ADD CONSTRAINT "SupplierRouteStop_sequence_check" CHECK ("sequence" >= 1);

-- ---------------------------------------------------------------------------
-- 3. RLS — direct companyId column on both tables, with FORCE so the owning
--    app role is not exempt either. If `app.current_company_id` was never set,
--    current_setting(..., true) is NULL, the policy evaluates false, and access
--    fails closed with zero rows.
-- ---------------------------------------------------------------------------

ALTER TABLE "SupplierRoute" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierRoute" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SupplierRoute"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "SupplierRouteStop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierRouteStop" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SupplierRouteStop"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- 4. Cross-tenant FK guards (20260808120000 pattern)
--
-- The FKs above only prove the target id exists. Nothing in them stops a
-- SupplierRoute in company A from pointing at company B's Supplier, and RLS
-- does not catch it either because the row being written carries the correct
-- companyId. These triggers fire for every writer, including BYPASSRLS
-- `velto_system`.
-- ---------------------------------------------------------------------------

CREATE TRIGGER supplierroute_supplier_same_company
  BEFORE INSERT OR UPDATE ON "SupplierRoute"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Supplier', 'supplierId');

CREATE TRIGGER supplierroutestop_route_same_company
  BEFORE INSERT OR UPDATE ON "SupplierRouteStop"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('SupplierRoute', 'routeId');
