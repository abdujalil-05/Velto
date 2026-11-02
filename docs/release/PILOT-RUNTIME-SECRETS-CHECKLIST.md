# Pilot: runtime & secrets checklist

> 2026-11-02. Server unknown: every item is **OPEN** until run on the pilot server. Commands are read-only. Never paste secret values into chat/tickets; check presence/length/permissions only. Links: matrix rows 23 (Node/PM2), 24 (secrets).

## 1. Runtime baseline

Node 22 LTS. Repo evidence: `package.json:6` engines `>=22.12 <27`; `.nvmrc` = 22; CI `node-version: 22` (`.github/workflows/ci.yml:67`); `deploy/README.md:36`; no Dockerfile (prod = PM2, `deploy/ecosystem.config.js:60+`, no `interpreter`). Boot guard `assertJsonSourceSupport` fails closed on an unsupported Node. **The exact patch (>= 22.12) must be confirmed on the server before deploy** (not recorded anywhere in the repo).

| # | Check | Command on server | Repo evidence | Status |
|---|---|---|---|---|
| R1 | Node version of the shell that starts PM2 | `node -v; pm2 describe velto-api \| grep -i 'node version'` | engines above; README:38 | OPEN |
| R2 | pnpm version | `pnpm -v` (expect 11.17.0, `packageManager`) | package.json:8 | OPEN |
| R3 | PM2 single instance, fork | `pm2 describe velto-api \| grep -E 'exec mode\|instances'` | ecosystem.config.js: `instances: 1, fork` (BullMQ in-process) | OPEN |
| R4 | pm2-logrotate active | `pm2 conf pm2-logrotate` (or run `deploy/monitoring/pm2-logrotate.sh`) | README:80; script prepared | OPEN |
| R5 | PM2 survives reboot | `pm2 startup; pm2 save; systemctl is-enabled pm2-<user>` | not in repo | OPEN |

## 2. Secrets and exposure

| # | Check | Command on server | Repo evidence | Status |
|---|---|---|---|---|
| S1 | No example/CI JWT secret | boot itself: API refuses to start in production with a placeholder (`pm2 logs velto-api --lines 30 --nostream` shows env validation error otherwise). Also compare without printing: `grep -c 'change-me\|ci-only' <env file>` must be 0 | `env.schema.ts:151` + `secret-placeholders.ts` (uncommitted change, commit `3b6cca3` base); `JWT_ACCESS_SECRET` min 32 (`env.schema.ts:30`) | OPEN |
| S2 | `MFA_ENCRYPTION_KEY` present, base64 of 32 bytes | `grep -c '^MFA_ENCRYPTION_KEY=.\+' <env>`; boot validates (`env.schema.ts:34`) | deploy/README.md:133 (ADR-058); copy kept in password manager | OPEN |
| S3 | `OFFLINE_KEK_SECRET` >= 32 chars, placeholders rejected | `grep -c '^OFFLINE_KEK_SECRET=.\{32,\}' <env>` | `env.schema.ts:36-39`; commit 36b239f; rotation policy: `docs/runbooks/offline-kek-rotation.md` (incident only, never remove old versions in pilot) | OPEN |
| S4 | Redis requirepass; PG passwords not example | boot rejects example passwords/no-password Redis in production; also `redis-cli -a "$PW" ping` works and `redis-cli ping` is NOAUTH | `env.schema.ts:175`; README:79 | OPEN |
| S5 | Separate S3 credentials (not root/admin, not backup/offsite key) | list MinIO/S3 user policies; app key must be limited to the bucket (`mc admin user list`) | `deploy/minio-policy.json` (anonymous GET only `products/*`); README:239 | OPEN |
| S6 | Backup passphrase separate from app secrets | `stat -c '%a %U' /etc/velto/backup.pass` = `600 root` | README:81-85, `backup.sh:26` | OPEN |
| S7 | Secret file permissions | `stat -c '%a %U %n' .env.production.local apps/*/.env.production.local /etc/velto/*` all `600`, owner = PM2 user/root | ecosystem reads only `.env.production.local` | OPEN |
| S8 | `.env*` not web-reachable | `curl -sI https://<domain>/velto/.env.production.local`, `/.env`, `/velto/api/.env` must be 404/403 (not 200) | **GAP:** `deploy/nginx.conf` is a snippet of `proxy_pass` locations only (lines 30-120); it has no `location ~ /\.` deny and serves no files, so safety depends on the host 443 block (`/` SPA fallback root) which is outside the repo. Add `location ~ /\.(?!well-known) { deny all; }` to the host block after review | OPEN |
| S9 | No secrets in logs | `grep -rIlE 'JWT_ACCESS_SECRET\|BEGIN PRIVATE\|bot[0-9]+:' ~/.pm2/logs /var/log/velto* \| head` (file names only) | SMS reset code no longer logged (audit §4.3). **GAP:** `trace-logger.ts:5` has no redaction/JSON; stale text `deploy/README.md:220-222` still says reset codes go to PM2 logs | OPEN |
| S10 | Redis AOF + noeviction | `redis-cli -a "$PW" CONFIG GET appendonly; ... CONFIG GET maxmemory-policy` = `yes`, `noeviction` | README:79 (not in `docker-compose.yml`, dev has neither) | OPEN |
| S11 | HTTPS, redirect, HSTS | `curl -sI http://<domain>/velto/` -> 301 https; `curl -sI https://<domain>/velto/ \| grep -i strict-transport` ; `openssl s_client -connect <domain>:443 </dev/null \| openssl x509 -noout -dates` | **GAP:** `nginx.conf` has no `Strict-Transport-Security`, no `listen`/`ssl_*` (host-owned; TLS by certbot per audit §10.2). Add `add_header Strict-Transport-Security "max-age=31536000" always;` at host level after TLS verified | OPEN |
| S12 | PG/Redis/MinIO not publicly bound | `ss -ltnp \| grep -E ':(5432\|5433\|6379\|6380\|9000\|9001)\b'` must show 127.0.0.1 only; from outside: `nmap -Pn -p 5432,6379,9000,9001 <ip>` closed; `ufw status` | `docker-compose.yml` dev binds 0.0.0.0 (dev only); README `ecosystem.config.js:85` says ufw keeps plaintext ports off. **GAP:** `nginx.conf:119` publishes MinIO `/velto-files/` (policy limits to `products/*`) | OPEN |
| S13 | Demo data/accounts absent | see README:225 (demo tenant, shared password) | seed refuses NODE_ENV=production | OPEN |

## 3. Rotation plan (if example/known secrets ever ran on an externally reachable environment)

Trigger: any of `change-me-*`, `ci-only-*`, compose passwords, or `.env.example` values was ever live on a reachable host (also if the pre-fix `env.schema.ts` allowed boot). Needs PO + Tech Lead authorization, a backup first (`deploy/backup/backup.sh`), and a maintenance window. Order:
1. Backup (verified `.sha256`); announce maintenance (`docs/runbooks/maintenance-mode.md`).
2. **JWT_ACCESS_SECRET**: new `openssl rand -base64 48`; `pm2 restart velto-api --update-env`. All access tokens die at once (<=15 min TTL anyway, `env.schema.ts:31`); users re-login through refresh.
3. **Revoke all sessions.** No global endpoint exists: per-user only (`auth.service.ts:521` logout allDevices; `users.service.ts:306` deactivation). Mass revoke is a manual SQL by a privileged role after step 2: `UPDATE "RefreshToken" SET "revokedAt" = now() WHERE "revokedAt" IS NULL;` (model `schema.prisma:221`, tokens stored hashed). Run as owner/system role on the pilot DB, in a transaction; rollback = none needed (users log in again). Check the audit result: `SELECT count(*) ...WHERE "revokedAt" IS NULL` = 0. Mini App agents get the offline-logout path.
4. **DB/Redis/S3 passwords**: change in PG (`ALTER ROLE ... PASSWORD`), Redis `requirepass`, S3 user; update `.env.production.local` (600); restart. Check no other host reuses them.
5. **MFA_ENCRYPTION_KEY**: do NOT swap directly; existing TOTP secrets become unreadable (README:139). If the key was exposed: re-encrypt by `keyVersion` (staging first) or, as pilot fallback, reset MFA of all users (they re-enroll). Exposure of key alone is not enough to read secrets without DB access, but treat DB leak + key as compromise.
6. **OFFLINE_KEK_SECRET**: follow `docs/runbooks/offline-kek-rotation.md` (new VERSION N+1, old secret kept in `OFFLINE_KEK_PREVIOUS_SECRETS`; never remove during pilot). Leak + stolen device = incident.
7. **TELEGRAM_BOT_TOKEN/WEBHOOK_SECRET**: `docs/runbooks/bot-token-leak.md`.
8. Verify: `/health/ready` 200, login works, old access token returns 401, audit review of logins in the exposure window.
Rollback of the rotation: restore the previous `.env.production.local` from the offline copy only if the new secret is broken (never for a leaked one).
