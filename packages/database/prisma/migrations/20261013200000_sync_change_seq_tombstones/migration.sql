-- F4 step 1: monotonic sync cursor (changeSeq) + SyncTombstone for GET /sync/pull.
--
-- Synced tables (cursor-pulled by apps/api/src/modules/sync/sync.service.ts):
--   Product, ProductPackaging, PriceListItem, Customer, Outlet, StockLevel,
--   ProductCategory. (Route/RouteStop are re-sent in full on every pull and
--   need neither a cursor nor tombstones.)
--
-- 1) One global sequence "sync_change_seq". Every synced table gets
--    "changeSeq" BIGINT NOT NULL, stamped by a BEFORE INSERT OR UPDATE trigger
--    (velto_sync_bump_change_seq) — any value a writer supplies is overwritten.
--    Existing rows are backfilled per table in a deterministic order
--    ("updatedAt", then primary key).
--
--    COMMIT-ORDER CAVEAT: nextval() order is NOT commit order. A transaction
--    that took seq 100 may commit after one that took seq 101, so a reader
--    that saw 101 and advances its cursor to 101 would skip 100 forever. The
--    pull MUST NOT simply return max(changeSeq) as the next cursor: it has to
--    use a lookback/watermark (e.g. re-read a window below the cursor, or cap
--    the cursor below the oldest in-flight transaction) and devices must apply
--    rows idempotently. Nothing in this migration enforces that.
--
-- 2) "SyncTombstone" (direct companyId, RLS + FORCE like every tenant table):
--    written by AFTER triggers (velto_sync_write_tombstone) on
--      - DELETE of any synced row;
--      - Product/Customer/Outlet soft-delete ("deletedAt" NULL -> set) or
--        deactivation ("isActive" true -> false).
--    Its "changeSeq" comes from the same sequence, so rows and tombstones
--    merge on one cursor: a tombstone is always newer than the update that
--    caused it, and a later reactivation bumps the row above the tombstone.
--    Child tables without companyId resolve it through their parent
--    (ProductPackaging -> Product, PriceListItem -> PriceList,
--    StockLevel -> Warehouse); the trigger runs as the invoker, so under
--    withTenant the parent is visible via RLS. If the company cannot be
--    resolved the statement fails (never a silent missing tombstone).
--    RETENTION: tombstones must be kept at least as long as the longest
--    supported offline window (>= N days, N to be fixed by the pull's
--    full-resync rule); no cleanup job is added here.
--
-- Backfill: velto_owner is NOBYPASSRLS and these tables are FORCE RLS, so RLS
-- is switched off for the cross-tenant backfill and restored (ENABLE + FORCE)
-- in the same migration transaction — pattern of 20261013150000/180000.
-- Warehouse and PriceList are included because the cross-tenant FK guard
-- triggers on StockLevel/PriceListItem read them during the UPDATE.

-- Sequence
CREATE SEQUENCE "sync_change_seq" AS BIGINT;

-- AlterTable: nullable first, NOT NULL after backfill
ALTER TABLE "Product"          ADD COLUMN "changeSeq" BIGINT;
ALTER TABLE "ProductPackaging" ADD COLUMN "changeSeq" BIGINT;
ALTER TABLE "PriceListItem"    ADD COLUMN "changeSeq" BIGINT;
ALTER TABLE "Customer"         ADD COLUMN "changeSeq" BIGINT;
ALTER TABLE "Outlet"           ADD COLUMN "changeSeq" BIGINT;
ALTER TABLE "StockLevel"       ADD COLUMN "changeSeq" BIGINT;
ALTER TABLE "ProductCategory"  ADD COLUMN "changeSeq" BIGINT;

-- Backfill
ALTER TABLE "Product"          DISABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductPackaging" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "PriceListItem"    DISABLE ROW LEVEL SECURITY;
ALTER TABLE "PriceList"        DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Customer"         DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Outlet"           DISABLE ROW LEVEL SECURITY;
ALTER TABLE "StockLevel"       DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Warehouse"        DISABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductCategory"  DISABLE ROW LEVEL SECURITY;

-- Temporary helper: assigns a contiguous block of sequence values to `tbl`,
-- ordered by ("updatedAt", keys...). Dropped below.
CREATE FUNCTION velto_tmp_backfill_change_seq(tbl text, keys text[])
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  n     bigint;
  base  bigint;
  cols  text;
  joinc text;
BEGIN
  EXECUTE format('SELECT count(*) FROM %I', tbl) INTO n;
  IF n = 0 THEN
    RETURN;
  END IF;
  base := nextval('sync_change_seq');
  PERFORM setval('sync_change_seq', base + n - 1, true);
  SELECT string_agg(format('%I', k), ', '),
         string_agg(format('t.%1$I = o.%1$I', k), ' AND ')
    INTO cols, joinc
    FROM unnest(keys) AS k;
  EXECUTE format(
    'UPDATE %1$I t SET "changeSeq" = $1 + o.rn - 1
       FROM (SELECT %2$s, row_number() OVER (ORDER BY "updatedAt", %2$s) AS rn FROM %1$I) o
      WHERE %3$s',
    tbl, cols, joinc)
  USING base;
END;
$$;

SELECT velto_tmp_backfill_change_seq('ProductCategory',  ARRAY['id']);
SELECT velto_tmp_backfill_change_seq('Product',          ARRAY['id']);
SELECT velto_tmp_backfill_change_seq('ProductPackaging', ARRAY['id']);
SELECT velto_tmp_backfill_change_seq('PriceListItem',    ARRAY['id']);
SELECT velto_tmp_backfill_change_seq('Customer',         ARRAY['id']);
SELECT velto_tmp_backfill_change_seq('Outlet',           ARRAY['id']);
SELECT velto_tmp_backfill_change_seq('StockLevel',       ARRAY['productId', 'warehouseId']);

DROP FUNCTION velto_tmp_backfill_change_seq(text, text[]);

ALTER TABLE "ProductCategory"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductCategory"  FORCE ROW LEVEL SECURITY;
ALTER TABLE "Warehouse"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Warehouse"        FORCE ROW LEVEL SECURITY;
ALTER TABLE "StockLevel"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockLevel"       FORCE ROW LEVEL SECURITY;
ALTER TABLE "Outlet"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Outlet"           FORCE ROW LEVEL SECURITY;
ALTER TABLE "Customer"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Customer"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "PriceList"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PriceList"        FORCE ROW LEVEL SECURITY;
ALTER TABLE "PriceListItem"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PriceListItem"    FORCE ROW LEVEL SECURITY;
ALTER TABLE "ProductPackaging" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductPackaging" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Product"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Product"          FORCE ROW LEVEL SECURITY;

-- Default (so Prisma creates need not supply it) + NOT NULL
ALTER TABLE "Product"          ALTER COLUMN "changeSeq" SET DEFAULT nextval('sync_change_seq'), ALTER COLUMN "changeSeq" SET NOT NULL;
ALTER TABLE "ProductPackaging" ALTER COLUMN "changeSeq" SET DEFAULT nextval('sync_change_seq'), ALTER COLUMN "changeSeq" SET NOT NULL;
ALTER TABLE "PriceListItem"    ALTER COLUMN "changeSeq" SET DEFAULT nextval('sync_change_seq'), ALTER COLUMN "changeSeq" SET NOT NULL;
ALTER TABLE "Customer"         ALTER COLUMN "changeSeq" SET DEFAULT nextval('sync_change_seq'), ALTER COLUMN "changeSeq" SET NOT NULL;
ALTER TABLE "Outlet"           ALTER COLUMN "changeSeq" SET DEFAULT nextval('sync_change_seq'), ALTER COLUMN "changeSeq" SET NOT NULL;
ALTER TABLE "StockLevel"       ALTER COLUMN "changeSeq" SET DEFAULT nextval('sync_change_seq'), ALTER COLUMN "changeSeq" SET NOT NULL;
ALTER TABLE "ProductCategory"  ALTER COLUMN "changeSeq" SET DEFAULT nextval('sync_change_seq'), ALTER COLUMN "changeSeq" SET NOT NULL;

-- CreateIndex (direct-companyId tables: (companyId, changeSeq); child tables
-- are tenant-filtered through their parent policy, so (changeSeq) alone)
CREATE INDEX "Product_companyId_changeSeq_idx"         ON "Product"("companyId", "changeSeq");
CREATE INDEX "Customer_companyId_changeSeq_idx"        ON "Customer"("companyId", "changeSeq");
CREATE INDEX "Outlet_companyId_changeSeq_idx"          ON "Outlet"("companyId", "changeSeq");
CREATE INDEX "ProductCategory_companyId_changeSeq_idx" ON "ProductCategory"("companyId", "changeSeq");
CREATE INDEX "ProductPackaging_changeSeq_idx"          ON "ProductPackaging"("changeSeq");
CREATE INDEX "PriceListItem_changeSeq_idx"             ON "PriceListItem"("changeSeq");
CREATE INDEX "StockLevel_changeSeq_idx"                ON "StockLevel"("changeSeq");

-- changeSeq stamping trigger
CREATE FUNCTION velto_sync_bump_change_seq()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."changeSeq" := nextval('sync_change_seq');
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_sync_change_seq          BEFORE INSERT OR UPDATE ON "Product"          FOR EACH ROW EXECUTE FUNCTION velto_sync_bump_change_seq();
CREATE TRIGGER productpackaging_sync_change_seq BEFORE INSERT OR UPDATE ON "ProductPackaging" FOR EACH ROW EXECUTE FUNCTION velto_sync_bump_change_seq();
CREATE TRIGGER pricelistitem_sync_change_seq    BEFORE INSERT OR UPDATE ON "PriceListItem"    FOR EACH ROW EXECUTE FUNCTION velto_sync_bump_change_seq();
CREATE TRIGGER customer_sync_change_seq         BEFORE INSERT OR UPDATE ON "Customer"         FOR EACH ROW EXECUTE FUNCTION velto_sync_bump_change_seq();
CREATE TRIGGER outlet_sync_change_seq           BEFORE INSERT OR UPDATE ON "Outlet"           FOR EACH ROW EXECUTE FUNCTION velto_sync_bump_change_seq();
CREATE TRIGGER stocklevel_sync_change_seq       BEFORE INSERT OR UPDATE ON "StockLevel"       FOR EACH ROW EXECUTE FUNCTION velto_sync_bump_change_seq();
CREATE TRIGGER productcategory_sync_change_seq  BEFORE INSERT OR UPDATE ON "ProductCategory"  FOR EACH ROW EXECUTE FUNCTION velto_sync_bump_change_seq();

-- CreateEnum
CREATE TYPE "SyncEntity" AS ENUM ('Product', 'ProductPackaging', 'PriceListItem', 'Customer', 'Outlet', 'StockLevel', 'ProductCategory');

-- CreateTable
CREATE TABLE "SyncTombstone" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "entity" "SyncEntity" NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityKey" JSONB,
    "changeSeq" BIGINT NOT NULL DEFAULT nextval('sync_change_seq'),
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncTombstone_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SyncTombstone_companyId_changeSeq_idx" ON "SyncTombstone"("companyId", "changeSeq");

ALTER TABLE "SyncTombstone" ADD CONSTRAINT "SyncTombstone_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER synctombstone_sync_change_seq BEFORE INSERT OR UPDATE ON "SyncTombstone" FOR EACH ROW EXECUTE FUNCTION velto_sync_bump_change_seq();

-- RLS (§10.4 / SEC-001..005)
ALTER TABLE "SyncTombstone" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncTombstone" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SyncTombstone"
  USING ("companyId" = current_setting('app.current_company_id', true)::uuid);

-- Tombstone writer.
-- TG_ARGV: [0] entity, [1] parent table holding companyId ('' = own column),
-- [2] FK column to that parent, [3..] natural-key columns copied into
-- "entityKey" (and, for a table without "id", joined with ':' as "entityId").
CREATE FUNCTION velto_sync_write_tombstone()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  r      jsonb;
  ent    text := TG_ARGV[0];
  ptab   text := TG_ARGV[1];
  pcol   text := TG_ARGV[2];
  cid    uuid;
  eid    text;
  ekey   jsonb := NULL;
  parts  text[] := ARRAY[]::text[];
  i      int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    r := to_jsonb(OLD);
  ELSE
    r := to_jsonb(NEW);
  END IF;

  IF ptab = '' THEN
    cid := (r ->> 'companyId')::uuid;
  ELSE
    EXECUTE format('SELECT "companyId" FROM %I WHERE "id" = $1', ptab)
      INTO cid USING (r ->> pcol)::uuid;
  END IF;
  IF cid IS NULL THEN
    RAISE EXCEPTION 'sync tombstone: cannot resolve companyId for % row %', ent, r
      USING ERRCODE = '23502';
  END IF;

  IF TG_NARGS > 3 THEN
    ekey := '{}'::jsonb;
    FOR i IN 3 .. TG_NARGS - 1 LOOP
      ekey := ekey || jsonb_build_object(TG_ARGV[i], r -> TG_ARGV[i]);
      parts := parts || (r ->> TG_ARGV[i]);
    END LOOP;
  END IF;
  eid := COALESCE(r ->> 'id', array_to_string(parts, ':'));

  INSERT INTO "SyncTombstone" ("companyId", "entity", "entityId", "entityKey")
  VALUES (cid, ent::"SyncEntity", eid, ekey);
  RETURN NULL;
END;
$$;

-- Hard delete (all synced tables)
CREATE TRIGGER product_sync_tombstone_delete          AFTER DELETE ON "Product"          FOR EACH ROW EXECUTE FUNCTION velto_sync_write_tombstone('Product', '', '');
CREATE TRIGGER customer_sync_tombstone_delete         AFTER DELETE ON "Customer"         FOR EACH ROW EXECUTE FUNCTION velto_sync_write_tombstone('Customer', '', '');
CREATE TRIGGER outlet_sync_tombstone_delete           AFTER DELETE ON "Outlet"           FOR EACH ROW EXECUTE FUNCTION velto_sync_write_tombstone('Outlet', '', '');
CREATE TRIGGER productcategory_sync_tombstone_delete  AFTER DELETE ON "ProductCategory"  FOR EACH ROW EXECUTE FUNCTION velto_sync_write_tombstone('ProductCategory', '', '');
CREATE TRIGGER productpackaging_sync_tombstone_delete AFTER DELETE ON "ProductPackaging" FOR EACH ROW EXECUTE FUNCTION velto_sync_write_tombstone('ProductPackaging', 'Product', 'productId');
CREATE TRIGGER pricelistitem_sync_tombstone_delete    AFTER DELETE ON "PriceListItem"    FOR EACH ROW EXECUTE FUNCTION velto_sync_write_tombstone('PriceListItem', 'PriceList', 'priceListId', 'priceListId', 'productId');
CREATE TRIGGER stocklevel_sync_tombstone_delete       AFTER DELETE ON "StockLevel"       FOR EACH ROW EXECUTE FUNCTION velto_sync_write_tombstone('StockLevel', 'Warehouse', 'warehouseId', 'productId', 'warehouseId');

-- Soft delete / deactivation transitions (tables with deletedAt + isActive)
CREATE TRIGGER product_sync_tombstone_deactivate
  AFTER UPDATE OF "deletedAt", "isActive" ON "Product"
  FOR EACH ROW
  WHEN ((OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL) OR (OLD."isActive" AND NOT NEW."isActive"))
  EXECUTE FUNCTION velto_sync_write_tombstone('Product', '', '');
CREATE TRIGGER customer_sync_tombstone_deactivate
  AFTER UPDATE OF "deletedAt", "isActive" ON "Customer"
  FOR EACH ROW
  WHEN ((OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL) OR (OLD."isActive" AND NOT NEW."isActive"))
  EXECUTE FUNCTION velto_sync_write_tombstone('Customer', '', '');
CREATE TRIGGER outlet_sync_tombstone_deactivate
  AFTER UPDATE OF "deletedAt", "isActive" ON "Outlet"
  FOR EACH ROW
  WHEN ((OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL) OR (OLD."isActive" AND NOT NEW."isActive"))
  EXECUTE FUNCTION velto_sync_write_tombstone('Outlet', '', '');

-- Runtime grants (see 20261012170000_idempotency_record for rationale).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velto_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "SyncTombstone" TO velto_app;
    GRANT USAGE, SELECT ON SEQUENCE "sync_change_seq" TO velto_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velto_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "SyncTombstone" TO velto_system;
    GRANT USAGE, SELECT ON SEQUENCE "sync_change_seq" TO velto_system;
  END IF;
END
$$;
