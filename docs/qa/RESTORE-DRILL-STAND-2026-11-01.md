# Restore drill 2026-11-01

- Verdict: **PASS**
- Started (UTC): 2026-11-01T13:15:41Z; finished: 2026-11-01T13:15:52Z
- Source of dump: fresh pg_dump -Fc of source (exported snapshot)
- Target: separate database `velto_restore_drill_stand` on localhost:5433 (dropped afterwards unless DRILL_KEEP_DB=1); source DB not modified.
- **RTO measured**: restore (create + pg_restore + provision-roles) = 5 s; full drill incl. dump and all checks = 11 s. Dataset size: 356K dump — NOT representative of production volume; re-measure on production-sized data. Target RTO <= 4 h.
- RPO: daily backup only (pilot); WAL/PITR for GA is plan-only, see docs/ops/wal-pitr-plan.md.

| Check | Status | Detail |
|---|---|---|
| dump ready | PASS | fresh pg_dump -Fc of source (exported snapshot) (356K) |
| pg_restore | PASS | restored into velto_restore_drill_stand (version-skew SET transaction_timeout lines ignored: 2) |
| provision-roles.sql | PASS | owner/app/system roles + grants applied |
| prisma migrate status | PASS | schema up to date |
| RLS FORCE (relforcerowsecurity) | PASS | 48 tables ENABLE+FORCE; all companyId tables covered |
| table row counts vs source | PASS | 49 tables identical |
| StockLevel = sum(StockMovement) | PASS | mismatch/total = 0/5 |
| allocation sums (live payments) | PASS | over-allocated payments/invoices/allocations = 0/0/4 |
| AuditLog continuity | PASS | rows=119 unique, range 2026-11-01 11:48:10.498 .. 2026-11-01 13:04:36.742 equals source |
| AuditLog append-only trigger | PASS | UPDATE rejected by DB trigger |
| tenant isolation smoke (velto_app) | PASS | bare select=0, foreign tenant=0, own tenant=3 of 4 |

## Row counts (table=rows, restored DB)
```
AuditLog=119
CashSession=0
Company=2
Customer=4
DocumentCounter=4
ExportJob=4
GoodsReceipt=0
GoodsReceiptLine=0
IdempotencyRecord=0
ImportJob=5
Invoice=4
InvoiceLine=8
MfaEnrollmentCode=2
Notification=0
OpeningBalanceBatch=0
OutboxEvent=0
Outlet=4
Payment=2
PaymentAllocation=4
PaymentReversal=0
Permission=57
PriceList=4
PriceListItem=6
Product=6
ProductCategory=1
ProductPackaging=6
PurchaseOrder=0
PurchaseOrderLine=0
ReconciliationFinding=0
ReconciliationRun=0
RefreshToken=27
Role=14
RolePermission=260
Route=0
RouteRun=0
RouteStop=0
SalesOrder=29
SalesOrderLine=33
StockLevel=5
StockMovement=21
Supplier=0
SyncTombstone=0
Tenant=2
User=8
UserMfa=2
UserMfaRecoveryCode=20
UserRole=8
Visit=0
Warehouse=2
```
