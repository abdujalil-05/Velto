# Restore drill 2026-10-19

- Verdict: **PASS**
- Started (UTC): 2026-10-19T17:38:35Z; finished: 2026-10-19T17:40:53Z
- Source of dump: fresh pg_dump -Fc of source (exported snapshot)
- Target: separate database `velto_restore_drill` on localhost:5433 (dropped afterwards unless DRILL_KEEP_DB=1); source DB not modified.
- **RTO measured**: restore (create + pg_restore + provision-roles) = 106 s; full drill incl. dump and all checks = 138 s. Dataset size: 161M dump — NOT representative of production volume; re-measure on production-sized data. Target RTO <= 4 h.
- RPO: daily backup only (pilot); WAL/PITR for GA is plan-only, see docs/ops/wal-pitr-plan.md.

| Check | Status | Detail |
|---|---|---|
| dump ready | PASS | fresh pg_dump -Fc of source (exported snapshot) (161M) |
| pg_restore | PASS | restored into velto_restore_drill (version-skew SET transaction_timeout lines ignored: 2) |
| provision-roles.sql | PASS | owner/app/system roles + grants applied |
| prisma migrate status | PASS | schema up to date |
| RLS FORCE (relforcerowsecurity) | PASS | 45 tables ENABLE+FORCE; all companyId tables covered |
| table row counts vs source | PASS | 46 tables identical |
| StockLevel = sum(StockMovement) | PASS | restore faithful: mismatch/total 1090/155185 identical to SOURCE (pre-existing drift accepted by DRILL_ALLOW_SOURCE_DRIFT=1; dev/test data only) |
| allocation sums (live payments) | PASS | over-allocated payments/invoices/allocations = 0/0/12157 |
| AuditLog continuity | PASS | rows=161747 unique, range 2026-10-12 14:53:48.547 .. 2026-10-19 17:38:34.742 equals source |
| AuditLog append-only trigger | PASS | UPDATE rejected by DB trigger |
| tenant isolation smoke (velto_app) | PASS | bare select=0, foreign tenant=0, own tenant=3019 of 524051 |

## Row counts (table=rows, restored DB)
```
AuditLog=161747
CashSession=1582
Company=13739
Customer=524051
DocumentCounter=3754
ExportJob=5127
GoodsReceipt=1491
GoodsReceiptLine=1491
IdempotencyRecord=1365
ImportJob=2949
Invoice=194045
InvoiceLine=20865
Notification=2385
OpeningBalanceBatch=1170
OutboxEvent=0
Outlet=200058
Payment=61463
PaymentAllocation=12157
PaymentReversal=18384
Permission=54
PriceList=1429
PriceListItem=3318
Product=834568
ProductCategory=2616
ProductPackaging=179775
PurchaseOrder=1622
PurchaseOrderLine=1753
ReconciliationFinding=2559
ReconciliationRun=30214
RefreshToken=11853
Role=9145
RolePermission=121202
Route=4550
RouteRun=1099
RouteStop=5174
SalesOrder=32783
SalesOrderLine=38635
StockLevel=155052
StockMovement=375652
Supplier=317
SyncTombstone=3573
Tenant=13549
User=20506
UserRole=10177
Visit=6188
Warehouse=4237
```
