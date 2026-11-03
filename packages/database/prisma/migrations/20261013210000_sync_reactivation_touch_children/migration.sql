-- F4 fix: reactivating a Product/Customer must resend its children.
--
-- A Product/Customer deactivation tombstone (20261013200000,
-- *_sync_tombstone_deactivate) makes the Mini App drop the parent AND its
-- children locally (Product -> ProductPackaging, PriceListItem, StockLevel;
-- Customer -> Outlet). On reactivation only the parent's "changeSeq" was
-- bumped, so the children were never resent by GET /sync/pull.
--
-- This AFTER UPDATE trigger fires when the parent goes from hidden
-- (deletedAt set OR isActive false) to live (deletedAt NULL AND isActive) —
-- the exact inverse of the tombstone condition — and issues a data-neutral
-- UPDATE ("changeSeq" = "changeSeq") on the children. The existing
-- BEFORE INSERT OR UPDATE velto_sync_bump_change_seq trigger then re-stamps
-- each child with nextval('sync_change_seq').
--
-- Safety:
--  - No recursion: the child UPDATE touches only "changeSeq", so the
--    outlet_sync_tombstone_deactivate trigger (UPDATE OF deletedAt, isActive)
--    does not fire, and child tables have no AFTER UPDATE on parents.
--  - Same-company guards (stocklevel_/pricelistitem_ *_same_company) re-run
--    and pass: rows already satisfy them.
--  - SECURITY INVOKER (default): runs under the caller's RLS context; all
--    children of a row share its company (enforced by the FK guards).
--  - No AuditLog / append-only table is touched.

CREATE FUNCTION velto_sync_touch_children_on_reactivate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'Product' THEN
    UPDATE "ProductPackaging" SET "changeSeq" = "changeSeq" WHERE "productId" = NEW."id";
    UPDATE "PriceListItem"    SET "changeSeq" = "changeSeq" WHERE "productId" = NEW."id";
    UPDATE "StockLevel"       SET "changeSeq" = "changeSeq" WHERE "productId" = NEW."id";
  ELSIF TG_TABLE_NAME = 'Customer' THEN
    UPDATE "Outlet" SET "changeSeq" = "changeSeq"
     WHERE "customerId" = NEW."id" AND "deletedAt" IS NULL AND "isActive";
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER product_sync_touch_children_reactivate
  AFTER UPDATE OF "deletedAt", "isActive" ON "Product"
  FOR EACH ROW
  WHEN (NOT (OLD."deletedAt" IS NULL AND OLD."isActive") AND (NEW."deletedAt" IS NULL AND NEW."isActive"))
  EXECUTE FUNCTION velto_sync_touch_children_on_reactivate();

CREATE TRIGGER customer_sync_touch_children_reactivate
  AFTER UPDATE OF "deletedAt", "isActive" ON "Customer"
  FOR EACH ROW
  WHEN (NOT (OLD."deletedAt" IS NULL AND OLD."isActive") AND (NEW."deletedAt" IS NULL AND NEW."isActive"))
  EXECUTE FUNCTION velto_sync_touch_children_on_reactivate();
