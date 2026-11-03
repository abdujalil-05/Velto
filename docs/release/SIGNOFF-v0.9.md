# Pilot (v0.9) sign-off - TZ 16.5

Rule: an unsigned row (empty approver, date, build SHA or a status other than SIGNED) is a **release blocker**. Evidence must be a real path/URL to the test artifact. A failing manual test cannot be overridden by "unit coverage is high".
The developer does NOT sign the Accounting row: it is signed only by the Customer Accountant. Developers/agents leave approver, date and build SHA empty.

| Row | Evidence (path / URL) | Approver | Date | Build SHA | Status |
|---|---|---|---|---|---|
| Product | order-to-office walk-through record; critical flow demonstrated, not mocked: `docs/qa/` (fill in artifact path) | | | | UNSIGNED |
| Accounting | 30-document reconciliation + 1C importer acceptance; latest `docs/ops/restore-drill-<date>.md`; reconciliation report (fill in paths) - signed ONLY by the Customer Accountant | | | | UNSIGNED |
| Security | RLS tenant-isolation test run (CI artifact), P0 negative suite, secret + dependency scan results (CI run URL), `docs/security/risk-acceptance.md` (fill in) | | | | UNSIGNED |

Status values: UNSIGNED -> SIGNED (only when approver, date and build SHA are all filled). Any P0 red item blocks the release.
