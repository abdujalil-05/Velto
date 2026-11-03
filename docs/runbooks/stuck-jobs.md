# Stuck outbox / background job (QUEUED sweep)
In this codebase "outbox/jobs" are BullMQ jobs run in-process in `apps/api` with durable rows in `ExportJob` (1C export, company export) and `ImportJob`. `OutboxEvent` rows have `processedAt`; a dedicated consumer was not verified - treat unprocessed OutboxEvent as **(planned)** monitoring.
- **Detection:** `ExportJob`/`ImportJob` rows `QUEUED` or `PROCESSING` longer than 15 min (`updatedAt`); user cannot start a new export ("active job limit"). Worker-backlog alert: (planned).
- **Severity:** SEV3.
- **Triage:** 1) Redis healthy? (`/health/ready`; if not see degraded-redis.md). 2) The recovery sweep (`export-1c-recovery.service`, every 5 min) re-enqueues orphaned `QUEUED`, fails jobs abandoned > `ABANDONED_QUEUED_MS` (QUEUED -> PROCESSING -> FAILED, audited) and stale `PROCESSING`. 3) If the sweep itself is not running: `pm2 restart velto-api` (jobs are durable; retry 3x with backoff).
- **Data safety:** Jobs are idempotent snapshots; never hand-edit `status` in SQL (DB trigger enforces legal transitions). Do not flush Redis blindly - rows are the source of truth, but in-flight attempts are lost.
- **Owner:** Integrations owner.
- **Verification:** stuck row reaches `DONE`/`FAILED`; the user can start a new job; no leftover `QUEUED` older than 15 min.
- **Comms:** Only if a customer-visible deliverable (1C export / company export) was delayed: notify with new ETA.
