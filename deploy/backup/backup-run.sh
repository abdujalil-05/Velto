#!/usr/bin/env bash
# Scheduled entrypoint (cron/systemd): backup.sh -> offsite-sync.sh -> alert on ANY failure. NOT activated by the repo (user action).
# Env file (outside repo, chmod 600, e.g. /etc/velto/backup.env) = backup.sh vars + offsite vars (see offsite-sync.sh).
# Alert hook, first match wins:
#   1. $BACKUP_ALERT_CMD            ABSOLUTE PATH of an executable file (no args, no shell; not group/world-writable); called as: cmd <severity> <incident-id> <message>
#   2. velto-monitor --alert backup-<step> "<message>" --severity crit (deduped, recovery via --resolve)  ($VELTO_MONITOR_BIN, else `velto-monitor` in PATH, else deploy/monitoring/velto-monitor.sh); the single Telegram path, token lives in /etc/velto/monitor.env
#   3. fallback: logger -p user.err (journal/syslog) + stderr — a scraper/log alert can match "VELTO-BACKUP-FAILED"
# Exit code is always the failing step's code, so cron MAILTO / systemd OnFailure= also work.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="$(hostname 2>/dev/null || echo unknown)"

MON="${VELTO_MONITOR_BIN:-}"
[[ -z "$MON" ]] && MON="$(command -v velto-monitor 2>/dev/null || true)"
[[ -z "$MON" && -x "$HERE/../monitoring/velto-monitor.sh" ]] && MON="$HERE/../monitoring/velto-monitor.sh"

# velto-monitor keeps dedup state owned by its own user. When run as root, call it as that user with a clean env (backup secrets are not
# forwarded) so root never creates root-owned state files that the hardened timer unit (User=velto-monitor) cannot update.
MON_USER="${MONITOR_RUN_USER:-velto-monitor}"
mon() {
  if [[ "$(id -u)" == 0 ]] && command -v runuser >/dev/null && id -u "$MON_USER" >/dev/null 2>&1; then
    runuser -u "$MON_USER" -- env -i PATH="$PATH" "$MON" "$@"
  else "$MON" "$@"; fi
}

# Validate BACKUP_ALERT_CMD: absolute path to a regular, executable file, not group/world-writable (and not a symlink to one).
# Returns the resolved path on stdout; non-zero = rejected. Never run through a shell: invoked as "$cmd" <severity> <incident-id> <message>.
valid_alert_cmd() {
  local c="$1" perm
  [[ "$c" == /* && "$c" =~ ^/[A-Za-z0-9._/+-]+$ ]] || return 1
  [[ -f "$c" && -x "$c" ]] || return 1
  perm="$(stat -c %a "$c" 2>/dev/null || stat -f %Lp "$c" 2>/dev/null)" || return 1
  [[ "$perm" =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#$perm & 8#022) == 0 )) || return 1
  printf '%s' "$c"
}

# Structured message only: step name, exit code, timestamp. Never command output.
alert() { # step rc
  local step="$1" rc="$2" ts msg id="backup-$1" cmd mrc
  ts="$(date -u +%FT%TZ)"
  msg="VELTO-BACKUP-FAILED host=$HOST step=$step exit=$rc ts=$ts"
  echo "[backup-run] $msg" >&2
  if [[ -n "${BACKUP_ALERT_CMD:-}" ]]; then
    if cmd="$(valid_alert_cmd "$BACKUP_ALERT_CMD")"; then "$cmd" crit "$id" "$msg" || echo "[backup-run] alert command failed" >&2
    else echo "[backup-run] BACKUP_ALERT_CMD rejected (need absolute path, regular executable file, not group/world-writable) - ALERT NOT DELIVERED via it" >&2; command -v logger >/dev/null && logger -p user.err -t velto-backup "$msg"; fi
  elif [[ -n "$MON" ]]; then
    mon --alert "$id" "$msg" --severity crit; mrc=$?   # 3 = delivered but dedup state not written (monitor already logged it)
    [[ $mrc -eq 0 || $mrc -eq 3 ]] || { echo "[backup-run] ALERT NOT DELIVERED via velto-monitor" >&2; command -v logger >/dev/null && logger -p user.err -t velto-backup "$msg"; }
  else command -v logger >/dev/null && logger -p user.err -t velto-backup "$msg"; fi
}
resolve() { # step: recovery notice (velto-monitor path only; no-op if no open incident)
  [[ -z "${BACKUP_ALERT_CMD:-}" && -n "$MON" ]] && { mon --resolve "backup-$1" || true; }
}

# Local log only: redact secrets, last 20 lines. Output is NEVER sent to alerts.
redact() {
  sed -E \
    -e 's#([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@[:space:]]*@#\1[REDACTED]@#g' \
    -e 's#(PGPASSWORD|PASSWORD|PASSPHRASE|passphrase|password|passwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|key)([A-Za-z0-9_]*)[[:space:]]*[=:][[:space:]]*[^[:space:]]+#\1\2=[REDACTED]#Ig' \
    -e 's#(--passphrase(-file|-fd)?)[[:space:]]+[^[:space:]]+#\1 [REDACTED]#g'
}

OUT="$(bash "$HERE/backup.sh" 2>&1)"; rc=$?
printf '%s\n' "$OUT" | grep -v '^BACKUP_FILE=' | tail -n 20 | redact
if [[ $rc -ne 0 ]]; then alert backup.sh "$rc"; exit $rc; fi
FILE="$(grep '^BACKUP_FILE=' <<<"$OUT" | tail -n1 | cut -d= -f2-)"
[[ -s "$FILE" ]] || { alert backup-file-missing 1; exit 1; }
resolve backup.sh; resolve backup-file-missing

if [[ "${OFFSITE_ENABLED:-0}" == 1 ]]; then
  bash "$HERE/offsite-sync.sh"; rc=$?
  [[ $rc -eq 0 ]] || { alert offsite-sync.sh "$rc"; exit $rc; }
  resolve offsite-sync.sh
else
  echo "[backup-run] OFFSITE_ENABLED!=1 -> offsite copy skipped (local only; NOT sufficient for DR)" >&2
fi
echo "[backup-run] OK"
