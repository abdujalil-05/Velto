# Degraded mode: Redis / queue down
- **Detection:** `GET /health/ready` shows `redis: down` (API process still live); enqueue timeouts (`QUEUE_ENQUEUE_TIMEOUT_MS`, so requests never hang); BullMQ errors in `pm2 logs velto-api`. Redis alert: (planned).
- **Severity:** SEV2 (core order/stock/payment flow works; background jobs and anything using Redis degrade).
- **Triage:** 1) Redis process/memory (`redis-cli ping` on the VPS). 2) Restart Redis; then API reconnects (restart `velto-api` if it does not).
- **Data safety:** DB is the source of truth. What degrades: 1C/company exports and imports stay `QUEUED` (rows are durable; the sweep re-enqueues after recovery - see stuck-jobs.md), reconciliation schedule pauses, login rate limiting/replay counters may be unavailable. Core sales/stock/payment writes do not depend on the queue. Do not disable auth limits to compensate. Maintenance mode (maintenance-mode.md) can be used if write paths misbehave.
- **Owner:** Ops owner.
- **Verification:** `/health/ready` 200; queued ExportJobs drain; run `POST /reconciliation/run`.
- **Comms:** Tell users exports/imports are delayed, not lost.
