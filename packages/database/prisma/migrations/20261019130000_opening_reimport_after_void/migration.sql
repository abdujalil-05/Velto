-- F6 follow-up: a VOIDED opening batch must not block re-importing the same
-- data (real correction flow: wrong file imported -> void -> import the right
-- file). Payment already excludes REVERSED rows; Invoice and StockMovement are
-- aligned here. Forward-only, backward-compatible: only index/trigger changes,
-- every existing row satisfies the new (looser) rules. No backfill.
--
-- Layering: the DB only rejects a collision between TWO opening quantities for
-- the same (company, product, warehouse). "Opening is create-only: no opening
-- on a pair that already has other movements" (ADR-026) stays in the service.

-- ---------------------------------------------------------------------------
-- Invoice: CANCELLED opening invoices (voided batch) free their externalDocRef
-- ---------------------------------------------------------------------------
DROP INDEX "Invoice_opening_externalDocRef_key";
CREATE UNIQUE INDEX "Invoice_opening_externalDocRef_key" ON "Invoice"("companyId", "customerId", "externalDocRef")
  WHERE "kind" = 'OPENING' AND "externalDocRef" IS NOT NULL AND "status" <> 'CANCELLED';

-- ---------------------------------------------------------------------------
-- StockMovement: one opening qty per product/warehouse among non-VOIDED batches
-- ---------------------------------------------------------------------------
-- A partial unique index cannot see the batch status, so the rule moves into a
-- BEFORE INSERT trigger. Concurrency: a transaction-scoped advisory lock keyed
-- on (company, product, warehouse) serialises competing inserts; under READ
-- COMMITTED the EXISTS check below runs with a fresh snapshot taken after the
-- lock, so it sees the winner's committed row. SERIALIZABLE is covered by SSI
-- (predicate read + insert). REPEATABLE READ would read a pre-lock snapshot,
-- so it is rejected (fail closed).
CREATE FUNCTION velto_stock_movement_opening_unique_guard() RETURNS trigger AS $$
DECLARE
  clash_batch uuid;
BEGIN
  IF NEW."refType" IS DISTINCT FROM 'OpeningBalance' OR NEW."reversesMovementId" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'opening stock insert is not allowed under REPEATABLE READ (use READ COMMITTED or SERIALIZABLE)';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('velto_opening_stock:' || NEW."companyId" || ':' || NEW."productId" || ':' || NEW."warehouseId", 0)
  );

  SELECT sm."refId" INTO clash_batch
    FROM "StockMovement" sm
    JOIN "OpeningBalanceBatch" b ON b."id" = sm."refId"
   WHERE sm."companyId" = NEW."companyId"
     AND sm."productId" = NEW."productId"
     AND sm."warehouseId" = NEW."warehouseId"
     AND sm."refType" = 'OpeningBalance'
     AND sm."reversesMovementId" IS NULL
     AND b."status" <> 'VOIDED'
   LIMIT 1;

  IF clash_batch IS NOT NULL THEN
    RAISE EXCEPTION 'opening stock already exists for product % in warehouse % (batch %, not VOIDED); void that batch before re-importing',
      NEW."productId", NEW."warehouseId", clash_batch;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Name sorts after stockmovement_opening_guard_insert, so batch kind/status is
-- validated first.
CREATE TRIGGER stockmovement_opening_unique_guard
  BEFORE INSERT ON "StockMovement"
  FOR EACH ROW EXECUTE FUNCTION velto_stock_movement_opening_unique_guard();

-- Same lookup, no longer unique.
DROP INDEX "StockMovement_opening_product_warehouse_key";
CREATE INDEX "StockMovement_opening_product_warehouse_idx" ON "StockMovement"("companyId", "productId", "warehouseId")
  WHERE "refType" = 'OpeningBalance' AND "reversesMovementId" IS NULL;
