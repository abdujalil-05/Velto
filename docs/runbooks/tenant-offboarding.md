# Tenant offboarding / DSR (ADR-045, TZ §11.7.2)

Short runbook. Not legal advice. Values marked PENDING are decided by the legal memo (§11.7.2) and must not be guessed.

## 1. Export (customer self-service)
1. The company OWNER (only role with `company.export`) opens the export page and starts `POST /company-export` (max 1 per minute, 1 active per company).
2. Worker builds one multi-sheet XLSX (customers, outlets, products, price lists, stock, orders, invoices incl. OPENING, payments + allocations, users without credentials, opening batches, warehouses, stock movements, payment reversals, cash sessions, suppliers, purchase orders + lines, goods receipts + lines, routes + stops, visits). A sheet over 1 048 576 rows continues in `<name>_2`, `<name>_3`.... Poll `GET /company-export/:id` until `GENERATED`.
3. Download only through `GET /company-export/:id/download` (API proxy, audited as `company.export.download`). Verify `X-Content-SHA256` against `fileHash`.
4. Failures are visible in `errorLog`; retry is automatic (3 attempts, backoff); stuck jobs are failed by the sweep, then the OWNER can start a new export.

### Not covered by the export (list for the offboarding ticket)
AuditLog, OutboxEvent, ImportJob/ExportJob history, Notification, sessions/refresh tokens/Telegram bindings (credentials, intentionally excluded), stock reconciliation findings, order/invoice/payment auxiliary tables not listed above (e.g. route runs, packagings, document counters), uploaded files. Provide on request via a reviewed one-off query; do not claim the XLSX is a full DB dump.

## 2. Customer confirmation
Record the OWNER's written confirmation that the export is complete and received (ticket id + `fileHash`). No deletion starts without it.

## 3. Retention before deletion
- Posted financial documents and audit log retention period: PENDING legal memo (§11.7.2). Value and legal basis are not set here.
- There is no "delete all" API endpoint by design. Posted ledger/audit data is never silently overridden.

## 4. Deletion (operator only, after retention expires)
- Run a reviewed one-off script as the `velto_system` role (BYPASSRLS), per tenant, in a transaction on a restored copy first. AuditLog is append-only (trigger): its handling follows the legal memo.
- Also remove the tenant's objects under `exports/1c/<companyId>/` and `exports/company/<companyId>/`, and backups per the vendor registry deletion mechanism.
- Record who ran it, when, and the row counts in the offboarding ticket.
