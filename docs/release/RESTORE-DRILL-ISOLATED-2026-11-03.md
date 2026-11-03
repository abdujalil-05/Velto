# Restore drill 2026-11-03 (throwaway, synthetic data) - protocol

Prefix: velto-drill-20261103122214 (containers -pg, -minio, -runner; volumes -pgdata, -miniodata; network -net). Host ports 127.0.0.1:46432 (PG), 46900 (MinIO).
Not touched: velto-postgres-1, velto-redis-1, ruscha-*, velto_dev, port 5433, prod. Repo scripts NOT edited.
Timings are local on ~1 MB DB / 3 MB objects: NOT RPO/RTO evidence (backup-run 3 s, restore 1 s, full drill 3 s).

## Deviations / harness (not script defects)
- PG image postgres:17 (not 16): host pg client is 17 and backup.sh requires pg_dump major == server major. Prod compose uses 16-alpine -> re-run on 16 with matching client before relying on this.
- MinIO image bitnamilegacy/minio:latest (already local; same as objects-minio.test.sh). Pull not attempted.
- backup-run.sh refuses to run unless the script dir + all ancestors are root-owned (bk_self_check), so it ran as root inside velto-drill-20261103122214-runner (postgres:17 + apt rclone 1.60.1 + socat) from a root-owned copy of deploy/backup (uncommitted versions). socat maps 127.0.0.1:9000 -> MinIO because bk_check_endpoint allows plain http only for loopback.
- Roles: provision-roles.sql -v velto_env=dev on DB velto_load (dev mode needs *_load name; seed-load.ts also requires the DB name velto_load); provision-backup-role.sql + random password for velto_backup. Migrations: prisma migrate deploy (46). Data: seed-load.ts (--slug drilla/drillb, 2 tenants x 315 invoices, 264 payments, 254 allocations, 2287 stock movements, 80 stock levels, 30 customers) + 400 AuditLog rows + 2 ExportJob(GENERATED) referencing exports/1c objects. S3: 43 synthetic objects, 7 prefix dirs x 2 companies x 3 + 1 big (3 MB) under products/, exports/1c, exports/company, imports/*, opening/*.
- Offsite = bucket velto-offsite-backups (Object Lock GOVERNANCE 30d) on same MinIO, put-only writer key; download with offsite-restore-read key; restore targets velto-restore-target.
- Restore drill ran on the host from the downloaded OFFSITE copy (DRILL_SET_MANIFEST), report to scratchpad (not docs/ops).

## Results
1 PASS pg backup by velto_backup role (BYPASSRLS, read-only): dump.gpg 702082 B, restore dump contains all 400 AuditLog rows (FORCE RLS not an obstacle).
2 PASS globals present: velto-globals-*.sql.gpg 510 B (CREATE/ALTER ROLE for velto_app/owner/system/backup, postgres; --no-role-passwords: 0 'password' hits). Passwords NOT in backup: re-set from provision-roles.sql/secrets (by design, documented in backup.sh).
3 PASS GPG AES256: all 3 archives are 'PGP symmetric key encrypted data - AES with 256-bit key'; BACKUP_DIR holds only *.gpg, *.sha256, *.manifest; find on the runner for *.dump/*.sql/*.tar/MANIFEST.tsv/.objects-work* = 0.
4 PASS objects backup: 43 objects, velto-objects-*.tar.gpg 3117254 B; embedded manifest sha256 verified; also uploaded offsite (7 files).
5 PASS checksums: .sha256 for 3 archives OK locally and after offsite download (shasum -c 3/3); manifest sizes+sha256 verified by bsm_verify (self-check in backup-run + drill).
6 PASS manifest last: offsite mtimes archives 12:28:13.99-14.96, manifest 12:28:15.00 (rclone log: archives copy, verify, then manifest copy); status RESULT=ok, OFFSITE=ok, offsite_result=ok.
7 PASS restore-drill.sh set-mode into fresh DB velto_restore_drill: rc=0, verdict PASS (18 checks, 1 SKIP "financial sums": no source in set-mode - covered by item 11 manually); prisma migrate status up to date, 46 migrations identical.
8 PASS restore-objects.sh --to-dir and --to-bucket (empty bucket, byte-compared): 43/43 objects; sha256 of every restored file == original seed file (diff empty, both modes).
9 PASS RLS: 49 of 51 public tables ENABLE+FORCE, 49 policies, 0 companyId tables without FORCE (2 non-tenant tables are global).
10 PASS AuditLog UPDATE/DELETE rejected ("AuditLog is append-only") for velto_system, postgres (superuser), velto_owner and velto_app (with company context); TRUNCATE denied/blocked by FK; rows still 400.
11 PASS per company (2) count+sum+md5(whole rows) identical source vs restored for Invoice(315), InvoiceLine(970), Payment(264), PaymentAllocation(254), Customer(30, cachedBalance sum): fp.source == fp.restored, 16 metric rows, diff empty. FIFO: verify-integrity.sql on restored DB = 0 rows; over-allocated pay/inv = 0/0/508 allocations; invoice total = sum(lines) mismatch 0/630. (No separate FIFO-order assertion exists beyond the allocation rows being byte-identical.)
12 PASS StockMovement 2287/company sum qty 114662.000 and StockLevel 80/company onHand 20347.000 identical to source; stock mismatch 0/160.
13 PASS velto_app/velto_owner with ctx A: other-company Invoice/Payment/StockMovement/AuditLog/Allocation = 0 each, own invoices 315; symmetrical for B; no context -> 0 invoices.
14 PASS negatives (all rc!=0, no false PASS): flipped bytes in DB archive -> FAIL sha256 mismatch; truncated archive -> FAIL size mismatch; objects archive missing -> FAIL "OBJ archive missing"; object removed from re-encrypted archive with manifest sha/size updated -> FAIL "bad objects=1"; manifest DB_SHA256 tampered -> FAIL; OBJ_COUNT tampered -> FAIL; OBJ_MANIFEST_SHA256 tampered -> FAIL; RESTORE_POINT_TS in the future -> FAIL (older than restore point); manifest missing -> FAIL "no restore point"; DB-only drill -> rc=2 PARTIAL. backup-run: wrong DB password -> rc=2, RESULT=failed, alert fired; wrong offsite key -> rc=10, local RESULT=ok, offsite_result=failed, alert; foreign object outside 5 prefixes -> rc=1 "no restore point", RESULT=failed.
15 PASS 22 log/report/alert/status/docker-log files + manifests scanned for 15 literal secrets used (PG superuser pw, MinIO root user/pw, 4 S3 key ids+secrets, velto_backup pw, gpg passphrase, wrong-pw strings): 0 hits. Alerts contain only step/exit/ts.

## Findings (observations, not blockers)
F1 The set manifest is unsigned: lowering RESTORE_POINT_TS to a value still earlier than OBJECTS_SNAPSHOT_TS (consistent order) yields drill PASS rc=0. Integrity of the manifest itself is anchored only by SET_MANIFEST_SHA256 in the root-owned status (verify-backup-status.sh gate), not by the drill on a downloaded offsite set. Location: deploy/backup/backup-status-lib.sh bsm_verify (~107-140).
F2 restore-drill.sh set-mode: "financial sums" is SKIP (no source), so sum equality was proven by my own fingerprint, not by the script.
F3 backup-run.sh cannot be run as non-root (bk_self_check); the harness needed a root container. Not a defect, but local dev reproduction requires docker.
F4 Not verified: PG16 server (used 17), real S3 provider, Object Lock WORM/retention behaviour on delete, systemd timer, the status gate in deploy.sh, velto-monitor alert path (BACKUP_ALERT_CMD hook used), large-volume timings.

## PG16 repeat (postgres:16.15 server; runner = postgres:16 image, pg_dump/psql 16.15; current uncommitted files incl. restore-drill.sh:148 and velto-monitor.sh)
Same harness (root runner, socat for loopback http, seed-load 2 tenants, 43 S3 objects, offsite bucket with Object Lock). Alerts via deploy/monitoring/velto-monitor.sh (--alert/--resolve, run as user velto-monitor with env -i) to a stub webhook (socat in runner), BACKUP_ALERT_CMD unset. Restore side (restore-drill.sh) ran on the host: psql/pg_restore 17 against the 16 server from a v16 archive (2 harmless transaction_timeout lines ignored by the drill).
1 PASS backup-run rc=0 (2 s), DB 701810 B, velto_backup. 2 PASS globals 5 CREATE ROLE, 0 password hits. 3 PASS 3/3 archives PGP AES256, 0 non-gpg files in BACKUP_DIR, no plaintext dump in runner (only repo monitor-role.sql).
4 PASS objects 43, 3134063 B. 5 PASS sha256 3/3 OK after offsite download. 6 PASS offsite mtimes: archives 12:35:51.5-52.5, manifest 12:35:52.527 (last); status RESULT=ok OFFSITE=ok.
7 PASS restore-drill.sh set-mode rc=0: 17 PASS, 0 FAIL, 1 SKIP (financial sums, no source), restore 1 s. 8 PASS restore-objects dir+bucket 43/43 sha256 identical to seed.
9 PASS 49/51 tables RLS+FORCE, 0 companyId tables without FORCE. 10 PASS UPDATE/DELETE on AuditLog rejected for velto_system, velto_owner, velto_app (company ctx), postgres.
11 PASS fingerprint (count+sum+md5 whole rows, 2 companies, 16 rows) identical; verify-integrity.sql 0 rows. 12 PASS StockMovement/StockLevel identical, drill mismatch 0. 13 PASS other-company Invoice/Payment/Stock/Audit/Alloc = 0/0/0/0/0 both directions (own 315).
14 PASS: flip, trunc, missing archive, dropped object, tampered DB sha / OBJ_COUNT / OBJ_MANIFEST_SHA256, RESTORE_POINT_TS in future, no manifest -> rc=1; DB-only -> rc=2. RESTORE_POINT_TS lowered (e.g. 1700000000) -> rc=0 PASS (finding F1 reproduced). backup-run: wrong DB pw rc=2 RESULT=failed; wrong offsite key rc=10 local ok/offsite failed; foreign object rc=1 RESULT=failed.
15 PASS 23 files (logs, report, webhook log, status, docker logs) x 15 secrets = 0 hits.
Alert routing via velto-monitor: 3 ALERT(crit) webhooks delivered (steps backup.sh exit=2, offsite-sync.sh exit=10, objects-backup.sh exit=1), text only "VELTO-BACKUP-FAILED host=<id> step exit ts"; a good run produced RECOVERED for all open incidents (backup.sh, offsite-sync.sh, objects-backup.sh), dedup state dir empty afterwards. No secrets/URLs in alert text.
Not verified: real Telegram, systemd, deploy.sh gate, real S3, prod volumes.
