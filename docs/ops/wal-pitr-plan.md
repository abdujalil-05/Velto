# WAL archiving / PITR plan (GA: RPO <= 15 min) - PLAN ONLY, F7.0 production work

Status: not implemented. Pilot (v0.9) relies on the daily encrypted `pg_dump` (`deploy/backup/backup.sh`, RPO up to 24 h) plus restore drills. This plan is NOT executed by CI or an agent; the operator applies it on the VPS after a staging drill.

## Target
- RPO <= 15 min, RTO <= 4 h (TZ 12.2). Encryption at rest for backups; backup credentials separate from app credentials; DB port stays closed publicly.

## Design
1. Base backup: weekly `pg_basebackup` (or `pgBackRest` full) + daily differential; keep the daily logical dump as a second, independent recovery path.
2. WAL archiving: `wal_level=replica`, `archive_mode=on`, `archive_command` / `archive_timeout=300` (forces a WAL segment at least every 5 min so RPO <= 15 min holds on idle systems) shipping to off-host storage (object storage or a second host), encrypted (pgBackRest repo encryption or gpg).
3. Retention: base backups + WAL for 14 days (same `BACKUP_RETENTION_DAYS` policy), pruned by the tool, not by `rm`.
4. Restore (PITR): restore base backup to a NEW data directory/cluster, `recovery_target_time`, `recovery_target_action=promote`, then run `deploy/backup/restore-drill.sh`-style checks (RLS FORCE, reconciliation, isolation smoke) before switching traffic.
5. Monitoring: alert when the last archived WAL is older than 15 min, when archiving fails, and when the last base backup is older than 8 days (alerts: planned).

## Open decisions (owner: Ops owner + Tech Lead)
- Off-host target and subprocessor/data-location review (TZ 11.5, ADR-008) before choosing the storage provider.
- Tooling: pgBackRest vs plain `pg_basebackup` + `archive_command`.
- Staging drill of a real PITR to a chosen timestamp, with measured RTO, before claiming RPO <= 15 min.

## Rollback
Disabling archiving is `archive_mode=off` (restart required); the logical-dump path is unaffected. Enabling needs a restart: schedule it in a maintenance window (maintenance-mode runbook) and take a fresh `backup.sh` dump first.
