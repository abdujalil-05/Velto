---
name: velto-qa
description: Velto P0 acceptance lists, test strategy and NFR numbers from TZ v4.0 §8.5, §10.5, §16–17; preloaded by qa-engineer.
---

# Test types (§17)
Unit (price/VAT/discount, balance, FIFO, state transitions, GPS distance, permission policy) · Integration on real Postgres+RLS (reservation, allocation, import/export, outbox) · E2E order→confirm→issue→invoice→payment→report · Offline · Security (cross-tenant, RBAC, IDOR, XSS/CSRF, auth replay) · Load · Backup/restore · UI/a11y. Conventions: service tests instantiate with `new` against real `systemPrisma`/`withTenant`; only `apps/api/test/order-flow.e2e.test.ts` style uses `Test.createTestingModule` (needs SWC plugin).

# P0 business (§16.1)
onboarding+import · 1000 customers/2000 products preview + error rows + idempotent re-import · 5-line order recomputed server-side · confirm reserves atomically · 2 parallel confirms don't oversell · issue = movement + status together · invoice = order snapshot, overpay ⇒ advance · 1 500 000 FIFO over 3 invoices · reversal keeps originals · aging as-of · visit/route completion server-checked, GPS results distinct · report filters = export · 1C accepted by accountant.
# P0 offline (§8.5/§16.2)
airplane-mode local save · 20 offline orders → 20 unique clientIds · triple resend = 1 doc · mid-sync cut resumes without dupes · stale price/stock conflict shown, value never silently changed · cache cleanup can't delete pending · logout/revoke/quota-full handled.
# P0 security (§16.3)
Tenant A cannot reach B by ID swap/query/export/file link · RLS tested with app role · unauthorised ⇒ 403 + audit event · refresh reuse ⇒ family revoked · initData valid/invalid/expired/replayed · mutations idempotent under parallel calls · no secrets in repo/response/logs.
# NFR numbers (§12.1)
list/detail p95 ≤300 ms and mutation p95 ≤700 ms at 50 concurrent agents; dashboard ≤2 s; load test 100 concurrent agents on demo data without errors.

Rules: never skip/weaken a P0 test; synthetic data only; race tests use real parallelism and assert the invariant; name tests after the TZ requirement.
