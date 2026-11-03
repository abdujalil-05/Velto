# RPO / RTO assessment (pilot) — 2026-11-02

Status: **ASSESSMENT ONLY. No PASS declared.** Nothing here is enabled on any server. Targets: PO RPO <= 1 h (TZ §12.2 says <= 15 min), RTO <= 4 h.

## 1. Current state and the gap
Old timer: daily 02:15 -> RPO up to 24 h (+ run time) — fails the PO target. Prepared (not enabled): `deploy/backup/velto-backup.timer.example` is now HOURLY (`*:07:00`, 2 min jitter, Persistent). Honest arithmetic: a dump is a snapshot taken at the START of the run, so after a failure just before the next run the worst-case data loss is interval + run duration + offsite upload lag (not just the interval). Hourly dumps therefore give RPO ~ 1 h + minutes, i.e. they only touch the <= 1 h target and do NOT meet 15 min.

## 2. Measurements (synthetic, local; limits below)
Script: `deploy/backup/tests/db-e2e-measure.sh` (throwaway `postgres:17` container, role with BYPASSRLS + read-only like `velto_backup`, real `backup-run.sh` with `OBJECTS_BACKUP_ENABLED=0`, status attestation, gate, restore into a fresh DB, row-count + md5 comparison).

| Dataset | DB size | `backup-run.sh` (pg_dump -Fc + gpg AES256 + streaming verify + globals + sha256 + status) | Archive | Gate (re-hash ciphertext) | Restore (gpg decrypt + pg_restore, 1 job) | Integrity |
|---|---|---|---|---|---|---|
| 63 550 rows | 29 MB | 1.8 s | 9.3 MB | 0.1 s | 0.5 s | counts + md5 equal |
| 4 766 254 rows (1 table, RLS forced, 1 index) | 1631 MB | 105.3 s | 705 MB (730 064 767 B) | 2.3 s | 41.8 s | counts + md5 equal |

Rough extrapolation (linear, NOT validated): ~65 s per GB of database for the backup run, ~26 s per GB restore -> 10 GB ~ 11 min / 4.5 min; 50 GB ~ 54 min / 22 min. The 50 GB case would not fit an hourly cadence.
Limits (be honest): Docker Desktop VM on a laptop (Apple silicon, fast SSD), `fsync=off` on the server (restore optimistic), synthetic md5 text (compresses ~2.3x; real data differs), one wide table (no FK/index-heavy schema, real restore of Velto's ~100 tables and indexes will be slower), no network: offsite upload time = archive size / uplink is NOT measured (705 MB/h at 10 Mbit/s uplink would take ~10 min; at 2 Mbit/s ~49 min), object archive NOT included in these numbers (see 4), RTO components not measured: download from offsite, provisioning a new server, roles/migrate, app start, DNS.

## 3. Options
| Option | RPO | RTO | Cost / complexity | Main risks |
|---|---|---|---|---|
| A. Hourly logical dump (prepared) | ~1 h + run + upload lag | restore time (table above) + download + roles | lowest; already tested; sha256 + gpg verify each run | misses 15 min target; load of pg_dump hourly (single pass, read-only role); object archive is full each time |
| A2. Dump every 30 min | ~30 min + lag | same | same scripts, timer only | doubles load/offsite volume; object archive cost doubles (see 4) |
| B. WAL archiving + base backup (pgBackRest or wal-g to offsite) | seconds–minutes (`archive_timeout` 60–300 s; limited by last shipped segment) | base restore + WAL replay (minutes-hours, depends on WAL since base) | highest: superuser config (`archive_mode`, `archive_command`), repo encryption, retention, `pgbackrest check`, restore drills for PITR | Object Lock / no-delete identities conflict with `expire` (pgBackRest must delete expired backups/WAL: retention must equal Object Lock window, or use a separate repo bucket w/o lock + the locked bucket for periodic copies); archive failures can fill pg_wal and stop the DB (monitor!); physical backup is major-version-bound; not tested here (no pgBackRest image/offsite available in this run) |
| C. A + B | PITR for RPO, dumps as portable/major-upgrade safety net | PITR restore | both operational loads | two systems to monitor |
| D. Provider VPS snapshots | provider dependent | provider dependent | cheap | same failure domain; not a substitute (kept as extra) |

Recommendation for PO decision (not a decision): if 15 min / 1 h RPO is binding -> B (or C) after a PITR drill; A/A2 is the stopgap that is already implemented and tested. Required inputs before deciding: real DB size growth, real object bucket size, offsite uplink, provider's Object Lock support and pricing.

## 4. Objects
The object archive is a FULL tar+gpg of the 5 prefix groups each run (no incremental): cost grows with bucket size and dominates hourly runs for photo-heavy tenants. Measured only functionally (43 synthetic objects, MinIO, `objects-minio.test.sh`); no throughput numbers. If the bucket is large: run objects on a slower schedule than the DB (status then needs separate timestamps — NOT implemented) or move to a versioned/replicated bucket at the provider (pull-based copy by a read-only identity). RPO for objects is an independent PO decision (they are mostly immutable uploads, so loss is bounded by "since the last archive" and recoverable partly from source files/users).

## 5. Alignment with monitoring
`offsite_ts` / `offsite_result` are written by every successful `offsite-sync` (via `backup-run.sh`, or standalone via `bs_update`). With an hourly timer the offsite age should stay < ~75 min; suggested `MONITOR_OFFSITE_MAX_AGE_MINUTES` = 180 (two missed runs), `MONITOR_BACKUP_MAX_AGE` analogue for the local `ts` = 90–120. Current 1560 is right only for the old daily timer.

## 6. Open
1. Choose option (PO). 2. Measure on staging with a production-like dump (size, index/FK mix) and the real offsite uplink. 3. If B: PITR drill + decide how pgBackRest `expire` coexists with Object Lock. 4. Object archive throughput on real data. 5. Full RTO stopwatch (new VPS from zero) — not measured.
