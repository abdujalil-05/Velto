# ADR-066: velto_backup (BYPASSRLS) for full backups, attested backup gate, S3 objects backup (D-1/D-2/D-3, F-5)

Status: ACCEPTED by PO 2026-11-03 (code level). Commits `d20f6a8` `68d58a0` `f7f1d50`, CI run 41586244648 green.

## Context
All tenant tables use RLS + FORCE RLS. A backup must contain every company's rows; no existing role can do that safely:
`velto_app` sees one tenant; a role without BYPASSRLS makes `pg_dump` fail on `AuditLog`, and with
`--enable-row-security` it exits 0 but silently dumps 0 rows (proved). `velto_system` is a runtime role.

## Decision
1. **F-5:** separate role `velto_backup` — `BYPASSRLS`, `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
   no role memberships, owns nothing, no schema CREATE, SELECT only on all tables/sequences (+ default privileges),
   `default_transaction_read_only=on`, `CONNECTION LIMIT 2`, no password in scripts (set out of band).
   Globals: `pg_dumpall --globals-only --no-role-passwords`. Partial dumps with `--enable-row-security` are forbidden.
   Credentials are privileged: only the root backup unit reads them; never given to the app (`ecosystem.config.js`,
   `.env.production.local`) or the deploy user.
2. **D-3:** deploy.sh never sees the backup passphrase; the root backup unit writes a root-owned attestation
   (`/var/lib/velto-backup/status`); `verify-backup-status.sh` aborts deploy on missing/stale (>1440 min)/corrupt/
   failed/forged status or missing globals.
3. **D-1/D-2:** hourly encrypted DB backup + objects backup of 5 S3 prefixes, put-only offsite writer, separate restore
   policy, Object Lock COMPLIANCE.
4. Env files are data, never code: one parser (`deploy/env-file.js`; bash `load_env_file` in the monitor), owner/mode
   and all ancestor directories checked, symlinks rejected, file validated and read from one fd (no TOCTOU).

## Evidence (2026-11-03)
- `backup-role-proof.sh` on throwaway postgres:16: 3 companies, 51/51 tables counts+md5 equal after restore,
  RLS 49/51 forced (Permission, _prisma_migrations not tenant tables), policies/triggers equal, AuditLog append-only,
  isolation, 204/204 DML denied; explicit attribute query confirmed the role attributes above
  (`TEMP` on the DB is inherited from PUBLIC — session-only, no persistent schema change; accepted).
- Shellcheck v0.10.0 `-S warning`: 0 findings on 19 scripts (fixed, not disabled). Security-auditor PASS, 0 open.
- Isolated suite (`scripts/test-isolated.sh`): api 1313, database 143+3 skip, miniapp 207, 0 failed; harnesses
  backup-gate 68/0, env-parse 18/0, deploy-abort 12/0, monitoring 83/0, objects-minio 32/0.

## Consequences / residual
- BYPASSRLS credential leak = read of all tenants: keep only on the backup host as root 0600, pg_hba restricts source.
- Not proven on the pilot stand: RPO ≤1 h / RTO ≤4 h (matrix 35), human receipt of a real alert (matrix 36),
  real offsite/Object Lock bucket.
