-- F6: mandatory SalesOrder cancel reason (TZ §6.7.2 "har bir transition bilan
-- actor, reason, timestamp"). Expand -> backfill -> temporary dual-read
-- (TZ §6.7.3), forward-only:
--   * new nullable columns cancelReason / cancelledAt / cancelledBy (+ FK,
--     same-company guard);
--   * backfill every existing CANCELLED order: reason = text after the last
--     "[Bekor qilindi]: " marker the API appended to `note`, else 'legacy';
--     cancelledAt = updatedAt; cancelledBy stays NULL (actor unknown);
--   * CHECK status = CANCELLED => non-blank cancelReason, added VALIDATED
--     right after the backfill. Safe: the whole file runs as one implicit
--     transaction and the ALTER TABLEs hold ACCESS EXCLUSIVE on "SalesOrder"
--     from the first ADD COLUMN, so no row can be cancelled between backfill
--     and validation; a NOT VALID constraint would add nothing (it already
--     binds new/updated rows) except leaving legacy rows unproven.
--   * dual-read shim: until apps/api writes cancelReason itself, a cancel
--     that only carries the legacy note marker gets cancelReason derived
--     from it. A cancel with no reason at all is rejected by the CHECK.
--     Contract step (later release): drop salesorder_cancel_reason_from_note.
--
-- velto_owner is NOBYPASSRLS and "SalesOrder" is FORCE RLS, so the
-- cross-tenant backfill runs with RLS off (pattern: 20261013150000). Its
-- same-company FK guard triggers would look up Customer/Outlet/Warehouse/User
-- under RLS with no tenant set and fail; the backfill touches none of those
-- FK columns, so those four triggers are disabled for the UPDATE only. Both
-- are restored in the same transaction.

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledBy" UUID;

-- CreateIndex
CREATE INDEX "SalesOrder_cancelledBy_idx" ON "SalesOrder"("cancelledBy");

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_cancelledBy_fkey" FOREIGN KEY ("cancelledBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reason the legacy cancel path wrote into `note`:
--   `${note}\n[Bekor qilindi]: ${reason}` (apps/api sales.service.ts cancel).
-- Greedy prefix => text after the LAST marker; NULL when absent or blank.
CREATE FUNCTION velto_sales_order_cancel_reason_from_note(note text) RETURNS text AS $$
  SELECT nullif(btrim(substring(note from '^.*\[Bekor qilindi\]: (.*)$')), '');
$$ LANGUAGE sql IMMUTABLE;

-- Backfill
ALTER TABLE "SalesOrder" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "SalesOrder" DISABLE TRIGGER salesorder_customer_same_company;
ALTER TABLE "SalesOrder" DISABLE TRIGGER salesorder_outlet_same_company;
ALTER TABLE "SalesOrder" DISABLE TRIGGER salesorder_warehouse_same_company;
ALTER TABLE "SalesOrder" DISABLE TRIGGER salesorder_courier_same_company;

UPDATE "SalesOrder"
SET "cancelReason" = coalesce(velto_sales_order_cancel_reason_from_note("note"), 'legacy'),
    "cancelledAt"  = "updatedAt"
WHERE "status" = 'CANCELLED' AND "cancelReason" IS NULL;

ALTER TABLE "SalesOrder" ENABLE TRIGGER salesorder_customer_same_company;
ALTER TABLE "SalesOrder" ENABLE TRIGGER salesorder_outlet_same_company;
ALTER TABLE "SalesOrder" ENABLE TRIGGER salesorder_warehouse_same_company;
ALTER TABLE "SalesOrder" ENABLE TRIGGER salesorder_courier_same_company;
ALTER TABLE "SalesOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SalesOrder" FORCE ROW LEVEL SECURITY;

-- Invariant (validated: every existing CANCELLED row was backfilled above).
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_cancel_reason_check"
  CHECK ("status" <> 'CANCELLED' OR length(btrim(coalesce("cancelReason", ''))) > 0);

-- Cross-tenant FK guard (pattern: 20261012170000_idempotency_record).
CREATE TRIGGER salesorder_cancelledby_same_company
  BEFORE INSERT OR UPDATE ON "SalesOrder"
  FOR EACH ROW EXECUTE FUNCTION velto_assert_child_company_matches_parent('User', 'cancelledBy');

-- Temporary dual-read shim (see header). Never invents a reason.
CREATE FUNCTION velto_sales_order_cancel_reason_from_note_trg() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'CANCELLED' AND NEW."cancelReason" IS NULL THEN
    NEW."cancelReason" := velto_sales_order_cancel_reason_from_note(NEW."note");
    IF NEW."cancelReason" IS NOT NULL THEN
      NEW."cancelledAt" := coalesce(NEW."cancelledAt", now() AT TIME ZONE 'UTC');
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER salesorder_cancel_reason_from_note
  BEFORE INSERT OR UPDATE ON "SalesOrder"
  FOR EACH ROW EXECUTE FUNCTION velto_sales_order_cancel_reason_from_note_trg();
