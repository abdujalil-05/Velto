-- F6 contract step for 20261019120100_sales_order_cancel_reason (security
-- review): apps/api now writes SalesOrder.cancelReason/cancelledAt/cancelledBy
-- directly (c06aeef), so the temporary dual-read shim is removed. Left in
-- place it would let any writer satisfy the mandatory-reason CHECK silently by
-- appending a "[Bekor qilindi]: ..." marker to `note` instead of recording an
-- explicit reason/actor.
--
-- Data-safe: drops only a trigger and two functions, no column or row is
-- touched. Every pre-existing CANCELLED row was backfilled and the CHECK
-- "SalesOrder_cancel_reason_check" was added VALIDATED; it stays. After this
-- migration a CANCELLED write without a non-blank cancelReason is rejected.
-- Rollback (if ever needed): re-create the trigger/functions from
-- 20261019120100 in a new forward migration.

DROP TRIGGER IF EXISTS salesorder_cancel_reason_from_note ON "SalesOrder";
DROP FUNCTION IF EXISTS velto_sales_order_cancel_reason_from_note_trg();
-- Note parser was used only by the shim and the one-off backfill above.
DROP FUNCTION IF EXISTS velto_sales_order_cancel_reason_from_note(text);
