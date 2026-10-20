# Runbooks (TZ 12.5)

Each runbook has the 7 mandatory fields: Detection, Severity, Triage, Data safety, Owner (role only), Verification, Comms.
Rule: only mechanisms that exist in the repo are named. Anything not implemented is marked **(planned)**.
Common facts: process `velto-api` under PM2, API on `127.0.0.1:3101` behind nginx `/velto/api/`; liveness `GET /health/live`, readiness `GET /health/ready`
(DB + Redis; `GET /health` is the legacy combined check); logs `pm2 logs velto-api`; every request/job carries a `traceId` (TZ 12.3).
No alerting stack is committed yet: all "alert" conditions below are **(planned)** until monitoring is wired; today detection = health probe, `pm2 logs`, and the in-app reconciliation/job tables.
Production commands are run by the operator (never by CI or an agent).

| Runbook | Scenario |
|---|---|
| [db-unavailable](db-unavailable.md) | Postgres down / connections exhausted |
| [stale-1c](stale-1c.md) | 1C export stale / not acknowledged |
| [sync-backlog](sync-backlog.md) | offline sync queue backing up |
| [stuck-jobs](stuck-jobs.md) | stuck outbox/job = QUEUED/PROCESSING sweep |
| [telegram-login-failures](telegram-login-failures.md) | Mini App login failing |
| [stock-mismatch](stock-mismatch.md) | StockLevel != sum(StockMovement) |
| [allocation-mismatch](allocation-mismatch.md) | invoice/payment allocation or balance drift |
| [bot-token-leak](bot-token-leak.md) | Telegram bot token / webhook secret leaked |
| [migration-fail](migration-fail.md) | production `prisma migrate deploy` failed |
| [backfill-partial](backfill-partial.md) | data backfill/import stopped half-way |
| [degraded-redis](degraded-redis.md) | Redis/queue down (degraded mode) |
| [maintenance-mode](maintenance-mode.md) | `READ_ONLY_MODE` |
| [restore-drill](restore-drill.md) | backup restore drill |
| [tenant-offboarding](tenant-offboarding.md) | export/deletion (ADR-045) |
