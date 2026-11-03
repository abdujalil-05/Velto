-- F7.6 dashboard perf: "Payment" posted-at period filter.
--
-- apps/api finance/ledger-filters.ts paymentPostedWithin() (ADR-029, used by
-- dashboard paymentsTotal, payments list, 1C export) is the Prisma form of
--   ("handoverAt" BETWEEN a AND b) OR ("handoverAt" IS NULL AND "createdAt" BETWEEN a AND b)
-- plus RLS "companyId" = current_setting(...). The only Payment index usable
-- for it was (companyId, status): every window read all of the tenant's
-- payments (or a parallel seq scan of the whole table).
-- With these two btrees the planner runs a BitmapOr: branch 1 probes
-- (companyId, handoverAt), branch 2 probes (companyId, createdAt) with
-- "handoverAt" IS NULL rechecked on the heap.
--
-- An expression index on coalesce("handoverAt", "createdAt") was NOT chosen:
-- the OR form above cannot use it; it would need the query rewritten to the
-- coalesce form (out of scope for this step).
-- SalesOrder(companyId, createdAt) for turnoverPerDay already exists
-- (20261020100000) and is used; not repeated here.
--
-- Measured on velto_load (3 tenants: 70k / 21k / 7k payments; EXPLAIN
-- ANALYZE as velto_app under RLS, "today" window, median of 7):
-- 70k tenant 9.3 ms (Parallel Seq Scan) -> 0.84 ms (BitmapOr of both),
-- 21k tenant 2.5 ms (Bitmap on companyId_status, 21k rows) -> 0.34 ms.
--
-- Strictly additive; no data, column or policy change. Write cost: two more
-- btree entries per Payment insert, one more on handover accept.
--
-- Locking: Prisma runs migrations in a transaction, so CONCURRENTLY is not
-- possible here; plain CREATE INDEX blocks writes to "Payment" while it
-- builds. For a large production table instead run, before `migrate deploy`,
-- outside a tx:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "Payment_companyId_handoverAt_idx"
--     ON "Payment" ("companyId", "handoverAt");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "Payment_companyId_createdAt_idx"
--     ON "Payment" ("companyId", "createdAt");
-- and this migration's IF NOT EXISTS makes it a no-op.

CREATE INDEX IF NOT EXISTS "Payment_companyId_handoverAt_idx" ON "Payment"("companyId", "handoverAt");

CREATE INDEX IF NOT EXISTS "Payment_companyId_createdAt_idx" ON "Payment"("companyId", "createdAt");
