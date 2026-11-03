-- PO decision (2026-11-02): at most one SALE invoice per SalesOrder, and a
-- committed SALE invoice's turnover date (= "createdAt", see analytics
-- report-sql.ts / export-1c) and money/identity columns are immutable.
-- Additive only: no data is modified. RLS / FORCE RLS on "Invoice" unchanged.

-- 1. Refuse to proceed (never auto-fix) if existing data already violates the rule.
--    velto_owner is NOBYPASSRLS and these tables are FORCE RLS, so without a tenant
--    GUC every pre-flight count would see 0 rows. RLS is switched off for the
--    read-only checks (steps 1 and 5a) and restored (ENABLE + FORCE) in the same
--    migration transaction - pattern of 20261013200000.
ALTER TABLE "Invoice"    DISABLE ROW LEVEL SECURITY;
ALTER TABLE "SalesOrder" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Customer"   DISABLE ROW LEVEL SECURITY;

DO $$
DECLARE dup_orders bigint;
BEGIN
  SELECT count(*) INTO dup_orders FROM (
    SELECT 1 FROM "Invoice"
    WHERE "kind" = 'SALE' AND "orderId" IS NOT NULL
    GROUP BY "companyId", "orderId" HAVING count(*) > 1
  ) d;
  IF dup_orders > 0 THEN
    RAISE EXCEPTION 'invoice_sale_order_integrity: % (companyId, orderId) pairs have more than one SALE invoice; resolve manually before migrating', dup_orders
      USING ERRCODE = '23505';
  END IF;
END $$;

-- 1b. Existing invoices must already satisfy the same-company rule enforced by the
--     step-5 triggers (those only fire on new writes). Never auto-fix.
DO $$
DECLARE bad_orders bigint; bad_customers bigint;
BEGIN
  SELECT count(*) INTO bad_orders FROM "Invoice" i
    JOIN "SalesOrder" o ON o."id" = i."orderId"
    WHERE o."companyId" IS DISTINCT FROM i."companyId";
  SELECT count(*) INTO bad_customers FROM "Invoice" i
    JOIN "Customer" c ON c."id" = i."customerId"
    WHERE c."companyId" IS DISTINCT FROM i."companyId";
  IF bad_orders > 0 OR bad_customers > 0 THEN
    RAISE EXCEPTION 'invoice_sale_order_integrity: % invoices reference an order and % reference a customer of another company; resolve manually before migrating', bad_orders, bad_customers
      USING ERRCODE = '23514';
  END IF;
END $$;

ALTER TABLE "Invoice"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invoice"    FORCE ROW LEVEL SECURITY;
ALTER TABLE "SalesOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SalesOrder" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Customer"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Customer"   FORCE ROW LEVEL SECURITY;

-- 2. One SALE invoice per order (no status predicate: a CANCELLED SALE invoice
--    still occupies the order). Prisma cannot express partial uniques; see the
--    comment on model Invoice in schema.prisma.
CREATE UNIQUE INDEX "Invoice_sale_orderId_key" ON "Invoice"("companyId", "orderId")
  WHERE "kind" = 'SALE' AND "orderId" IS NOT NULL;

-- 3. FK Invoice.orderId: SET NULL -> RESTRICT. Deleting an order that already
--    has an invoice would otherwise rewrite the SALE invoice's orderId (blocked
--    by the trigger below with a less precise error). The app only hard-deletes
--    SUBMITTED orders (no invoice yet) and offboarding never deletes rows.
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_orderId_fkey";
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_orderId_fkey" FOREIGN KEY ("orderId")
  REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. SALE invoices may only change status (and the Prisma-managed updatedAt).
--    Separate from velto_invoice_opening_guard (which stays untouched and still
--    guards kind/openingBatchId/externalDocRef for every kind). Applies to every
--    role, including velto_system (BYPASSRLS) and the schema owner.
CREATE FUNCTION velto_invoice_sale_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."kind" = 'SALE' AND
     (NEW."id", NEW."companyId", NEW."number", NEW."customerId", NEW."orderId", NEW."total", NEW."kind", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."number", OLD."customerId", OLD."orderId", OLD."total", OLD."kind", OLD."createdAt") THEN
    RAISE EXCEPTION 'Invoice %: a SALE invoice may only change status (companyId/number/customerId/orderId/total/kind/createdAt are immutable)', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_sale_guard
  BEFORE UPDATE ON "Invoice"
  FOR EACH ROW EXECUTE FUNCTION velto_invoice_sale_guard();

-- 5. Cross-tenant FK guards for Invoice.orderId / Invoice.customerId (a plain FK
--    check bypasses RLS, so without these an invoice of company B could point at
--    company A's order/customer). Same helper as the SalesOrder guards
--    (20260808120000). Pre-existing rows are verified by step 1b.
CREATE TRIGGER invoice_order_same_company
  BEFORE INSERT OR UPDATE ON "Invoice"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('SalesOrder', 'orderId');

CREATE TRIGGER invoice_customer_same_company
  BEFORE INSERT OR UPDATE ON "Invoice"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Customer', 'customerId');
