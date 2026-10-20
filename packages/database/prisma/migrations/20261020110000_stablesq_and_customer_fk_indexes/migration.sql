-- F7 qa finding (velto_dev, ~27k companies of test leftovers; EXPLAIN ANALYZE
-- as velto_app under RLS). Strictly additive: indexes only, no data, column or
-- policy change.
--
-- (a) sync stableSeq(): `updatedAt <= cutoff ORDER BY changeSeq DESC LIMIT 1`
-- on "StockLevel"/"ProductPackaging" (no companyId; RLS via parent EXISTS).
-- The RLS EXISTS becomes a hashed SubPlan *filter*, so the planner walks the
-- GLOBAL changeSeq index across all tenants (cost grows with tenant count).
-- An index alone does NOT change that plan (measured: still 113 ms / 708k
-- rows removed). Fix = api adds an explicit redundant tenant predicate
-- (warehouseId IN tenant warehouses / productId IN tenant products; RLS stays
-- the real guard) + this index so StockLevel can be probed by warehouseId
-- (PK leads with productId; without it the predicate costs 433 ms).
-- ProductPackaging needs no new index: existing (productId) suffices.
-- Measured with predicate+index: StockLevel 181 ms -> 0.16 ms (small tenant),
-- 53 ms -> 2.3 ms (5k-row tenant); ProductPackaging 90 ms -> 2.5 ms,
-- 150 ms -> 11-22 ms. Denormalized companyId rejected: not needed.
CREATE INDEX "StockLevel_warehouseId_changeSeq_idx" ON "StockLevel"("warehouseId", "changeSeq");

-- (b) Customer DELETE: ON DELETE RESTRICT FK checks look up by "customerId"
-- alone; only ("companyId","customerId") existed, so each check was a seq /
-- full-index scan. Measured DELETE FK triggers: Payment 641 ms, Outlet 64,
-- Invoice 32, SalesOrder 6, ReconciliationFinding 2 (757 ms total).
CREATE INDEX "Outlet_customerId_idx" ON "Outlet"("customerId");
CREATE INDEX "SalesOrder_customerId_idx" ON "SalesOrder"("customerId");
CREATE INDEX "Invoice_customerId_idx" ON "Invoice"("customerId");
CREATE INDEX "Payment_customerId_idx" ON "Payment"("customerId");
CREATE INDEX "ReconciliationFinding_customerId_idx" ON "ReconciliationFinding"("customerId");

-- Locking: Prisma runs migrations in a transaction, so CONCURRENTLY is not
-- possible; plain CREATE INDEX takes SHARE lock -> blocks INSERT/UPDATE/DELETE
-- on each table while it builds (reads continue). velto_dev volumes (0.4-0.9M
-- rows) build in ~1 s each; pilot volumes are far smaller. For a large prod
-- table, pre-create the same-named index CONCURRENTLY out of band first and
-- mark this migration applied (`prisma migrate resolve --applied`).
