# Commercial GA (v1.0) sign-off matrix - TZ 16.5

Rule: every row needs the authorised approver, date, build SHA and a test artifact URL/path. **An unsigned row is a release blocker.** No P0 red item. A failing manual test cannot be overridden by "unit coverage is high". GA feature claims must match demonstrated outcomes on the supported deployment.
The developer does NOT sign the Accounting row (only the Customer Accountant). Approver, Date and Build SHA are intentionally empty until signed by the named role.

| Row | Evidence (path / URL; fill in) | Authorised approver (role) | Approver | Date | Build SHA | Status |
|---|---|---|---|---|---|---|
| Legal & data | inventory/DPA/vendor register, pilot goods scope, approved disclaimers | Legal reviewer + PO | | | | UNSIGNED |
| Business | order-to-office walk-through, master mapping, 14-day adoption | Customer Owner + PO | | | | UNSIGNED |
| Accounting | 30-document reconciliation, 1C importer acceptance | Customer Accountant | | | | UNSIGNED |
| Inventory | concurrency race test, stock journal replay | Warehouse Owner + Tech Lead | | | | UNSIGNED |
| Security | RLS app-user tests, pentest/high findings, auth token test | Security owner / Tech Lead | | | | UNSIGNED |
| Offline | device support matrix, 20 orders, retry/restart/conflict scenarios | Field Operations + QA | | | | UNSIGNED |
| Operations | staged restore drill (`docs/ops/restore-drill-<date>.md`), RPO/RTO measured, log alerts, incident on-call contact | Ops owner | | | | UNSIGNED |
| Customer success | import how-to, Uzbek/Russian help, trial expiry/export policy | Customer Success | | | | UNSIGNED |

Blocker examples per row are in TZ 16.5 (e.g. Operations: no verified restore or no incident contact; Operations RPO <= 15 min requires WAL/PITR, see `docs/ops/wal-pitr-plan.md`, otherwise GA claims only daily backup).
