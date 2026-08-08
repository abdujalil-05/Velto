-- Tenant isolation at the database level (VELTO-TZ.md 6.10 / SEC-001..005).
--
-- Every request must run `SET LOCAL app.current_company_id = '<uuid>'`
-- before touching tenant data (done by the Prisma Client Extension in
-- packages/database/src/tenant-context.ts). If that setting was never made,
-- `current_setting(..., true)` returns NULL and every policy below evaluates
-- to false — access fails closed, not open.
--
-- FORCE ROW LEVEL SECURITY is required on every table: by default Postgres
-- exempts the table owner from RLS, and the application connects as the
-- owning role, so without FORCE the policies below would be silently
-- bypassed for all app traffic.

-- ---------------------------------------------------------------------------
-- Tables with a direct companyId column
-- ---------------------------------------------------------------------------

ALTER TABLE "Company" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Company" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Company"
  USING (id = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "User"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "Role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Role" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Role"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "Customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Customer" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Customer"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "Outlet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Outlet" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Outlet"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "ProductCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductCategory" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ProductCategory"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "Product" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Product" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Product"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "PriceList" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PriceList" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PriceList"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "Warehouse" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Warehouse" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Warehouse"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "StockMovement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockMovement" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "StockMovement"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "SalesOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SalesOrder" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SalesOrder"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "Invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invoice" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Invoice"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "Payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Payment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Payment"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "CashSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CashSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CashSession"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "Route" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Route" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Route"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "Visit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Visit" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Visit"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "Supplier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Supplier" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Supplier"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "PurchaseOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseOrder" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PurchaseOrder"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuditLog"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "OutboxEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutboxEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OutboxEvent"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "ImportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImportJob" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ImportJob"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- Child / join tables without their own companyId column — scoped via the
-- parent row's companyId through a subquery, instead of denormalizing a
-- companyId column that isn't part of the domain schema (section 6).
-- ---------------------------------------------------------------------------

ALTER TABLE "RefreshToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RefreshToken" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RefreshToken"
  USING (EXISTS (
    SELECT 1 FROM "User" u
    WHERE u.id = "RefreshToken"."userId"
      AND u."companyId" = current_setting('app.current_company_id', true)::uuid
  ));

ALTER TABLE "RolePermission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RolePermission" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RolePermission"
  USING (EXISTS (
    SELECT 1 FROM "Role" r
    WHERE r.id = "RolePermission"."roleId"
      AND r."companyId" = current_setting('app.current_company_id', true)::uuid
  ));

ALTER TABLE "UserRole" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserRole" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "UserRole"
  USING (EXISTS (
    SELECT 1 FROM "User" u
    WHERE u.id = "UserRole"."userId"
      AND u."companyId" = current_setting('app.current_company_id', true)::uuid
  ));

ALTER TABLE "ProductPackaging" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductPackaging" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ProductPackaging"
  USING (EXISTS (
    SELECT 1 FROM "Product" p
    WHERE p.id = "ProductPackaging"."productId"
      AND p."companyId" = current_setting('app.current_company_id', true)::uuid
  ));

ALTER TABLE "PriceListItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PriceListItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PriceListItem"
  USING (EXISTS (
    SELECT 1 FROM "PriceList" pl
    WHERE pl.id = "PriceListItem"."priceListId"
      AND pl."companyId" = current_setting('app.current_company_id', true)::uuid
  ));

ALTER TABLE "StockLevel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockLevel" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "StockLevel"
  USING (EXISTS (
    SELECT 1 FROM "Warehouse" w
    WHERE w.id = "StockLevel"."warehouseId"
      AND w."companyId" = current_setting('app.current_company_id', true)::uuid
  ));

ALTER TABLE "SalesOrderLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SalesOrderLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SalesOrderLine"
  USING (EXISTS (
    SELECT 1 FROM "SalesOrder" so
    WHERE so.id = "SalesOrderLine"."orderId"
      AND so."companyId" = current_setting('app.current_company_id', true)::uuid
  ));

ALTER TABLE "InvoiceLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InvoiceLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "InvoiceLine"
  USING (EXISTS (
    SELECT 1 FROM "Invoice" i
    WHERE i.id = "InvoiceLine"."invoiceId"
      AND i."companyId" = current_setting('app.current_company_id', true)::uuid
  ));

ALTER TABLE "PaymentAllocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentAllocation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PaymentAllocation"
  USING (EXISTS (
    SELECT 1 FROM "Payment" pay
    WHERE pay.id = "PaymentAllocation"."paymentId"
      AND pay."companyId" = current_setting('app.current_company_id', true)::uuid
  ));

ALTER TABLE "RouteStop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RouteStop" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RouteStop"
  USING (EXISTS (
    SELECT 1 FROM "Route" r
    WHERE r.id = "RouteStop"."routeId"
      AND r."companyId" = current_setting('app.current_company_id', true)::uuid
  ));

ALTER TABLE "PurchaseOrderLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseOrderLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PurchaseOrderLine"
  USING (EXISTS (
    SELECT 1 FROM "PurchaseOrder" po
    WHERE po.id = "PurchaseOrderLine"."purchaseOrderId"
      AND po."companyId" = current_setting('app.current_company_id', true)::uuid
  ));

-- ---------------------------------------------------------------------------
-- AuditLog is append-only (6.9 / SEC-050..054): no UPDATE, no DELETE, even
-- for the owning role. Enforced in the database, not just the app layer.
-- ---------------------------------------------------------------------------

CREATE FUNCTION prevent_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
