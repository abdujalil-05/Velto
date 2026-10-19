-- Restore-drill / load-dataset integrity checks (TZ §12.2, §12.5, §6.4–6.5,
-- §10.4). ONE read-only SELECT; every returned row is a finding, 0 rows = clean.
--
-- Run as a role that sees every tenant (superuser on a restored copy, or
-- velto_system) for a whole-database verdict:
--   psql "postgresql://velto:velto@localhost:5433/<db>" -v ON_ERROR_STOP=1 -f packages/database/scripts/verify-integrity.sql
-- Under velto_app inside a tenant transaction (seed-load.ts does this) RLS
-- scopes (b)–(d) and (f) to that one company; (a) and (e) read the catalog.
--
-- Formulas are the application's, verbatim — keep them in sync:
--   (b) onHand = ΣRECEIVE + ΣADJUST − ΣISSUE; reserved = ΣRESERVE − ΣRELEASE − ΣISSUE
--       (apps/api/src/modules/reconciliation/reconciliation.service.ts, F2.5)
--   (c) balance = Σ live invoices − Σ valid allocations to them − advance,
--       advance = Σ POSTED payments − their allocations to live invoices
--       (apps/api/src/modules/customers/customers.service.ts getLedger, §6.5;
--       live = status <> CANCELLED, valid allocation = payment POSTED)
-- Columns: check_name | subject | expected | actual
WITH
-- (a) every tenant-scoped table: RLS ENABLE + FORCE + at least one policy.
tenant_tables AS (
  SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    AND (
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'companyId' AND NOT a.attisdropped)
      OR EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
    )
),
chk_rls AS (
  SELECT 'a_rls_enable_force'::text AS check_name, relname::text AS subject,
         'ENABLE+FORCE+policy'::text AS expected,
         concat('enable=', relrowsecurity, ' force=', relforcerowsecurity,
                ' policies=', (SELECT count(*) FROM pg_policy p WHERE p.polrelid = t.oid))::text AS actual
  FROM tenant_tables t
  WHERE NOT relrowsecurity OR NOT relforcerowsecurity
     OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = t.oid)
),
-- (b) StockLevel projection vs. StockMovement ledger (FULL OUTER: a level
-- with no movements, or movements with no level, are both drift).
mv AS (
  SELECT "productId", "warehouseId",
    COALESCE(SUM(CASE WHEN "type" IN ('RECEIVE', 'ADJUST') THEN "qty" WHEN "type" = 'ISSUE' THEN -"qty" ELSE 0 END), 0) AS on_hand,
    COALESCE(SUM(CASE WHEN "type" = 'RESERVE' THEN "qty" WHEN "type" IN ('RELEASE', 'ISSUE') THEN -"qty" ELSE 0 END), 0) AS reserved
  FROM "StockMovement" GROUP BY "productId", "warehouseId"
),
stock_join AS (
  SELECT COALESCE(m."productId", l."productId") AS product_id, COALESCE(m."warehouseId", l."warehouseId") AS warehouse_id,
         COALESCE(m.on_hand, 0) AS exp_on_hand, COALESCE(l."onHand", 0) AS act_on_hand,
         COALESCE(m.reserved, 0) AS exp_reserved, COALESCE(l."reserved", 0) AS act_reserved
  FROM mv m FULL OUTER JOIN "StockLevel" l ON l."productId" = m."productId" AND l."warehouseId" = m."warehouseId"
),
chk_stock AS (
  SELECT 'b_stock_level_drift', concat(product_id, '@', warehouse_id),
         concat('onHand=', exp_on_hand, ' reserved=', exp_reserved),
         concat('onHand=', act_on_hand, ' reserved=', act_reserved)
  FROM stock_join WHERE exp_on_hand <> act_on_hand OR exp_reserved <> act_reserved
  UNION ALL
  SELECT 'b_stock_level_invalid', concat(product_id, '@', warehouse_id),
         '0 <= reserved <= onHand', concat('onHand=', act_on_hand, ' reserved=', act_reserved)
  FROM stock_join WHERE act_on_hand < 0 OR act_reserved < 0 OR act_reserved > act_on_hand
),
-- (f) oversell over time: running onHand and running available
-- (onHand − reserved) per product/warehouse must never dip below zero.
running AS (
  SELECT "productId", "warehouseId", "createdAt",
    SUM(CASE WHEN "type" IN ('RECEIVE', 'ADJUST') THEN "qty" WHEN "type" = 'ISSUE' THEN -"qty" ELSE 0 END)
      OVER w AS run_on_hand,
    SUM(CASE WHEN "type" IN ('RECEIVE', 'ADJUST') THEN "qty" WHEN "type" = 'RESERVE' THEN -"qty" WHEN "type" = 'RELEASE' THEN "qty" ELSE 0 END)
      OVER w AS run_available
  FROM "StockMovement"
  WINDOW w AS (PARTITION BY "productId", "warehouseId" ORDER BY "createdAt", "id" ROWS UNBOUNDED PRECEDING)
),
chk_oversell AS (
  SELECT 'f_stock_oversold', concat("productId", '@', "warehouseId"),
         'running onHand >= 0 and available >= 0',
         concat('first breach at ', min("createdAt"), ' min onHand=', min(run_on_hand), ' min available=', min(run_available))
  FROM running WHERE run_on_hand < 0 OR run_available < 0
  GROUP BY "productId", "warehouseId"
),
-- (c) Customer.cachedBalance vs. ledger formula.
inv AS (
  SELECT "customerId", SUM("total") AS invoiced FROM "Invoice" WHERE "status" <> 'CANCELLED' GROUP BY "customerId"
),
alloc_live AS (
  SELECT i."customerId", SUM(pa."amount") AS allocated
  FROM "PaymentAllocation" pa
  JOIN "Invoice" i ON i."id" = pa."invoiceId" AND i."status" <> 'CANCELLED'
  JOIN "Payment" p ON p."id" = pa."paymentId" AND p."status" = 'POSTED'
  GROUP BY i."customerId"
),
posted AS (
  SELECT "customerId", SUM("amount") AS posted FROM "Payment" WHERE "status" = 'POSTED' GROUP BY "customerId"
),
applied_own AS (
  SELECT p."customerId", SUM(pa."amount") AS applied
  FROM "PaymentAllocation" pa
  JOIN "Payment" p ON p."id" = pa."paymentId" AND p."status" = 'POSTED'
  JOIN "Invoice" i ON i."id" = pa."invoiceId" AND i."status" <> 'CANCELLED'
  GROUP BY p."customerId"
),
ledger AS (
  SELECT c."id", c."cachedBalance",
    COALESCE(inv.invoiced, 0) - COALESCE(al.allocated, 0)
      - (COALESCE(po.posted, 0) - COALESCE(ao.applied, 0)) AS balance
  FROM "Customer" c
  LEFT JOIN inv ON inv."customerId" = c."id"
  LEFT JOIN alloc_live al ON al."customerId" = c."id"
  LEFT JOIN posted po ON po."customerId" = c."id"
  LEFT JOIN applied_own ao ON ao."customerId" = c."id"
),
chk_balance AS (
  SELECT 'c_customer_balance_drift', "id"::text, balance::text, "cachedBalance"::text
  FROM ledger WHERE balance <> "cachedBalance"
),
-- (d) allocations never exceed the payment, nor (valid ones) the invoice.
chk_alloc AS (
  SELECT 'd_payment_over_allocated', p."id"::text, concat('<= ', p."amount"), SUM(pa."amount")::text
  FROM "Payment" p JOIN "PaymentAllocation" pa ON pa."paymentId" = p."id"
  GROUP BY p."id", p."amount" HAVING SUM(pa."amount") > p."amount"
  UNION ALL
  SELECT 'd_invoice_over_allocated', i."id"::text, concat('<= ', i."total"), SUM(pa."amount")::text
  FROM "Invoice" i
  JOIN "PaymentAllocation" pa ON pa."invoiceId" = i."id"
  JOIN "Payment" p ON p."id" = pa."paymentId" AND p."status" = 'POSTED'
  GROUP BY i."id", i."total" HAVING SUM(pa."amount") > i."total"
),
-- (e) append-only guards survived the restore: AuditLog (+ the ledgers)
-- triggers present and enabled, and the guard function exists.
expected_triggers(tbl, tg) AS (
  VALUES ('AuditLog', 'audit_log_no_update'), ('AuditLog', 'audit_log_no_delete'), ('AuditLog', 'audit_log_no_truncate'),
         ('StockMovement', 'stockmovement_no_update'), ('StockMovement', 'stockmovement_no_delete'), ('StockMovement', 'stockmovement_no_truncate'),
         ('Payment', 'payment_guard_update'), ('Payment', 'payment_no_delete'), ('Payment', 'payment_no_truncate'),
         ('PaymentAllocation', 'paymentallocation_no_update'), ('PaymentAllocation', 'paymentallocation_no_delete'),
         ('PaymentAllocation', 'paymentallocation_no_truncate')
),
chk_triggers AS (
  SELECT 'e_append_only_trigger', concat(e.tbl, '.', e.tg), 'present+enabled',
         COALESCE('tgenabled=' || t.tgenabled::text, 'missing')
  FROM expected_triggers e
  LEFT JOIN pg_trigger t ON t.tgname = e.tg AND t.tgrelid = to_regclass(format('public.%I', e.tbl)) AND NOT t.tgisinternal
  WHERE t.oid IS NULL OR t.tgenabled NOT IN ('O', 'A')
  UNION ALL
  SELECT 'e_audit_guard_function', 'prevent_audit_log_mutation()', 'present', 'missing'
  WHERE to_regprocedure('public.prevent_audit_log_mutation()') IS NULL
)
SELECT * FROM chk_rls
UNION ALL SELECT * FROM chk_stock
UNION ALL SELECT * FROM chk_oversell
UNION ALL SELECT * FROM chk_balance
UNION ALL SELECT * FROM chk_alloc
UNION ALL SELECT * FROM chk_triggers
ORDER BY 1, 2;
