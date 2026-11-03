#!/usr/bin/env bash
# Scheduled entrypoint (root, systemd velto-backup.service): backup.sh (DB) -> objects-backup.sh (S3 objects) -> offsite-sync.sh -> STATUS ATTESTATION -> alert on ANY failure.
# NOT activated by the repo (user action). The status file (BACKUP_STATUS_DIR/status, root:root 0644 in a root:root 0755 dir) is what deploy.sh checks;
# on any failure a RESULT=failed status is written so a stale 'ok' can never be mistaken for a fresh backup.
# Env file (outside repo, chmod 600, e.g. /etc/velto/backup.env) = backup.sh vars + offsite vars (see offsite-sync.sh).
# Alert hook, first match wins:
#   1. $BACKUP_ALERT_CMD            ABSOLUTE PATH of an executable file (no args, no shell; owned by root, not group/world-writable, parent dir not group/world-writable); called as: cmd <severity> <incident-id> <message>
#   2. velto-monitor --alert backup-<step> "<message>" --severity crit (deduped, recovery via --resolve)  ($VELTO_MONITOR_BIN, else `velto-monitor` in PATH, else deploy/monitoring/velto-monitor.sh); the single Telegram path, token lives in /etc/velto/monitor.env
#   3. fallback: logger -p user.err (journal/syslog) + stderr — a scraper/log alert can match "VELTO-BACKUP-FAILED"
# Exit code is always the failing step's code, so cron MAILTO / systemd OnFailure= also work.
set -uo pipefail
umask 022   # status file 0644; backup.sh/objects-backup.sh set umask 077 themselves for the archives
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="$(hostname 2>/dev/null || echo unknown)"

MON="${VELTO_MONITOR_BIN:-}"
[[ -z "$MON" ]] && MON="$(command -v velto-monitor 2>/dev/null || true)"
[[ -z "$MON" && -x "$HERE/../monitoring/velto-monitor.sh" ]] && MON="$HERE/../monitoring/velto-monitor.sh"

# velto-monitor keeps dedup state owned by its own user. When run as root, call it as that user with a clean env (backup secrets are not
# forwarded) so root never creates root-owned state files that the hardened timer unit (User=velto-monitor) cannot update.
MON_USER="${MONITOR_RUN_USER:-velto-monitor}"
mon() {
  if [[ "$(id -u)" != 0 ]]; then "$MON" "$@"
  elif command -v runuser >/dev/null && id -u "$MON_USER" >/dev/null 2>&1; then runuser -u "$MON_USER" -- env -i PATH="$PATH" "$MON" "$@"
  else command -v logger >/dev/null && logger -p user.err -t velto-backup "velto-monitor NOT run as root (runuser or user $MON_USER missing): $*"; return 1; fi   # never execute $MON as root
}

# Trust anchor for root-run code and the alert hook. BK_ROOT_UID is the LITERAL 0 (not read from env/flags); only the test harness, which SOURCES this
# file (see the guard below) and cannot create root-owned files, reassigns it afterwards. Executing the script never sees another value.
BK_ROOT_UID=0
bk_stat() { stat -c "$1" "$3" 2>/dev/null || stat -f "$2" "$3" 2>/dev/null; }
bk_not_gw() { # path: mode has no group/world write bit
  local perm; perm="$(bk_stat %a %Lp "$1")" || return 1
  [[ "$perm" =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#$perm & 8#022) == 0 ))
}
bk_trusted() { # path: not a symlink, owned by BK_ROOT_UID, not group/world-writable
  [[ ! -L "$1" && -e "$1" && "$(bk_stat %u %u "$1")" == "$BK_ROOT_UID" ]] && bk_not_gw "$1"
}
bk_anc_ok() { # dir: owned by root or BK_ROOT_UID; not group/world-writable, except a ROOT-owned sticky dir (e.g. /tmp: others cannot replace our entries)
  local o m; o="$(bk_stat %u %u "$1")" || return 1; m="$(bk_stat %a %Lp "$1")" || return 1
  [[ "$m" =~ ^[0-7]{3,4}$ ]] || return 1
  [[ "$o" == 0 || "$o" == "$BK_ROOT_UID" ]] || return 1
  (( (8#$m & 8#022) == 0 )) || { [[ "$o" == 0 ]] && (( (8#$m & 8#1000) != 0 )); }
}
# Refuse to run (as root) code another user could have replaced: this script's dir and every script in it (sourced libs / child scripts),
# every ancestor directory of it up to /, and env-file.js (run by root via node in backup-common.sh) with its dir.
bk_self_check() {
  local f bad="" d
  bk_trusted "$HERE" || bad="$HERE"
  for f in "$HERE"/*.sh; do bk_trusted "$f" || bad="$f"; done
  d="$(cd "$HERE" 2>/dev/null && pwd -P)" || d="$HERE"
  while [[ "$d" != / && -n "$d" ]]; do d="$(dirname "$d")"; bk_anc_ok "$d" || bad="$d"; done
  f="$HERE/../env-file.js"
  if [[ -e "$f" || -L "$f" ]]; then bk_trusted "$f" || bad="$f"; bk_trusted "$HERE/.." || bad="$HERE/.."; fi
  [[ -z "$bad" ]] || { echo "[backup-run] REFUSING TO RUN: $bad is not owned by uid $BK_ROOT_UID or is group/world-writable (install a root-owned copy, see velto-backup.service.example)" >&2; return 1; }
}

# Validate BACKUP_ALERT_CMD: absolute path to a regular, executable file owned by root, not group/world-writable (and not a symlink to one), in a parent dir that is not group/world-writable.
# Returns the resolved path on stdout; non-zero = rejected. Never run through a shell: invoked as "$cmd" <severity> <incident-id> <message>.
valid_alert_cmd() {
  local c="$1"
  [[ "$c" == /* && "$c" =~ ^/[A-Za-z0-9._/+-]+$ ]] || return 1
  [[ -f "$c" && -x "$c" ]] || return 1
  [[ "$(bk_stat %u %u "$c")" == "$BK_ROOT_UID" ]] || return 1
  bk_not_gw "$c" || return 1
  bk_not_gw "$(dirname "$c")" || return 1
  printf '%s' "$c"
}
[[ "${BASH_SOURCE[0]}" != "$0" ]] && return 0   # sourced by the test harness: functions only

# Structured message only: step name, exit code, timestamp. Never command output.
alert() { # step rc
  local step="$1" rc="$2" ts msg id="backup-$1" cmd mrc
  ts="$(date -u +%FT%TZ)"
  msg="VELTO-BACKUP-FAILED host=$HOST step=$step exit=$rc ts=$ts"
  echo "[backup-run] $msg" >&2
  if [[ -n "${BACKUP_ALERT_CMD:-}" ]]; then
    if cmd="$(valid_alert_cmd "$BACKUP_ALERT_CMD")"; then "$cmd" crit "$id" "$msg" || echo "[backup-run] alert command failed" >&2
    else echo "[backup-run] BACKUP_ALERT_CMD rejected (need absolute path, regular executable root-owned file, not group/world-writable, parent dir not group/world-writable) - ALERT NOT DELIVERED via it" >&2; command -v logger >/dev/null && logger -p user.err -t velto-backup "$msg"; fi
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

bk_self_check || { alert self-check 1; exit 1; }
# shellcheck source=backup-status-lib.sh
. "$HERE/backup-status-lib.sh"
STATUS_DIR="${BACKUP_STATUS_DIR:-/var/lib/velto-backup}"
BS_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"; export BS_RUN_ID

fail() { # step rc  -> failed attestation (keeps the last confirmed offsite_ts/offsite_result, see bs_write_failed) + alert, exit rc
  bs_write_failed "$STATUS_DIR" "$1" "$2" || echo "[backup-run] could not write the failed status" >&2
  alert "$1" "$2"; exit "$2"
}
[[ -d "$STATUS_DIR" ]] || { echo "[backup-run] status dir $STATUS_DIR missing (create root:root 0755, see deploy/system/)" >&2; alert status-dir 1; exit 1; }

# --- 1. database
OUT="$(bash "$HERE/backup.sh" 2>&1)"; rc=$?
printf '%s\n' "$OUT" | grep -Ev '^(BACKUP_FILE|GLOBALS_FILE)=' | tail -n 20 | redact
[[ $rc -eq 0 ]] || fail backup.sh "$rc"
FILE="$(grep '^BACKUP_FILE=' <<<"$OUT" | tail -n1 | cut -d= -f2-)"
GFILE="$(grep '^GLOBALS_FILE=' <<<"$OUT" | tail -n1 | cut -d= -f2-)"
[[ -s "$FILE" ]] || fail backup-file-missing 1
resolve backup.sh; resolve backup-file-missing

# --- 2. object store (default ON: the DB alone is not a restore point, see docs/release/BACKUP-RESTORE-RUNBOOK.md)
OFILE=""; OBJ_FIELDS=("OBJECTS=disabled")
if [[ "${OBJECTS_BACKUP_ENABLED:-1}" == 1 ]]; then
  OOUT="$(bash "$HERE/objects-backup.sh" 2>&1)"; rc=$?
  printf '%s\n' "$OOUT" | grep -Ev '^OBJECTS_' | tail -n 10 | redact
  [[ $rc -eq 0 ]] || fail objects-backup.sh "$rc"
  OFILE="$(grep '^OBJECTS_FILE=' <<<"$OOUT" | tail -n1 | cut -d= -f2-)"
  [[ -s "$OFILE" ]] || fail objects-file-missing 1
  OBJ_FIELDS=("OBJECTS=ok" "OBJ_COUNT=$(grep '^OBJECTS_COUNT=' <<<"$OOUT" | tail -n1 | cut -d= -f2-)" "OBJ_MANIFEST_SHA256=$(grep '^OBJECTS_MANIFEST_SHA256=' <<<"$OOUT" | tail -n1 | cut -d= -f2-)")
  resolve objects-backup.sh
else
  echo "[backup-run] OBJECTS_BACKUP_ENABLED=0 -> object store NOT backed up (status says OBJECTS=disabled; deploy needs VELTO_REQUIRE_OBJECTS=0)" >&2
fi

# --- 3. offsite (credentials: backup-writer only)
OFFSITE=skipped; OFFSITE_RC=0; OFFSITE_TS=""
PREV_OFF_TS="$(grep -E '^offsite_ts=' "$STATUS_DIR/status" 2>/dev/null | head -n1 | cut -d= -f2-)"; export BACKUP_RUN_ACTIVE=1
if [[ "${OFFSITE_ENABLED:-0}" == 1 ]]; then
  bash "$HERE/offsite-sync.sh"; rc=$?
  if [[ $rc -eq 0 ]]; then OFFSITE=ok; OFFSITE_TS="$(date -u +%s)"; resolve offsite-sync.sh; else OFFSITE=failed; OFFSITE_RC=$rc; fi   # local backup is still valid: attest it, then alert
else
  echo "[backup-run] OFFSITE_ENABLED!=1 -> offsite copy skipped (local only; NOT sufficient for DR)" >&2
fi

# --- 4. attestation: re-hash the final ciphertext files (what deploy.sh will hash), record names/sizes/sha256 only
fields=("VERIFY=ok" "OFFSITE=$OFFSITE" "BACKUP_GLOBALS=$([[ "${BACKUP_GLOBALS:-1}" == 1 ]] && echo 1 || echo 0)" "${OBJ_FIELDS[@]}")   # BACKUP_GLOBALS=1 makes the globals archive mandatory in the deploy gate
# monitor contract: offsite_ts = last CONFIRMED offsite copy (kept from the previous status when this run did not confirm one)
[[ -n "$OFFSITE_TS" ]] || OFFSITE_TS="$PREV_OFF_TS"
[[ -z "$OFFSITE_TS" ]] || fields+=("offsite_ts=$OFFSITE_TS")
fields+=("offsite_result=$([[ $OFFSITE == ok ]] && echo ok || echo "$OFFSITE")")
add() { # PREFIX file
  local b; b="$(basename "$2")"
  fields+=("$1_ARCHIVE=$b" "$1_SIZE=$(bs_size "$2")" "$1_SHA256=$(bs_sha256 "$2")")
}
add DB "$FILE"
[[ -z "$GFILE" ]] || add GLOBALS "$GFILE"
[[ -z "$OFILE" ]] || add OBJ "$OFILE"
bs_write "$STATUS_DIR" ok "${fields[@]}" || fail status-write 1
if [[ $OFFSITE_RC -ne 0 ]]; then alert offsite-sync.sh "$OFFSITE_RC"; exit "$OFFSITE_RC"; fi   # local OK + attested; offsite failure is still an incident
echo "[backup-run] OK run=$BS_RUN_ID status=$STATUS_DIR/status"
