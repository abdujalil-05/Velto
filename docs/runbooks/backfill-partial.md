# Backfill / bulk import partial
Covers data backfills, `ImportJob` (CSV/XLSX import) and opening balances (`/opening-balances`) that stop half-way.
- **Detection:** `ImportJob` in `FAILED`/stuck `PROCESSING` (`GET /import`), `OpeningBalanceBatch` not completed, row counts lower than the file.
- **Severity:** SEV3 (SEV2 if tenant go-live depends on it).
- **Triage:** 1) Read the job `errorLog`/row errors. 2) Is it a stuck job? see stuck-jobs.md. 3) Decide: resume (if the importer is idempotent by key) or void. Opening stock/balances are bulk-voidable through the application (reversal rows, audited); do not delete rows.
- **Data safety:** Backup before any manual repair. All writes go through the application / `withTenant`; one-off scripts run on a restored copy first, as `velto_system`, in a transaction, with before/after counts recorded. AuditLog and StockMovement are append-only.
- **Owner:** Integrations owner + Customer Accountant for balances.
- **Verification:** counts match the source file; `POST /reconciliation/run` clean; opening balances re-checked by the Accountant.
- **Comms:** Tell the customer which rows were applied/voided and the re-import plan.
