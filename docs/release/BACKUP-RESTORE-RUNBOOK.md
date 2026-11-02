# Backup / Restore runbook (pilot)

Status 2026-11-02: scripts and drills verified LOCALLY only. Nothing here is activated on a server. Targets: RPO <= 24 h (pilot, daily backup), RTO <= 4 h (TZ 12.2).

## Components (deploy/backup/)
- `backup.sh` - pg_dump -Fc as `velto_system` -> gpg AES256 -> streaming verify -> `.sha256`; retention `BACKUP_RETENTION_DAYS`.
- `offsite-sync.sh` - `rclone copy --immutable` of `*.gpg`/`*.sha256` to an S3-compatible bucket, SEPARATE put-only credentials. Never deletes/overwrites, never uploads the passphrase.
- `backup-run.sh` - scheduled entrypoint: backup -> offsite (if `OFFSITE_ENABLED=1`) -> alert on any failure.
- `restore-drill.sh` - restore into a separate `velto_restore_drill*` DB + checks. `backup.env.example`, `velto-backup.{service,timer}.example` - config samples (not installed).

## Schedule (user action on the server; not activated by the repo)
1. `/etc/velto/backup.env` (root, 600) from `backup.env.example`; passphrase in `/etc/velto/backup.pass` (600), plus an offline copy in the PO password manager. Without the passphrase the backups are unreadable.
2. systemd: first install the scripts to the root-owned `/opt/velto/deploy/{backup,monitoring}/` (commands in the header of `velto-backup.service.example`, incl. `pg-conn.sh`; re-run after each git pull), then copy the two `.example` units to `/etc/systemd/system/` (sandboxed; runs as root by design, reasons in the unit header), `systemctl daemon-reload && systemctl enable --now velto-backup.timer`. Or cron: `15 2 * * * set -a; . /etc/velto/backup.env; set +a; /root/projects/parviz_aka/Velto/deploy/backup/backup-run.sh >>/var/log/velto-backup.log 2>&1`.
3. First run manually, then check `systemctl list-timers`, the log, and that `.gpg` + `.sha256` exist.

## Offsite and who may delete (storage owner action)
- A different provider/account than the VPS and the app's S3/MinIO. App S3 keys (`S3_*`) must NOT be reused.
- The server key (`OFFSITE_S3_*`) is put-only: allow `s3:PutObject` on the prefix; deny `s3:DeleteObject*`, `s3:PutBucketPolicy`, `s3:PutLifecycle*`, `s3:PutObjectRetention`, and ideally `s3:GetObject`/`ListBucket` (then `NO_CHECK_BUCKET` is already set; `--immutable` needs list/head, so if List is denied expect rclone to re-upload and fail on existing objects - use unique timestamped names, which backup.sh does).
- Enable at the bucket: versioning + Object Lock (compliance/governance, retention >= 30 days) and lifecycle expiry (e.g. 60-90 days) set by the storage owner with a separate admin identity. Restore/list uses a third read-only identity kept off the server.
- Local `BACKUP_RETENTION_DAYS` only prunes the local dir; it never touches offsite.

## Alerts
`backup-run.sh` calls, in order: `$BACKUP_ALERT_CMD` (absolute path of a root-owned executable, not group/world-writable; no args/shell; called as `cmd <severity> <incident-id> <msg>`; msg = host/step/exit/timestamp only, never command output), else `velto-monitor --alert backup-<step> "<msg>" --severity crit` (deduped per incident, cooldown `MONITOR_ALERT_COOLDOWN_SECONDS`=3600; `--resolve` sends recovery after a successful run) (called as the `velto-monitor` user via `runuser` when run as root, so state files are never root-owned; `$VELTO_MONITOR_BIN`, `velto-monitor` in PATH, or `deploy/monitoring/velto-monitor.sh`; the one Telegram path, token in `/etc/velto/monitor.env`), else `logger -p user.err -t velto-backup` (also used if Telegram is NOT DELIVERED; message contains `VELTO-BACKUP-FAILED`). Non-zero exit also feeds cron MAILTO / systemd `OnFailure=`. Missed run (timer not firing): covered by the `backup` check of `velto-monitor` (newest verified `velto-db-*.dump.gpg` older than `MONITOR_BACKUP_MAX_AGE_HOURS`=26 h -> FAIL alert), so one skipped daily run alerts within ~2 h. Limits: checks local `BACKUP_DIR` only (not offsite copy); the monitor runs on the same host, so a dead host needs the external probe (see deploy/monitoring/README.md, OPEN). Not verified on a server: delivery requires `velto-monitor --test-alert` received by a human.

## Recovery procedure
Never restore over production in place. Restore into a NEW database, verify, then switch the app.
1. Fetch the latest `velto-db-*.dump.gpg` and its `.sha256` (offsite via the read-only identity if the server is lost). `sha256sum -c velto-db-*.gpg.sha256` must say OK.
2. Provision a Postgres 16 and roles: `psql -f packages/database/scripts/provision-roles.sql` (as superuser; prod uses the host's role names - see deploy/README.md role runbook, do not run it as is on a foreign host).
3. Drill-style verification (local/staging): `DUMP_FILE=<file> BACKUP_PASSPHRASE_FILE=<pass> SOURCE_URL=<src> DRILL_KEEP_DB=1 deploy/backup/restore-drill.sh` -> all checks PASS.
4. Real restore: `createdb velto_restored`, `gpg -d file | pg_restore --no-owner --no-privileges -d velto_restored`, re-run provision-roles, `prisma migrate status` = up to date (use `migrate deploy` only if the dump is older than the code).
5. Point `DATABASE_URL/DATABASE_SYSTEM_URL` to the new DB (env, no repo change), `pm2 restart`, check `/health/ready`. Keep the damaged DB for forensics; do not drop it.
6. Data written after the last backup (<= 24 h) is lost; reconcile held offline payments per the reconciliation runbook.

## Measured locally (2026-11-02)
Synthetic consistent dataset `velto_restore_src_synth_20261102` (46 migrations, demo seed: 282 orders/invoices, 195 payments+allocations, 1842 stock movements, 49 RLS tables): backup 1 s, 388 KB `.gpg`; restore (create + pg_restore + roles) 9 s; full drill with 13 checks 12 s; all PASS (report `docs/ops/restore-drill-synth-2026-11-02.md`). Tiny data on a laptop: NOT representative of production volume; earlier velto_dev drill: 35-57 s on 76-80 MB.
Checks: sha256, gpg decrypt, negatives (corrupted `.gpg` -> gpg exit 2 and sha256 FAILED; wrong passphrase -> exit 2), `_prisma_migrations` == repo, migrate status, RLS ENABLE+FORCE, allocation sums, invoice total = sum(lines), StockLevel = sum(StockMovement), AuditLog append-only trigger, row counts vs source, tenant isolation as `velto_app`.

## OPEN (not proven)
1. Real offsite upload with a put-only key and bucket policy/Object Lock/lifecycle (needs provider + storage owner; rclone path untested against a real bucket).
2. Restore drill on a separate stand/server (different OS/PG minor, real roles/host), and on production-sized data (RTO).
3. Alert delivery check end to end (deploy/monitoring alert channel; missed-run/dead-man detection).
4. Schedule not installed; `BACKUP_GLOBALS_URL` (roles) not configured.
5. RPO <= 15 min (WAL/PITR) is plan-only: `docs/ops/wal-pitr-plan.md`.
6. Legal data-location review for the offsite provider (TZ 11.5, ADR-008).
