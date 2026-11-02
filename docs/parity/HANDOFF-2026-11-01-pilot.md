# Handoff 2026-11-01 — v0.9 financial risks

> **2026-11-02 update:** committed `5678c1d` (payments) + `3be662f` (turnover by delivery date = MIN SALE Invoice.createdAt), pushed, CI run 41322829998 success. Matrix PASS 10 / FAIL 0 / BLOCKED_EXTERNAL 9 / NOT_TESTED 11. Old stand (pid 1660/4303) is gone; `velto-stand-redis` container exited, not removed; `velto_stand_smoke` DB not dropped. Sections below are history.

> Separate file on purpose: `HANDOFF-2026-10-31.md` and `HANDOFF-2026-11-01.md` hold someone else's uncommitted changes. Do not touch them (or `docs/security/risk-acceptance.md`).
> Branch `feat/approved-decisions`, HEAD `86c1c63`. Draft PR #1 stays Draft. No merge/deploy/pilot.

## Done (uncommitted)
- **P0 legacy payment idempotency** (finance-stock, 113/113 in 5 files, isolated): `payments.service.ts` findReplay (:236): provable Payment columns differ → 409 `PAYMENT_IDEMPOTENCY_CONFLICT`; allocation mode unprovable → new 409 `PAYMENT_IDEMPOTENCY_UNVERIFIABLE` (`finance-exceptions.ts:269`, uz/ru/en, manual reconciliation, details `{clientId}`); otherwise full compare. `create()` now writes `createRequest:{allocations|null}` in audit `payment.create` (:219, new payments only, no backfill). `payment-replay.ts:26` `isSamePaymentColumns`. Bug fixed: `sync.service.ts:409` P2002 path turned the conflict into RETRY → now REJECTED. No other immutable source for legacy found. **For PO:** payments with 0 allocations created between `841e56d` and this change → UNVERIFIABLE on replay (safe side). Web `payments/new/page.tsx:52` and miniapp `queue-view.ts:79` show the server text for the new code (no dedicated hint; FAILED is terminal, no false success).
- **P0 turnover** (architect audit → finance-stock): defect confirmed. `COUNTED` (SUBMITTED, CONFIRMED, DELIVERED, CLOSED; SHIPPED excluded) → `TURNOVER_STATUSES=[DELIVERED,CLOSED]`, delivered amount only (`report-utils.ts:112`, `report-sql.ts`, `agent-performance.service.ts:35` now uses the shared SQL, `report-tables.ts` export note). Reproduced: `turnover-rule.test.ts` 218600 vs 68600. sales = overview = dashboard trend = agents = CSV/XLSX. analytics 46/46 (`analytics.service.test.ts:369` known flaky). Date is still `SalesOrder.createdAt` → **PO question** (delivery date?). Reviewer PASS (LOW labels fixed).
- i18n: web `messages/{uz,ru,en}.json` labels "delivered turnover/orders" (Dashboard 164-173, Reports 918-939, info 964-967, agents 989-990); miniapp `Home.ordersTotalToday` (messages :23, `agent-home.tsx:114`) "orders total today", calculation unchanged.
- Notifications: 0 rows is expected (smoke did no reversal/adjust). Already covered: `owner-alerts.test.ts:94` (foreign OWNER never), `owner-alerts-order-flow.test.ts:69`, `owner-alerts-audit.test.ts`. No new test.
- MinIO: still **BLOCKED_EXTERNAL**. `docker manifest inspect minio/minio:*` → denied (Docker Hub), `quay.io/minio/minio:*` → no such manifest; no local image, no minio/mc binary. `docker-compose.yml:39` TODO. The provider was not changed.
- Restore drill on a copy of `velto_stand_smoke`: PASS 11/11, RTO 5s → `docs/qa/RESTORE-DRILL-STAND-2026-11-01.md` (no gpg/offsite/prod volume).
- E2E protocol copied to `docs/qa/E2E-SMOKE-2026-11-01.md`; stand logs in scratchpad `4b4d0c68…/scratchpad/stand-logs/`.

## Running (results not received yet)
- reviewer (payments diff): **PASS**, no HIGH/MED. 2 LOW test gaps → give them to qa-engineer before checks: (1) `sync.service.test.ts:~478` P2002 test mocks `payments.create`; add an assert that the rejection audit is written on that path; (2) `payments.service.test.ts:~288-403` add a test: new agent PENDING_HANDOVER payment (0 allocations, with createRequest) → identical replay returns the original, different one → CONFLICT.
- security-auditor (whole diff): **PASS**, 0 findings (owner-check comes before CONFLICT/UNVERIFIABLE, so there is no oracle; tenant tx; SQL is parameterized; RBAC unchanged).

## Running after "Continue" (results not received yet)
- qa-engineer: 3 tests WRITTEN, **NOT RUN** (the Docker daemon is stopped, so test-isolated.sh cannot start). Only tsc is clean. `sync.service.test.ts:~510` (P2002 CONFLICT/UNVERIFIABLE + rejection audit; real race of 5 parallel pushes), `payments.service.test.ts:~288` (agent PENDING_HANDOVER replay/conflict). After Docker starts: `scripts/test-isolated.sh -- --filter=@velto/api -- run --no-file-parallelism src/modules/finance/payments/payments.service.test.ts src/modules/sync/sync.service.test.ts`, then the full checks.
- DONE: `docs/release/PILOT-READINESS-MATRIX.md` (30 conditions: PASS 8 / FAIL 0 / BLOCKED_EXTERNAL 9 / NOT_TESTED 13, "v0.9 pilot: NOT allowed"; row 11 needs the CI run id after push), STATUS.md 49 lines, link in PILOT-RELEASE-CONDITIONS:5.
- Next after them: step 2 below (checks), then 4–5.

## Stand (still running, owned by the previous qa run)
API pid 1660 (`node dist/main.js`, cwd apps/api, :3031), s3stub pid 4303 (:9010), container `velto-stand-redis` :6390, DB `velto_stand_smoke` on velto-postgres-1:5433 (synthetic, disposable). Cleanup only by exact pid/name: `kill 1660 4303; docker rm -f velto-stand-redis; psql postgresql://velto:velto@localhost:5433/postgres -c 'DROP DATABASE velto_stand_smoke'` (the DROP needs a separate confirmation). Do not touch ruscha-local-*, velto_dev.

## Next
1. Collect reviewer/security results → fixes.
2. `checks`: full isolated suite (`scripts/test-isolated.sh`), lint/typecheck/build, audit.
3. `docs/release/PILOT-READINESS-MATRIX.md` (PASS/FAIL/BLOCKED_EXTERNAL/NOT_TESTED) from `PILOT-RELEASE-CONDITIONS.md`, + STATUS.md.
4. Commit only our files (not the 3 files listed above) → push feature branch → CI (test, Semgrep, gitleaks) on the new SHA.
5. Final report in Russian (task items 1–9).
