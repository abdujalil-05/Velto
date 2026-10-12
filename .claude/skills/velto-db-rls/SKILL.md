---
name: velto-db-rls
description: Velto data-model, RLS and migration rules from TZ v4.0 §6/§10; preloaded by the db-rls subagent.
---

# New tenant-scoped table checklist (non-negotiable, §10.4)
1. UUID PK, `companyId` (or parent-subquery policy), `createdAt`, `updatedAt` where needed, `createdBy`/`updatedBy` where useful. 2. RLS policy + `FORCE ROW LEVEL SECURITY` in a new migration. 3. Case in `tenant-isolation.test.ts` run with the app role (not owner/superuser). 4. Cross-company relation validation (an order cannot link another company's customer/product/invoice/warehouse). 5. Scoped unique `clientId`/idempotency key where clients create it.

# Data rules (§6.1)
Money Decimal(18,2), qty Decimal(18,3), pct Decimal(5,2); never Float. Documents snapshot name/SKU/unit/price/VAT/discount at creation. No hard delete of documents or financial rows — reversal/correction. Stock and balance truth = append-only movement/ledger; projections (`StockLevel`, `cachedBalance`) must be rebuildable and drift-detectable. Times stored UTC; company timezone default `Asia/Tashkent`.

# Doc numbers & concurrency (§6.3, §10.5)
`SO|INV|PAY|PO-{YYYY}-{6 digits}` from transaction-safe `DocumentSequence` (company+type+year); cancelled numbers are never reused. Reservation/allocation/transition protected by `SELECT … FOR UPDATE` or serializable tx; no long transactions.

# Migrations (§17)
Forward-only, backward-compatible, never edit committed ones. Destructive drop = separate release + backup + recovery plan. Pool must not leak `app.current_company_id` between requests (test it). Roles: `velto_owner` (owns objects, runs migrations via `DATABASE_MIGRATE_URL`, NOBYPASSRLS), `velto_app` (runtime DML only, NOBYPASSRLS), none superuser; `velto_system` (BYPASSRLS, DML) only for login/provisioning/cross-tenant jobs.

# Roles (§4, ADR-003)
OWNER, SALES_DIRECTOR, SALES_AGENT, WAREHOUSE, CASHIER, ACCOUNTANT (+ PLATFORM_ADMIN separate). Audit seed/DB for ACCOUNTANT before changing; never delete an existing role; add via backward-compatible migration + permission tests. ACCOUNTANT cannot edit posted payments/invoices/stock movements. Catalog is single-sourced in `src/rbac-catalog.ts` (seed + bootstrap-owner import it); seed refuses production. Repo also has COURIER (not in TZ) — pending decision, see docs/STATUS.md.
