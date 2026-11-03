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
| backup_offsite_rpo | status file `offsite_restore_point_ts` (restore point of the newest set CONFIRMED offsite by listing incl. manifest; kept when an upload fails) | age > 40 min WARN, > 50 min CRIT (50 = RPO 60 - 5 min run interval - delivery); missing/invalid/future = CRIT "no confirmed restore point". Old status files without the field = CRIT |
| backup_offsite_upload | status file `offsite_result` (last upload attempt) | `failed` = CRIT (separate incident from the RPO one); other value = CRIT |
| jobs_stale | PG counts, backoff-aware: Notification `PENDING` past `COALESCE(telegramNextAttemptAt, updatedAt)`+15 min (future backoff = fine), `SENDING` claimed > 10 min ago; ImportJob `PROCESSING` past `LEAST(3600, 300*2^attemptCount)`s + 10 min; ExportJob `QUEUED/PROCESSING` > 25 min | WARN (counts only) |
| jobs_failed | `ImportJob`/`ExportJob` FAILED in the last 60 min | >= 5 CRIT |
| job_mismatch | stale row ids (<= 200, memory only) vs `EXISTS <prefix>:<queue>:<jobId>` (`import-<id>`, `export-<id>`, notification `<id>`); prints only the missing COUNT | 1 run WARN, 2 consecutive runs CRIT |
| queue_* (per queue, Redis) | see "Redis / BullMQ checks" below | see below |
| db_connections | `pg_stat_activity` count | reported only (no threshold yet) |

Ad-hoc alert: `velto-monitor --alert <name> "<short text>"` (no PII/secrets; 300 chars max) sends through the same Telegram path; exit 1 and `ALERT NOT DELIVERED` on stderr if token/chat are unset or Telegram fails. `deploy/backup/backup-run.sh` uses it on backup/offsite failure. Missed backup run = `backup` check above (age > 26 h) fires.

Not covered (gaps): Redis memory/AOF state, RLS test failure (CI only), SMS delivery.
Dedup: run mode = alert on state change, repeat every 6 h, "RECOVERED" on clear. `--alert` = per incident id (name), state in `$MONITOR_STATE_DIR/alerts/` (0700), cooldown `MONITOR_ALERT_COOLDOWN_SECONDS` (3600), re-alert on severity change, `--resolve <name>` sends recovery. Messages contain check names and numbers only: no URLs with tokens, log lines, phones, amounts, PII.

## Install (server, you run; nothing here touches prod by itself)
1. Ops bot: new bot via BotFather (NOT the app bot), send it a message from the responsible person, get chat id (`getUpdates` locally on the server, do not paste into chat).
2. `install -m 600 -o root deploy/monitoring/monitor.env.example /etc/velto/monitor.env`; fill values on the server.
3. DB role: `psql -U postgres -d <pilot_db> -f deploy/monitoring/monitor-role.sql`, then `\password velto_monitor`; set `MONITOR_DB_HOST/PORT/NAME/USER/PASSWORD` in monitor.env (password goes to a temp 0600 PGPASSFILE, never argv). Connection count comes from `velto_monitor.conn_count()` (SECURITY DEFINER, count only); neither `pg_monitor` nor `pg_read_all_stats` is granted to anyone (count(*) needs no privilege). Columns granted (column-level SELECT, no PII/finance/companyId): ImportJob id/status/updatedAt/createdAt/attemptCount; ExportJob id/status/type/updatedAt/createdAt; Notification id/telegramStatus/telegramNextAttemptAt/telegramClaimedAt/updatedAt/createdAt. On an already provisioned DB re-run only the three `GRANT SELECT (...)` lines (additive). BYPASSRLS is needed (FORCE RLS) so it is read-only by `default_transaction_read_only`, column-level GRANT, 5 s timeout, 2 connections.
3b. Service user (root, once): `useradd --system --no-create-home --shell /usr/sbin/nologin velto-monitor`; `chgrp velto-monitor /etc/velto/monitor.env && chmod 640 /etc/velto/monitor.env`. The unit runs as it (no root, no sudo, hardened, NO `adm` group). PM2 is read from a snapshot file (see "Added for the pilot"), so the monitor needs no PM2 access.
3c. Read access by ACL, only what the checks need (root, once; needs the `acl` package):
   - state dir BEFORE anything runs: `install -d -m 700 -o velto-monitor -g velto-monitor /var/lib/velto-monitor` (see first-start order below).
   - nginx log: `setfacl -m u:velto-monitor:r /var/log/nginx/access.log`; `setfacl -m u:velto-monitor:x /var/log/nginx` (only if the dir is not o+x); `setfacl -d -m u:velto-monitor:r /var/log/nginx` (new files after rotation inherit). Belt and braces: in `/etc/logrotate.d/nginx` add inside `postrotate`: `setfacl -m u:velto-monitor:r /var/log/nginx/access.log 2>/dev/null || true` (keep `create 0640 www-data adm`). Check: `getfacl /var/log/nginx/access.log`, and after `logrotate -f /etc/logrotate.d/nginx` again.
   - backups: `setfacl -m u:velto-monitor:rx "$BACKUP_DIR"` (directory only, files stay 0600). `backup.sh` now runs `chmod o-rwx` on BACKUP_DIR (not `chmod 700`, which would zero the ACL mask).
   First-start order (state files must always belong to `velto-monitor`): 1) create user, 2) create state dir as above, 3) env file, 4) enable timer, 5) enable velto-backup.timer. `backup-run.sh` (root) calls the monitor via `runuser -u velto-monitor` with a clean env, so `--alert/--resolve` state is never root-owned; if the state dir is wrong the monitor now says so loudly (stderr/journal) and exits non-zero (3 for `--alert`: alert delivered, dedup not saved) instead of silently losing dedup.
4. `install -m 755 deploy/monitoring/velto-monitor.sh /usr/local/bin/velto-monitor`; copy `.service`/`.timer` to `/etc/systemd/system/`; `systemctl daemon-reload && systemctl enable --now velto-monitor.timer`.
5. `velto-monitor --dry-run` (prints, sends nothing), then `velto-monitor --test-alert`; the human must confirm receipt. Then drill: stop one dependency in staging/pilot window (e.g. rename `BACKUP_DIR` check or `systemctl stop redis`) and confirm a FAIL alert + RECOVERED.
6. `deploy/monitoring/pm2-logrotate.sh` (as PM2 user).
`monitor.env` is root-owned and parsed as data (never sourced) by `velto-monitor.sh` (keep it root:velto-monitor 0640, never writable by a non-root user). `MONITOR_APP_ENV_FILE` (the app env) is only grep-parsed, never sourced; its values must not carry an inline `# comment` (same rule as `deploy/env-file.js`): such a comment is stripped and a warning is printed. Freshness defaults: `MONITOR_BACKUP_MAX_AGE_MINUTES=100` (hourly timer + RandomizedDelay + run duration); offsite uses `MONITOR_OFFSITE_RPO_WARN_MINUTES=40` / `_CRIT_MINUTES=50` (the old `MONITOR_OFFSITE_MAX_AGE_MINUTES` is gone).
Invalid numeric env (`MONITOR_*_MINUTES`, thresholds, cooldown, `MONITOR_DB_PORT`) = a `config FAIL` alert + stderr line; the default is used meanwhile.
Rollback: `systemctl disable --now velto-monitor.timer`; run rollback line at the bottom of `monitor-role.sql`.

## Redis / BullMQ checks (read-only; `MONITOR_BULLMQ_PREFIX` REQUIRED, no default)
Prefix must equal the app `BULLMQ_PREFIX` (pilot `velto-pilot`, `deploy/env.production.example`; code default is read in `apps/api/src/common/queue/queue.module.ts`). `<prefix>:<q>:meta` absent = CRIT `queue_meta` (prefix mismatch / queue never created); the other queue checks do not run for that queue. Redis down = CRIT `redis` + `queues SKIP` (never a false OK).
| Check | Rule |
|---|---|
| queue:<q> | OK row with wait/active/delayed/paused counts and failed delta, only when no issue below |
| queue_failed | failed ZSET growth since the previous run (state file), WARN >= 1, CRIT >= 10 (not the absolute total) |
| queue_wait_age | oldest waiting job (`LINDEX wait -1`): now - (`timestamp` + `delay`); WARN > 10 min, CRIT > 30 min |
| queue_active_age | up to 20 active jobs, now - `processedOn` vs per-queue limit (`MONITOR_QUEUE_ACTIVE_LIMITS`: notification 5, 1c 15, company 30, import 30 min; default 30): WARN > limit, CRIT > 2x |
| queue_no_worker | wait > 0 and `<prefix>:<q>:stalled-check` absent on 2 probes 3 s apart (worker heartbeat) = CRIT |
| queue_stalled | `event=stalled` in `<q>:events` since the last stored stream id: 1-2 WARN, >= 3 or a job with `stc` >= 2 CRIT. First run = baseline only (old events are not alerts) |
| queue_exhausted | `retries-exhausted` events since last run = CRIT |
| queue_events_gap | stored stream id older than the first stream entry (MAXLEN ~10000 trimmed it) = WARN |
| queue_delayed | delayed never CRIT (retry backoff, schedulers are normal); WARN only if the earliest delayed job (`ZRANGE delayed 0 0 WITHSCORES`, score>>12 = ms) is > 15 min overdue |
| queue_paused | paused list non-empty = WARN |
Alerts for stalled/exhausted are event-based (new since last run): they alert once, then show `RECOVERED` on the next clean run; the incident is the event, check the app log by traceId.
Redis 7 ACL (create once on the Redis host as admin; the key pattern pins it to the Velto prefix; password only on the server):
`ACL SETUSER velto_monitor on >'<password>' resetkeys resetchannels -@all %R~velto-pilot:* +ping +exists +llen +lindex +lrange +zcard +zrange +hget +xrange +xrevrange +acl|whoami`
(`ACL SAVE` if `aclfile` is used; otherwise put the same line in redis.conf as `user velto_monitor ...`.) Verify: `redis-cli --user velto_monitor -a ... DEL velto-pilot:x` and `KEYS *` and `CLIENT LIST` must return NOPERM. `+acl|whoami` is required: with a wrong password `redis-cli` silently falls back to the unauthenticated `default` user (PING still answers), so the monitor checks `ACL WHOAMI` equals `MONITOR_REDIS_USER` and reports redis FAIL otherwise. No `+client`, `+keys`, `+scan`, `+info`, no write commands. `-@all` first so a future command category is never inherited. Set `MONITOR_REDIS_USER/PASSWORD` in monitor.env (the user is mandatory and must not be `default`, otherwise redis reports FAIL) (password reaches `redis-cli` via `REDISCLI_AUTH`, never argv).
Residual risk: the ACL cannot restrict fields. `HGET` and `XRANGE` could technically read job data (`data`, `returnvalue`, `failedReason`) and `completed`/`failed` stream entries (which carry return values/reasons). The script only requests `timestamp`, `delay`, `processedOn`, `stc` and parses the stream for the fixed `event`/`jobId` lines; it never prints ids, payloads or reasons, and never writes (no retry/remove/clean). Anyone with the monitor Redis password can read those fields, so keep it in `monitor.env` (root:velto-monitor 0640) only. Load: ~12 small commands per queue every 5 min.
Job ids come from PG (`id` column granted to `velto_monitor`) only to build `EXISTS` keys; the role has no `companyId`/payload column, so it cannot attribute a row to a tenant.

## External check (documented, not set up)
The monitor on the same host cannot see a dead host/network. Add one external HTTPS probe (free tier of any uptime service, or a second small host running this script with only the health + TLS checks) on `https://auto-message.uz/velto/api/health/ready`. It sends only the URL; no data. Choice of provider needs PO decision (data-location: probe sees only public URL/status).

## Log redaction (gap)
`apps/api/src/common/trace/trace-logger.ts:5` is a Nest `ConsoleLogger` with traceId: **no JSON format and no redaction config**. Only the AuditLog masks sensitive keys (`common/audit/audit-log.service.ts:32`). Rule until fixed: nginx/PM2 logs must never be sent to third parties; monitor sends none. Code fix (structured redaction) is app work, out of scope here.

## Sentry (documentation only, DO NOT ENABLE)
`SENTRY_DSN` stays empty. Before enabling the PO/lawyer must approve: (1) data inventory: stack traces, request URLs, headers, user ids, breadcrumbs may contain phones, amounts, tokens; require `sendDefaultPii=false`, `beforeSend` scrubbing of body/headers/query, no session replay; (2) hosting: SaaS Sentry stores data abroad, conflicts with the Uzbek personal data localization review (ADR-008, Master TZ section 11.5) -> self-hosted on the pilot region or no-go; (3) subprocessor entry in the DPA. Until then use this script + logs on the server.
