# ADR-067: read-only BullMQ monitoring and offsite RPO from verified restore sets

Status: **ACCEPTED in code (2026-11-03, PO task "v0.9 monitoring gaps"); §6 R1/R2/R4 closed in code, R3 conditionally accepted, RPO ≤ 60 policy.** Nothing deployed; stand acceptance = MONITORING-ACCEPTANCE-CHECKLIST rows 8–10.
Scope: `deploy/monitoring/*`, `deploy/backup/*` only. No app code, no second queue system, no WAL.

## 1. BullMQ (bullmq 5.81.3, in-process in `apps/api`)
Facts: prefix = `BULLMQ_PREFIX` (`apps/api/src/common/queue/queue.module.ts:28`), pilot `velto-pilot`; the old monitor defaulted to `bull` and therefore read empty keys and reported OK (**defect, fixed**: `MONITOR_BULLMQ_PREFIX` is now required, and a missing `<prefix>:<q>:meta` = CRIT `queue_meta`).
Queues: `import-commit` (lock 120 s, maxStalled 5, 3 attempts exp 5 s), `1c-export` (3 exp 10 s, stale 15 m, sweep 5 m), `company-export` (exp 10 s, 30 m), `notification-telegram` (lease 5 m, sweep 60 s, Telegram backoff cap 60 m), `reconciliation-daily`, `idempotency-cleanup` (schedulers). Defaults: lock/stalledInterval 30 s, maxStalledCount 1.

Checks (all read-only; output = check name + counts/minutes only):
| Check | Source | Severity |
|---|---|---|
| `queue_meta` | `EXISTS <p>:<q>:meta` | CRIT (prefix mismatch) |
| counts | LLEN wait/active/paused, ZCARD delayed/failed | info |
| `queue_failed` | `failed` events in `<p>:<q>:events` since stored last id (not ZCARD, capped by `removeOnFail: 5000`) | WARN ≥1, CRIT ≥10 |
| `queue_wait_age` | oldest wait job `timestamp`+`delay`; retried jobs use `processedOn`/`finishedOn` | WARN 10 m, CRIT 30 m |
| `queue_active_age` | oldest active jobs `processedOn` vs per-queue limit (notif 5, 1c 15, company 30, import 30 m) | WARN > limit, CRIT > 2× |
| `queue_no_worker` | wait > 0 and `<p>:<q>:stalled-check` (set PX by every live worker each stalledInterval) absent on 2 probes 3 s apart | CRIT |
| `queue_stalled` | `stalled` events since last id; job `stc` | WARN 1–2, CRIT ≥3 or `stc` ≥2 |
| `queue_exhausted` | `retries-exhausted` events | CRIT |
| `queue_events_gap` | stored id older than first stream entry (MAXLEN ~10 000) | WARN |
| `queue_delayed` | overdue delayed > 15 m | WARN only — backoff never CRIT |
| `queue_paused` | paused > 0 | WARN |
| `jobs_stale` (PG) | ImportJob/ExportJob/Notification rows beyond their lifecycle (import backoff 300·2^attemptCount cap 3600 s + 10 m; export 25 m; notif PENDING past `nextAttemptAt` +15 m, SENDING claim +10 m) | WARN |
| `job_mismatch` | stale row ids (≤200) → `EXISTS <p>:<q>:<jobId>`; only the missing COUNT is printed; unchecked/truncated rows reported separately | WARN 1 run, CRIT 2 consecutive |
Redis down / auth failure (WHOAMI ≠ monitor user) → `redis` FAIL, queue checks SKIP (no false OK).

Security: Redis ACL `%R~<prefix>:*`, read commands only (README exact line); proven NOPERM for SET/DEL/HSET/EXPIRE/KEYS/SCAN/CLIENT/INFO/FLUSHDB/XADD and keys outside the prefix. CLIENT LIST rejected (exposes other clients). **Residual risk (PO accepts or not):** HGET/LRANGE/XRANGE could technically read job `data`/`failedReason`; the script parses only fixed fields and never logs replies. PG monitor role: column-level SELECT on status/timestamp/id/type columns only (no `companyId`, payload, PII, finance tables), no write.

## 2. Offsite RPO
Before: offsite "success" = `rclone copy` exit 0, `offsite_ts` = upload end, threshold 1560 min — rejected by PO.
Now: `restore_point_ts` = epoch taken **before** `pg_dump` starts. Each run writes `velto-set-<TS>.manifest` (RUN_ID, restore points, basenames + sizes + sha256 of DB, globals, objects archives). Upload order: archives → remote listing (names + exact sizes) → manifest LAST → listing again. Only then `offsite_restore_point_ts`, `offsite_ts`, `offsite_result=ok`. Any failure → `offsite_result=failed`, previous restore point kept, immediate alert. Remote content hash is not readable with the put+list-only identity: content integrity = local sha256 in the manifest, re-verified on download by `restore-drill.sh`.
Monitor: `backup_offsite_rpo` = now − `offsite_restore_point_ts`: WARN > 40 m, CRIT > 50 m (`MONITOR_OFFSITE_RPO_*`). 50 = 60 RPO − 5 m monitor interval − ~5 m delivery/ack margin. Missing/invalid/future/old-format status = CRIT. `backup_offsite_upload` (failed / skipped while enabled) = separate CRIT. RECOVERED via existing dedup (fingerprint = name|severity).

## 3. PostgreSQL + S3 consistency
Objects are archived after the dump snapshot starts and the app never deletes objects (`storage.service.ts` Put only) → every key referenced by the dump exists in the objects archive of the same set. Exceptions handled: keys outside the 5 known prefixes = FAIL (was WARN); 1C export overwrites one key → drill compares `ExportJob.fileHash` with the archived object. A set without manifest, or with failed/disabled objects backup, is **not** a restore point. `restore-drill.sh`: PASS (0) only when DB restore + objects archive verify + DB-referenced keys missing = 0 + fileHash match; DB-only = PARTIAL (2); FAIL (1). Object versions are restored from that set's tar (provider versioning not verified).

## 4. Consequences
- Hourly timer (`*:07`) **cannot** meet RPO ≤ 60: worst-case age = 60 + jitter + D + U > 60, so `backup_offsite_rpo` goes CRIT every cycle — intentional, not masked. Cadence is a PO decision (RPO-RTO-ASSESSMENT §7).
- Deploy gate (`vbs_check` with objects required) rejects old status files without `SET_MANIFEST`: one new backup run is needed before the first deploy.
- On an existing monitor role apply only the new GRANT lines of `monitor-role.sql`.
- Existing ACL users must add `+acl|whoami`; `MONITOR_REDIS_USER` is mandatory (empty or `default` = `redis` FAIL — security-auditor MED 2026-11-03, fixed).

## 5. Verification and residual risk (2026-11-03)
Tests: `run-tests.sh` 195/0, `integration-bullmq.test.sh` (real Redis 7.4 + bullmq 5.81.3 + PG `velto_test`) 140/0, `backup-gate.test.sh` 130/0, shellcheck v0.10.0 `-S warning` 0. Reviewer PASS, security-auditor PASS (after 1 MED fix). Isolated drill postgres:16.15 + MinIO: 15/15 PASS (`RESTORE-DRILL-ISOLATED-2026-11-03.md`). Local only: not RPO/RTO evidence.
Residual (LOW, PO to accept, no code change in v0.9):
- R1 Set manifest is not signed. Someone with write access to the offsite bucket can rewrite `RESTORE_POINT_TS` consistently and the drill of a downloaded set still passes (reproduced). The deploy gate is anchored by `SET_MANIFEST_SHA256` in the root-owned status, not by the offsite copy. Mitigation: put-only offsite key + Object Lock (runbook OPEN 11).
- R2 Offsite copy is verified by remote listing (names + exact sizes), not by content hash; content sha256 is proven only by a scheduled restore drill.
- R3 Redis ACL read commands could technically read job fields (`data`, `failedReason`); the script reads only fixed fields and logs no replies.
- R4 `restore-drill.sh` financial sums are SKIP without a source fingerprint; the drill above proved equality with its own count+sum+md5 fingerprint.

## 6. PO decision 2026-11-03 (part 4): R1/R2/R4 closed in code, R3 conditionally accepted, RPO policy
Scope unchanged: `deploy/backup/*`, `deploy/system/velto-tmpfiles.conf`, docs. No app code, no WAL, no new service.

**RPO/RTO policy (PO, binding for the closed pilot):** RPO ≤ 60 min, RTO ≤ 4 h. This is **stricter** than Master TZ v5.0 NFR-REL-002 for the pilot (v0.9: daily backup + drill, RPO ≤ 24 h); the GA target ≤ 15 min (WAL/incremental) is unchanged and not pursued in v0.9. First candidate: 20-min timer (`*:00/20`, jitter ≤ 1 min, `flock` no-overlap; a busy lock = exit 75 + `lock-busy` alert, never a silent skip). Monitor `backup_offsite_rpo` WARN > 40, CRIT > 50 min. Budget: T 20 + j 1 + D + O + U ≤ 60 ⇒ D+O+U ≤ ~39 min. Measured locally only D = 11.0 s (344 MB DB, incl. fingerprint 2.1 s); O (objects tar) and U (upload + read-back) **not measured**. Real RPO/RTO = **NOT_TESTED** until the pilot stand. If D+O+U does not fit, options are compared in RPO-RTO-ASSESSMENT §7 (A frequent dumps / B WAL / C incremental objects); WAL only by separate PO decision. Local retention is now tiered and runs only after the new set is verified (all sets 48 h, then the earliest verified set per day for 30 d; the newest verified set is never deleted; no verifier = no prune).

**R1 — manifest authenticity (CLOSED in code):** standard GPG detached signature (`velto-set-<TS>.manifest.sig`) with a **separate signing key** (not the encryption key; private key only in root-owned `/var/lib/velto-backup-sign` 0700, optional passphrase file root 0600/0400 — both enforced). Restore/drill verify with an independent keyring `BACKUP_VERIFY_KEYRING` (never taken from the backup) and pinned primary-key fingerprints `BACKUP_TRUSTED_SIGN_FPRS` (list → rotation: old + new key valid during overlap) parsed from `--status-fd VALIDSIG`; rejected: missing/bad/non-detached signature, untrusted, expired (`EXPKEYSIG`), revoked (`REVKEYSIG`). Signed `SET_TS` must equal the filename TS and the TS of DB/globals/fingerprint archives (rename rollback rejected); after the signature every file is sha256-checked and missing/extra files reject the set. Replay of an older valid set: drill requires `DRILL_MAX_RESTORE_POINT_AGE_MINUTES` (stale = FAIL) or an explicit `DRILL_EXPECT_RUN_ID` for a deliberate historical restore. Residual: deletion of newer sets at the provider is not detectable by the drill alone → Object Lock + monitor offsite RPO from the root-owned local status.

**R2 — offsite content integrity (CLOSED in code):** size/ETag is not accepted as proof (multipart ETag ≠ MD5). After upload every archive + manifest + sig is **read back** through a separate read-only key (`OFFSITE_VERIFY_S3_*`, policy `policies/offsite-restore-read.json`: Get/List only) and its sha256 compared with the signed manifest; no key / mismatch / error = `offsite_result=failed` (exit 11), `offsite_restore_point_ts` not advanced. Same-size content swap on real MinIO was detected. Cost: egress = full set size per run (×3/h at 20-min cadence) — provider pricing to be checked; provider-side `x-amz-checksum-sha256` not used (provider unknown). Restore re-verifies sha256 on a private 0700 copy (TOCTOU). Proves the stored copy equals what was written; full recoverability is proven only by a restore drill of that set.

**R3 — Redis ACL (CONDITIONALLY ACCEPTED for the closed pilot):** read-only audit of all 6 queues: job `data` contains only ids + `companyId` + `traceId`; return values only counts; no secrets/OTP/tokens/initData/presigned URLs, no amounts/balances, no phone/name/message text. Monitor PG role: column-level SELECT on ImportJob/ExportJob/Notification status/time/id only, no business tables; `monitor.env` root:velto-monitor 0640, Redis password via `REDISCLI_AUTH`, not argv. LOW residual: `import-commit` rethrows a raw error, so a rare Prisma validation error could put row values into `failedReason`/`stacktrace`; schedulers `reconciliation-daily`/`idempotency-cleanup` lack `removeOnComplete/Fail` (growth, not privacy). Owner: PO (Parviz). Review: before any pilot expansion beyond the closed pilot or by 2027-02-01, whichever first.

**R4 — financial reconciliation (CLOSED in code):** fingerprints computed in the **same exported snapshot** as `pg_dump --snapshot` (proved: live writer changed Payment; restored DB = MATCH, live source = MISMATCH). Schema has no separate ledger/FIFO-layer tables: ledger = Invoice + Payment + PaymentAllocation, FIFO = PaymentAllocation. Tables: Invoice, InvoiceLine, Payment, PaymentAllocation, PaymentReversal, PaymentIntentResolution, StockMovement, GoodsReceiptLine, Customer, AuditLog — count, amount/qty sums, sha256 over canonical ordered rows. File is gpg-encrypted inside the set, its sha256 in the signed manifest. Drill: missing fingerprint = **NOT_VERIFIED** (exit 3, never PASS), mismatch = FAIL; logs print only table name + MATCH/MISMATCH.

Evidence (local, synthetic, not RPO/RTO): `backup-gate.test.sh` 211/0 (macOS + Linux, real `flock`), `objects-minio.test.sh` (real MinIO) 37/0, monitoring `run-tests.sh` 195/0, shellcheck v0.10.0 `-S warning` 0, isolated drill postgres:16.15 + MinIO 27/0 (`RESTORE-DRILL-ISOLATED-2026-11-03-R1R4.md`). Not verified: real provider (Object Lock, policies, egress price), systemd sandbox + flock under the unit, Telegram delivery, O/U at real size, orphan-holder timeout and TOCTOU swap without race tests.
