# Pilot monitoring (existing tools only)

STATUS: **NOT PASS**. Monitoring counts as done only after a REAL alert (`--test-alert`, then a real failure drill) was delivered to and acknowledged by the responsible person. Nothing here has run on a server.

Files: `velto-monitor.sh` (checks + Telegram), `monitor.env.example`, `monitor-role.sql` (read-only DB role), `velto-monitor.{service,timer}` (systemd, 5 min), `pm2-logrotate.sh`.

## What is checked
| Check | Source | Alert when |
|---|---|---|
| health_ready | `GET $VELTO_API_HEALTH_URL` (required, no default) = PG `SELECT 1`, Redis `PING`, S3 `HeadBucket`, 2 s each, 503 on any failure (`apps/api/src/health/health.controller.ts:93`; `/health/live` :60 checks nothing) | non-200, or 200 whose body is not `{"status":"up","checks":{...,"db":"up"}}` (nginx 502/404/HTML = FAIL) |
| tls | `openssl s_client` on 443 | < 14 days |
| api_5xx | nginx access log, `MONITOR_5XX_PATH_PREFIX` (default `/velto/api/`) lines, last 2000 | >=5 and >=5% 5xx |
| backup | newest `velto-db-*.dump.gpg` in `BACKUP_DIR` has `.sha256` (`backup.sh:44,52,67`: written only after verify) | missing or > 26 h |
| disk | `df` | >= 80% |
| jobs_stuck / jobs_failed | `ImportJob`, `ExportJob`, `Notification.telegramStatus` by status + `updatedAt` (schema.prisma:1295/1356/1436); sweeps return counts only, no exported metrics | stuck > 30 min; >= 5 failed / h |
| db_connections | `pg_stat_activity` count | reported only (no threshold yet) |

Ad-hoc alert: `velto-monitor --alert <name> "<short text>"` (no PII/secrets; 300 chars max) sends through the same Telegram path; exit 1 and `ALERT NOT DELIVERED` on stderr if token/chat are unset or Telegram fails. `deploy/backup/backup-run.sh` uses it on backup/offsite failure. Missed backup run = `backup` check above (age > 26 h) fires.

Not covered (gaps): Redis memory/AOF state, PM2 restarts count, worker backlog depth (BullMQ), RLS test failure (CI only), SMS delivery.
Dedup: run mode = alert on state change, repeat every 6 h, "RECOVERED" on clear. `--alert` = per incident id (name), state in `$MONITOR_STATE_DIR/alerts/` (0700), cooldown `MONITOR_ALERT_COOLDOWN_SECONDS` (3600), re-alert on severity change, `--resolve <name>` sends recovery. Messages contain check names and numbers only: no URLs with tokens, log lines, phones, amounts, PII.

## Install (server, you run; nothing here touches prod by itself)
1. Ops bot: new bot via BotFather (NOT the app bot), send it a message from the responsible person, get chat id (`getUpdates` locally on the server, do not paste into chat).
2. `install -m 600 -o root deploy/monitoring/monitor.env.example /etc/velto/monitor.env`; fill values on the server.
3. DB role: `psql -U postgres -d <pilot_db> -f deploy/monitoring/monitor-role.sql`, then `\password velto_monitor`; set `MONITOR_DB_HOST/PORT/NAME/USER/PASSWORD` in monitor.env (password goes to a temp 0600 PGPASSFILE, never argv). Connection count comes from `velto_monitor.conn_count()` (SECURITY DEFINER, count only); neither `pg_monitor` nor `pg_read_all_stats` is granted to anyone (count(*) needs no privilege). Columns granted: id/status/updatedAt/createdAt only. BYPASSRLS is needed (FORCE RLS) so it is read-only by `default_transaction_read_only`, column-level GRANT, 5 s timeout, 2 connections.
3b. Service user (root, once): `useradd --system --no-create-home --shell /usr/sbin/nologin velto-monitor`; `chgrp velto-monitor /etc/velto/monitor.env && chmod 640 /etc/velto/monitor.env`. The unit runs as it (no root, no sudo, hardened, NO `adm` group). PM2 is read from a snapshot file (see "Added for the pilot"), so the monitor needs no PM2 access.
3c. Read access by ACL, only what the checks need (root, once; needs the `acl` package):
   - state dir BEFORE anything runs: `install -d -m 700 -o velto-monitor -g velto-monitor /var/lib/velto-monitor` (see first-start order below).
   - nginx log: `setfacl -m u:velto-monitor:r /var/log/nginx/access.log`; `setfacl -m u:velto-monitor:x /var/log/nginx` (only if the dir is not o+x); `setfacl -d -m u:velto-monitor:r /var/log/nginx` (new files after rotation inherit). Belt and braces: in `/etc/logrotate.d/nginx` add inside `postrotate`: `setfacl -m u:velto-monitor:r /var/log/nginx/access.log 2>/dev/null || true` (keep `create 0640 www-data adm`). Check: `getfacl /var/log/nginx/access.log`, and after `logrotate -f /etc/logrotate.d/nginx` again.
   - backups: `setfacl -m u:velto-monitor:rx "$BACKUP_DIR"` (directory only, files stay 0600). `backup.sh` now runs `chmod o-rwx` on BACKUP_DIR (not `chmod 700`, which would zero the ACL mask).
   First-start order (state files must always belong to `velto-monitor`): 1) create user, 2) create state dir as above, 3) env file, 4) enable timer, 5) enable velto-backup.timer. `backup-run.sh` (root) calls the monitor via `runuser -u velto-monitor` with a clean env, so `--alert/--resolve` state is never root-owned; if the state dir is wrong the monitor now says so loudly (stderr/journal) and exits non-zero (3 for `--alert`: alert delivered, dedup not saved) instead of silently losing dedup.
4. `install -m 755 deploy/monitoring/velto-monitor.sh /usr/local/bin/velto-monitor`; copy `.service`/`.timer` to `/etc/systemd/system/`; `systemctl daemon-reload && systemctl enable --now velto-monitor.timer`.
5. `velto-monitor --dry-run` (prints, sends nothing), then `velto-monitor --test-alert`; the human must confirm receipt. Then drill: stop one dependency in staging/pilot window (e.g. rename `BACKUP_DIR` check or `systemctl stop redis`) and confirm a FAIL alert + RECOVERED.
6. `deploy/monitoring/pm2-logrotate.sh` (as PM2 user).
`monitor.env` is root-owned and SOURCED as shell by `velto-monitor.sh` (keep it root:velto-monitor 0640, never writable by a non-root user). `MONITOR_APP_ENV_FILE` (the app env) is only grep-parsed, never sourced; its values must not carry an inline `# comment` (same rule as `deploy/env-file.js`): such a comment is stripped and a warning is printed. Freshness defaults: `MONITOR_BACKUP_MAX_AGE_MINUTES=100`, `MONITOR_OFFSITE_MAX_AGE_MINUTES=180` (hourly timer + RandomizedDelay + run duration).
Invalid numeric env (`MONITOR_*_MINUTES`, thresholds, cooldown, `MONITOR_DB_PORT`) = a `config FAIL` alert + stderr line; the default is used meanwhile.
Rollback: `systemctl disable --now velto-monitor.timer`; run rollback line at the bottom of `monitor-role.sql`.

## External check (documented, not set up)
The monitor on the same host cannot see a dead host/network. Add one external HTTPS probe (free tier of any uptime service, or a second small host running this script with only the health + TLS checks) on `https://auto-message.uz/velto/api/health/ready`. It sends only the URL; no data. Choice of provider needs PO decision (data-location: probe sees only public URL/status).

## Log redaction (gap)
`apps/api/src/common/trace/trace-logger.ts:5` is a Nest `ConsoleLogger` with traceId: **no JSON format and no redaction config**. Only the AuditLog masks sensitive keys (`common/audit/audit-log.service.ts:32`). Rule until fixed: nginx/PM2 logs must never be sent to third parties; monitor sends none. Code fix (structured redaction) is app work, out of scope here.

## Sentry (documentation only, DO NOT ENABLE)
`SENTRY_DSN` stays empty. Before enabling the PO/lawyer must approve: (1) data inventory: stack traces, request URLs, headers, user ids, breadcrumbs may contain phones, amounts, tokens; require `sendDefaultPii=false`, `beforeSend` scrubbing of body/headers/query, no session replay; (2) hosting: SaaS Sentry stores data abroad, conflicts with the Uzbek personal data localization review (ADR-008, Master TZ section 11.5) -> self-hosted on the pilot region or no-go; (3) subprocessor entry in the DPA. Until then use this script + logs on the server.
