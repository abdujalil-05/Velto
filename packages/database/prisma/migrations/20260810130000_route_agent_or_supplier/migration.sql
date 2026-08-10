-- Route ownership becomes "agent XOR deliverer" (follow-up to
-- 20260810120000_order_route_supplier_link, which added "Route"."supplierId"
-- but kept "agentId" NOT NULL).
--
-- A route is now served either by an own field agent or by a supplier
-- ("yetkazib beruvchi"), never both and never neither.
--
-- Safe on existing data: every row predates "supplierId" (added in the
-- previous migration, no writer sets it yet), so every row has agentId NOT
-- NULL and supplierId NULL and already satisfies the new CHECK. Relaxing a
-- NOT NULL cannot invalidate a stored row either. Verified before writing this
-- migration: `SELECT count(*) FROM "Route" WHERE "agentId" IS NULL OR
-- "supplierId" IS NOT NULL` = 0.
--
-- No RLS change: "Route" keeps the direct-companyId `tenant_isolation` policy
-- (with FORCE) from 20260730161500 — nullability and CHECK constraints are
-- orthogonal to row visibility, and the cross-tenant FK guard trigger
-- `route_supplier_same_company` from the previous migration still applies.

-- ---------------------------------------------------------------------------
-- 1. agentId becomes nullable
-- ---------------------------------------------------------------------------

ALTER TABLE "Route" ALTER COLUMN "agentId" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Supplier FK: SET NULL -> RESTRICT
--
-- With the XOR below in place, ON DELETE SET NULL is actively wrong: deleting
-- a supplier would null out "supplierId" on the routes it serves, leaving rows
-- with neither owner, and the DELETE would then fail with an opaque check
-- violation instead of a clear FK error. RESTRICT states the real rule —
-- reassign the route before removing the deliverer — and matches every other
-- Supplier FK in the schema (PurchaseOrder, SupplierRoute,
-- SupplierTelegramLink). Suppliers are soft-deleted (`deletedAt`) in normal
-- operation, so this path is the exception.
--
-- "Route"."agentId"'s FK is already RESTRICT and is deliberately left alone:
-- dropping NOT NULL must not silently turn it into SET NULL, which would
-- break the XOR the same way.
-- ---------------------------------------------------------------------------

ALTER TABLE "Route" DROP CONSTRAINT "Route_supplierId_fkey";

ALTER TABLE "Route" ADD CONSTRAINT "Route_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Exactly-one-owner guard
--
-- A plain CHECK, not a trigger: this is a single-row, two-column predicate, so
-- it needs no lookup — same choice as "SupplierRoute_weekday_check" /
-- "SupplierRouteStop_sequence_check". Triggers are reserved in this schema for
-- checks that must read another table (the cross-tenant FK guards) or block a
-- statement class (the AuditLog append-only lock). Being a CHECK also means
-- Prisma's migrate diff neither sees nor proposes dropping it, so it will not
-- drift out on the next `migrate dev`.
--
-- `(a IS NULL) <> (b IS NULL)` is the XOR: true only when exactly one side is
-- NULL. Note boolean <> is not NULL-propagating here because IS NULL always
-- yields true/false, never NULL — so the constraint can never evaluate to
-- UNKNOWN and be silently satisfied.
-- ---------------------------------------------------------------------------

ALTER TABLE "Route" ADD CONSTRAINT "Route_agent_xor_supplier_check"
  CHECK (("agentId" IS NULL) <> ("supplierId" IS NULL));
