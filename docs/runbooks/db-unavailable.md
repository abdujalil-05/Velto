# DB unavailable
- **Detection:** `GET /health/ready` -> 503 with `database: down`; API 5xx spike; `pm2 logs velto-api` Prisma connection errors. Alert on DB connections/5xx: (planned).
- **Severity:** SEV1 (whole product down; no reads or writes).
- **Triage:** 1) `GET /health/live` ok + `/health/ready` down => DB, not the process. 2) On the VPS: Postgres service status/disk space/`max_connections` (`SELECT count(*) FROM pg_stat_activity`). 3) Disk full or crashed => start/free space; corrupted => restore (restore-drill.md procedure, backup from `deploy/backup/backup.sh`). 4) Never expose the DB port publicly while debugging.
- **Data safety:** Do not delete WAL/data directory. Before any repair take a file-level copy if the cluster is readable. API stays up (it fails closed); optionally enable maintenance mode only if DB is reachable read-only. Prefer restore into a NEW database name, verify, then swap.
- **Owner:** Ops owner (on-call), escalation Tech Lead.
- **Verification:** `/health/ready` 200; login works; `POST /reconciliation/run` shows no new findings; latest AuditLog row time is plausible (RPO check against the last backup timestamp).
- **Comms:** Notify pilot customers via the configured manual channel (status message: outage start, ETA, possible loss window = since last backup; daily backup only until WAL/PITR GA, see docs/ops/wal-pitr-plan.md). Post-incident note within 24 h.
