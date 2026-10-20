# Backup restore drill
Proves a backup can be restored and is consistent (TZ 12.2, 16.5 Operations). Run before pilot/release and periodically. Never against production.
- **Detection (when):** before v0.9/v1.0 sign-off, after backup/schema/infra changes, at least quarterly; backup job failure triggers an out-of-cycle drill.
- **Severity:** a failed drill = SEV2 (no verified recovery path = release blocker).
- **Triage / how:** `deploy/backup/backup.sh` (encrypted `pg_dump -Fc` + globals; env documented in the script). Drill: `DUMP_FILE=<velto-db-*.dump.gpg> BACKUP_PASSPHRASE_FILE=<file> deploy/backup/restore-drill.sh` on a local/staging Postgres (without `DUMP_FILE` it dumps the source itself using one exported snapshot). It restores into the separate DB `velto_restore_drill` (dropped afterwards), runs provision-roles, `prisma migrate status`, RLS FORCE check, row counts vs source, StockLevel vs StockMovement, allocation sums, AuditLog continuity + append-only trigger, velto_app tenant-isolation smoke, measures RTO, and writes `docs/ops/restore-drill-<date>.md`. Exit 0 = PASS.
- **Data safety:** The source is only read. The script refuses DB names not starting with `velto_restore_drill` and non-local hosts. Production data must not be copied to dev/test (TZ 11.3): drill production backups only on the approved staging host, and delete the restored copy afterwards. Passphrase never in the repo.
- **Owner:** Ops owner.
- **Verification:** all checks PASS in the generated report; RTO recorded vs target 4 h (re-measure on production-sized data); report path goes into the SIGNOFF Operations row.
- **Comms:** Share the drill report with Tech Lead/PO; a failed drill is escalated before any release decision.
