# Restore drill 2026-11-02

- Verdict: **PASS**
- Started (UTC): 2026-11-02T11:34:51Z; finished: 2026-11-02T11:35:04Z
- Source of dump: DUMP_FILE velto-db-20261102-163447.dump.gpg
- Target: separate database `velto_restore_drill_synth2_20261102` on localhost:5433 (dropped afterwards unless DRILL_KEEP_DB=1); source DB not modified.
- **RTO measured**: restore (create + pg_restore + provision-roles) = 9 s; full drill incl. dump and all checks = 12 s. Dataset size: 660K dump — NOT representative of production volume; re-measure on production-sized data. Target RTO <= 4 h.
- RPO: daily backup only (pilot); WAL/PITR for GA is plan-only, see docs/ops/wal-pitr-plan.md.

| Check | Status | Detail |
|---|---|---|
| dump ready | PASS | DUMP_FILE velto-db-20261102-163447.dump.gpg (660K) |
| pg_restore | PASS | restored into velto_restore_drill_synth2_20261102 (version-skew SET transaction_timeout lines ignored: 2) |
| provision-roles.sql | PASS | owner/app/system roles + grants applied |
| prisma migrate status | PASS | schema up to date |
| _prisma_migrations == repo | PASS | 46 migrations identical, 0 failed/rolled back |
| invoice total = sum(lines) | PASS | mismatch/total = 0/282 |
| RLS FORCE (relforcerowsecurity) | PASS | 49 tables ENABLE+FORCE; all companyId tables covered |
| table row counts vs source | PASS | 50 tables identical to live (quiescent) source |
| StockLevel = sum(StockMovement) | PASS | mismatch/total = 0/120 |
| allocation sums (live payments) | PASS | over-allocated payments/invoices/allocations = 0/0/195 |
| AuditLog continuity | PASS | rows=1 unique, range 2026-11-02 11:34:14.918 .. 2026-11-02 11:34:14.918 equals live source |
| AuditLog append-only trigger | PASS | UPDATE rejected by DB trigger |
| tenant isolation smoke (velto_app) | PASS | bare select=0, foreign tenant=0, own tenant=80 of 80 |

## Row counts (table=rows, restored DB)
```
AuditLog=1
CashSession=0
Company=1
Customer=80
DocumentCounter=3
ExportJob=0
GoodsReceipt=0
GoodsReceiptLine=0
IdempotencyRecord=0
ImportJob=0
Invoice=282
InvoiceLine=861
MfaEnrollmentCode=0
Notification=0
OpeningBalanceBatch=0
OutboxEvent=0
Outlet=93
Payment=195
PaymentAllocation=195
PaymentIntentResolution=0
PaymentReversal=0
Permission=57
PriceList=2
PriceListItem=240
Product=120
ProductCategory=5
ProductPackaging=360
PurchaseOrder=0
PurchaseOrderLine=0
ReconciliationFinding=0
ReconciliationRun=0
RefreshToken=0
Role=7
RolePermission=130
Route=5
RouteRun=0
RouteStop=93
SalesOrder=282
SalesOrderLine=861
StockLevel=120
StockMovement=1842
Supplier=3
SyncTombstone=0
Tenant=1
User=7
UserMfa=0
UserMfaRecoveryCode=0
UserRole=7
Visit=365
Warehouse=1
```
