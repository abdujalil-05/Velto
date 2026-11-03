# Permission backfill — dry-run on velto_dev, 2026-11-03

Script: `pnpm --filter @velto/database exec tsx src/backfill-assign-courier.ts` (dry-run by default, no `--apply`).
Target was checked before the run: `DATABASE_SYSTEM_URL` → role `velto_system`, `localhost:5433/velto_dev` (local docker `velto-postgres-1`).
This file holds aggregated counts only: no company names, no ids, no secrets. The raw output stayed out of the repo.

| Item | Value |
|---|---|
| Companies scanned | 3921 (mostly leftovers from earlier test runs) |
| Companies diverging from catalog | 1383 |
| Permission rows to create | 3: `orders.assignCourier`, `orders.dispatch`, `orders.returnToWarehouse` |
| Grants to add | 3408 |
| Grants to revoke | 2 (`WAREHOUSE:orders.update`, per PO SoD decision) |

Grants to add, by role and key: OWNER × {assignCourier, dispatch, returnToWarehouse} = 988 each. SALES_DIRECTOR × {assignCourier, cancel, returnToWarehouse} = 146 each. WAREHOUSE × {assignCourier, dispatch, returnToWarehouse} = 2 each.

Verification after the run: `select count(*) from "Permission" where code in (...)` = 0, so nothing was written.
`--apply` was not run on velto_dev (PO: forbidden for now). `--apply` was exercised only by the backfill tests on the isolated test stack (:5435). There, a second `--apply` made 0 changes (3 runs, 104/104).
