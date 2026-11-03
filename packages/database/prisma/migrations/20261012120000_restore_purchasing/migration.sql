-- ADR-011: restore module M08 Purchasing (VELTO-TZ 5.1 M08, 6.2) that
-- 20260810170000_couriers_replace_suppliers dropped. Purely additive: five new
-- tables + one enum; no existing table, column, policy or row is touched, and
-- the COURIER feature (SalesOrder/Route "courierId", COURIER role) is left as
-- is. The old SupplierTelegramLink*/SupplierRoute* tables are NOT restored.
--
-- Every new table carries its own "companyId" (line tables included), so:
--   * RLS is the same direct-companyId `tenant_isolation` policy (+ FORCE) as
--     20260730161500_rls_and_audit_lock — fails closed without
--     app.current_company_id; USING doubles as WITH CHECK for writes;
--   * every FK is guarded against cross-tenant references by the existing
--     velto_assert_child_company_matches_parent() trigger function
--     (20260808120000_tenant_scoped_keys_and_fk_guards);
--   * GoodsReceipt/GoodsReceiptLine are append-only via triggers (see end).

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Supplier" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "inn" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "expectedAt" TIMESTAMP(3),
    "totalAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdById" UUID,
    "orderedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "purchaseOrderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "productName" TEXT NOT NULL,
    "productSku" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL,
    "qtyReceived" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "unitPrice" DECIMAL(18,2) NOT NULL,
    "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "purchaseOrderId" UUID,
    "supplierId" UUID,
    "receivedById" UUID,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptLine" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "goodsReceiptId" UUID NOT NULL,
    "purchaseOrderLineId" UUID,
    "productId" UUID NOT NULL,
    "productName" TEXT NOT NULL,
    "productSku" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL,
    "unitCost" DECIMAL(18,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Supplier_companyId_name_idx" ON "Supplier"("companyId", "name");

-- CreateIndex
CREATE INDEX "Supplier_companyId_inn_idx" ON "Supplier"("companyId", "inn");

-- CreateIndex
CREATE INDEX "PurchaseOrder_companyId_supplierId_idx" ON "PurchaseOrder"("companyId", "supplierId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_companyId_warehouseId_idx" ON "PurchaseOrder"("companyId", "warehouseId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_companyId_status_idx" ON "PurchaseOrder"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_companyId_number_key" ON "PurchaseOrder"("companyId", "number");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_companyId_purchaseOrderId_idx" ON "PurchaseOrderLine"("companyId", "purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_companyId_productId_idx" ON "PurchaseOrderLine"("companyId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_companyId_clientId_key" ON "GoodsReceipt"("companyId", "clientId");

-- CreateIndex
CREATE INDEX "GoodsReceipt_companyId_warehouseId_receivedAt_idx" ON "GoodsReceipt"("companyId", "warehouseId", "receivedAt");

-- CreateIndex
CREATE INDEX "GoodsReceipt_companyId_purchaseOrderId_idx" ON "GoodsReceipt"("companyId", "purchaseOrderId");

-- CreateIndex
CREATE INDEX "GoodsReceipt_companyId_supplierId_idx" ON "GoodsReceipt"("companyId", "supplierId");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_companyId_goodsReceiptId_idx" ON "GoodsReceiptLine"("companyId", "goodsReceiptId");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_companyId_purchaseOrderLineId_idx" ON "GoodsReceiptLine"("companyId", "purchaseOrderLineId");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_companyId_productId_idx" ON "GoodsReceiptLine"("companyId", "productId");

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "GoodsReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Value sanity (Prisma cannot express CHECK, and it does not diff them, so no
-- drift). Quantities on posted documents are strictly positive; corrections
-- are separate ADJUST movements, never negative receipt lines.
-- ---------------------------------------------------------------------------
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_qty_positive_check" CHECK ("qty" > 0);
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_qtyReceived_nonneg_check" CHECK ("qtyReceived" >= 0);
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_qtyReceived_le_qty_check" CHECK ("qtyReceived" <= "qty");
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_unitPrice_nonneg_check" CHECK ("unitPrice" >= 0);
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_totalAmount_nonneg_check" CHECK ("totalAmount" >= 0);
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_qty_positive_check" CHECK ("qty" > 0);
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_unitCost_nonneg_check" CHECK ("unitCost" IS NULL OR "unitCost" >= 0);

-- ---------------------------------------------------------------------------
-- Row-level security (6.10 / SEC-001..005)
-- ---------------------------------------------------------------------------
ALTER TABLE "Supplier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Supplier" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Supplier"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "PurchaseOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseOrder" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PurchaseOrder"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "PurchaseOrderLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseOrderLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PurchaseOrderLine"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "GoodsReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoodsReceipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "GoodsReceipt"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE "GoodsReceiptLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoodsReceiptLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "GoodsReceiptLine"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- Cross-tenant FK guards (same mechanism as 20260808120000)
-- ---------------------------------------------------------------------------
CREATE TRIGGER purchaseorder_supplier_same_company
  BEFORE INSERT OR UPDATE ON "PurchaseOrder"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Supplier', 'supplierId');
CREATE TRIGGER purchaseorder_warehouse_same_company
  BEFORE INSERT OR UPDATE ON "PurchaseOrder"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Warehouse', 'warehouseId');
CREATE TRIGGER purchaseorder_createdby_same_company
  BEFORE INSERT OR UPDATE ON "PurchaseOrder"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'createdById');

CREATE TRIGGER purchaseorderline_order_same_company
  BEFORE INSERT OR UPDATE ON "PurchaseOrderLine"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('PurchaseOrder', 'purchaseOrderId');
CREATE TRIGGER purchaseorderline_product_same_company
  BEFORE INSERT OR UPDATE ON "PurchaseOrderLine"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Product', 'productId');

CREATE TRIGGER goodsreceipt_warehouse_same_company
  BEFORE INSERT OR UPDATE ON "GoodsReceipt"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Warehouse', 'warehouseId');
CREATE TRIGGER goodsreceipt_purchaseorder_same_company
  BEFORE INSERT OR UPDATE ON "GoodsReceipt"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('PurchaseOrder', 'purchaseOrderId');
CREATE TRIGGER goodsreceipt_supplier_same_company
  BEFORE INSERT OR UPDATE ON "GoodsReceipt"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Supplier', 'supplierId');
CREATE TRIGGER goodsreceipt_receivedby_same_company
  BEFORE INSERT OR UPDATE ON "GoodsReceipt"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'receivedById');

CREATE TRIGGER goodsreceiptline_receipt_same_company
  BEFORE INSERT OR UPDATE ON "GoodsReceiptLine"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('GoodsReceipt', 'goodsReceiptId');
CREATE TRIGGER goodsreceiptline_poline_same_company
  BEFORE INSERT OR UPDATE ON "GoodsReceiptLine"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('PurchaseOrderLine', 'purchaseOrderLineId');
CREATE TRIGGER goodsreceiptline_product_same_company
  BEFORE INSERT OR UPDATE ON "GoodsReceiptLine"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('Product', 'productId');

-- ---------------------------------------------------------------------------
-- GoodsReceipt / GoodsReceiptLine are append-only (TZ 6.1 / 6.4): a posted
-- receipt is stock history (its lines produced the RECEIVE StockMovements);
-- no hard delete, no in-place edit — corrections go through a stock ADJUST.
-- Same mechanism as AuditLog (20260730161500_rls_and_audit_lock +
-- 20260730224500_audit_log_block_truncate): BEFORE UPDATE/DELETE row triggers
-- plus a BEFORE TRUNCATE statement trigger. Triggers are not skipped by
-- BYPASSRLS, so this binds the app role AND velto_system alike (by design —
-- no cross-tenant job has a reason to rewrite receipt history).
-- PurchaseOrder/PurchaseOrderLine stay mutable (status, qtyReceived).
-- The receipt's optional FKs (purchaseOrderId, supplierId, receivedById,
-- purchaseOrderLineId) are ON DELETE RESTRICT rather than SET NULL above: a
-- SET NULL cascade is an UPDATE and would be rejected here anyway, and it
-- would silently erase who/what the receipt was for.
-- ---------------------------------------------------------------------------

CREATE FUNCTION prevent_append_only_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER goodsreceipt_no_update
  BEFORE UPDATE ON "GoodsReceipt"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
CREATE TRIGGER goodsreceipt_no_delete
  BEFORE DELETE ON "GoodsReceipt"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
CREATE TRIGGER goodsreceipt_no_truncate
  BEFORE TRUNCATE ON "GoodsReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER goodsreceiptline_no_update
  BEFORE UPDATE ON "GoodsReceiptLine"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
CREATE TRIGGER goodsreceiptline_no_delete
  BEFORE DELETE ON "GoodsReceiptLine"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
CREATE TRIGGER goodsreceiptline_no_truncate
  BEFORE TRUNCATE ON "GoodsReceiptLine"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();
