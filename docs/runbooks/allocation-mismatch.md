# Invoice / payment allocation mismatch (customer balance drift)
- **Detection:** `GET /reconciliation/findings` kind `BALANCE` OPEN; restore-drill check "allocation sums (live payments)": for POSTED/PENDING_HANDOVER payments, sum(`PaymentAllocation`) <= `Payment.amount` and per invoice <= `Invoice.total` (allocations of REVERSED payments are excluded). Alert: (planned).
- **Severity:** SEV2 (financial integrity; blocks Accounting sign-off).
- **Triage:** 1) `POST /reconciliation/run`. 2) Compare the customer's invoices, payments, `PaymentAllocation`, `PaymentReversal` and `AuditLog` for the entity. 3) Check for a recent payment/reversal on the same `traceId` and for double submit (idempotency key / `clientId`).
- **Data safety:** Payment and ledger rows are append-only sources of truth: correct only with reversals through the application, never by UPDATE/DELETE in SQL. The projection is repaired with `POST /reconciliation/findings/:id/fix` (BALANCE; permission `reconciliation.fix`, audited). Backup first for bulk.
- **Owner:** Customer Accountant (business decision) + Tech Lead.
- **Verification:** finding closed after a new run; customer balance = sum(invoices) - sum(live allocations) - advances; Accountant confirms on a 30-document sample.
- **Comms:** Customer Accountant informed with the list of affected customers/documents and the corrective documents created.
