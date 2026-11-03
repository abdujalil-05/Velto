#!/usr/bin/env bash
# Scheduled entrypoint (root, systemd velto-backup.service, every 20 min): backup.sh (DB + financial fingerprint, one snapshot) -> objects-backup.sh (S3 objects) -> restore-set MANIFEST
# -> detached gpg SIGNATURE of the manifest (separate signing key) -> offsite-sync.sh (upload + listing + sha256 READ-BACK) -> STATUS ATTESTATION -> alert on ANY failure.
# flock: a second run while one is active exits 0 without touching anything (the monitor's staleness thresholds catch a run that never finishes).
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
# shellcheck source=backup-common.sh
. "$HERE/backup-common.sh"
STATUS_DIR="${BACKUP_STATUS_DIR:-/var/lib/velto-backup}"
BS_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"; export BS_RUN_ID

fail() { # step rc  -> failed attestation (keeps the last confirmed offsite_ts/offsite_result, see bs_write_failed) + alert, exit rc
  bs_write_failed "$STATUS_DIR" "$1" "$2" || echo "[backup-run] could not write the failed status" >&2
  alert "$1" "$2"; exit "$2"
}
[[ -d "$STATUS_DIR" ]] || { echo "[backup-run] status dir $STATUS_DIR missing (create root:root 0755, see deploy/system/)" >&2; alert status-dir 1; exit 1; }

# No overlap (in addition to Type=oneshot): kernel-released flock on a root-owned file. No flock = fail closed (BACKUP_ALLOW_NO_FLOCK=1 only for macOS dev/test harness).
LOCK="${BACKUP_LOCK_FILE:-$STATUS_DIR/.backup-run.lock}"
if command -v flock >/dev/null; then
  exec 9>"$LOCK" || { echo "[backup-run] cannot open lock $LOCK" >&2; alert lock 1; exit 1; }
  # lock busy is REPORTED (alert + exit 75, resolved by the next run that gets the lock), never a silent success: a stuck holder must page someone
  flock -n 9 || { echo "[backup-run] previous run still active (lock $LOCK): this run is skipped" >&2; alert lock-busy 75; exit 75; }
  resolve lock-busy
elif [[ "${BACKUP_ALLOW_NO_FLOCK:-0}" != 1 ]]; then echo "[backup-run] flock not found: refusing to run without an overlap lock" >&2; alert flock-missing 1; exit 1; fi

# --- 1. database. restore_point_ts = epoch captured IMMEDIATELY BEFORE pg_dump starts: the dump's snapshot is taken after it, so the set contains every
# commit up to restore_point_ts (conservative: never later than the real snapshot). The objects snapshot starts after the DB dump (objects_snapshot_ts >= restore_point_ts),
# so every object the DB references at restore_point_ts is already in the bucket (the app never deletes objects).
RESTORE_POINT_TS="$(date -u +%s)"
OUT="$(bash "$HERE/backup.sh" 2>&1)"; rc=$?
printf '%s\n' "$OUT" | grep -Ev '^(BACKUP_FILE|GLOBALS_FILE|FP_FILE)=' | tail -n 20 | redact
[[ $rc -eq 0 ]] || fail backup.sh "$rc"
FILE="$(grep '^BACKUP_FILE=' <<<"$OUT" | tail -n1 | cut -d= -f2-)"
GFILE="$(grep '^GLOBALS_FILE=' <<<"$OUT" | tail -n1 | cut -d= -f2-)"
FPFILE="$(grep '^FP_FILE=' <<<"$OUT" | tail -n1 | cut -d= -f2-)"
[[ -s "$FILE" ]] || fail backup-file-missing 1
[[ -s "$FPFILE" ]] || fail fingerprint-missing 1   # R4: no financial fingerprint = no restore point
resolve backup.sh; resolve backup-file-missing

# --- 2. object store (default ON: the DB alone is not a restore point, see docs/release/BACKUP-RESTORE-RUNBOOK.md)
OFILE=""; OBJ_COUNT=""; OBJ_MSHA=""; OBJ_FIELDS=("OBJECTS=disabled")
if [[ "${OBJECTS_BACKUP_ENABLED:-1}" == 1 ]]; then
  OBJECTS_SNAPSHOT_TS="$(date -u +%s)"
  OOUT="$(bash "$HERE/objects-backup.sh" 2>&1)"; rc=$?
  printf '%s\n' "$OOUT" | grep -Ev '^OBJECTS_' | tail -n 10 | redact
  [[ $rc -eq 0 ]] || fail objects-backup.sh "$rc"
  OFILE="$(grep '^OBJECTS_FILE=' <<<"$OOUT" | tail -n1 | cut -d= -f2-)"
  [[ -s "$OFILE" ]] || fail objects-file-missing 1
  OBJ_COUNT="$(grep '^OBJECTS_COUNT=' <<<"$OOUT" | tail -n1 | cut -d= -f2-)"; OBJ_MSHA="$(grep '^OBJECTS_MANIFEST_SHA256=' <<<"$OOUT" | tail -n1 | cut -d= -f2-)"
  OBJ_FIELDS=("OBJECTS=ok" "OBJ_COUNT=$OBJ_COUNT" "OBJ_MANIFEST_SHA256=$OBJ_MSHA")
  resolve objects-backup.sh
else
  echo "[backup-run] OBJECTS_BACKUP_ENABLED=0 -> object store NOT backed up (status says OBJECTS=disabled; deploy needs VELTO_REQUIRE_OBJECTS=0)" >&2
fi

# --- 3. restore-set manifest: final archives hashed ONCE (the same values go to the manifest and to the status). No objects archive = NOT a restore point.
arch=()
add() { # PREFIX file
  arch+=("$1_ARCHIVE=$(basename "$2")" "$1_SIZE=$(bs_size "$2")" "$1_SHA256=$(bs_sha256 "$2")")
}
add DB "$FILE"
add FP "$FPFILE"
[[ -z "$GFILE" ]] || add GLOBALS "$GFILE"
[[ -z "$OFILE" ]] || add OBJ "$OFILE"
BKG="$([[ "${BACKUP_GLOBALS:-1}" == 1 ]] && echo 1 || echo 0)"   # BACKUP_GLOBALS=1 makes the globals archive mandatory (deploy gate + manifest)
MAN=""; MANIFEST_FIELDS=()
if [[ -n "$OFILE" ]]; then
  MAN="$(dirname "$FILE")/velto-set-$(basename "$FILE" | sed -E 's/^velto-db-([0-9]{8}-[0-9]{6})\..*$/\1/').manifest"
  if bsm_write "$MAN" "RUN_ID=$BS_RUN_ID" "SET_TS=$(basename "$MAN" | sed -E 's/^velto-set-(.*)\.manifest$/\1/')" "RESTORE_POINT_TS=$RESTORE_POINT_TS" "OBJECTS_SNAPSHOT_TS=$OBJECTS_SNAPSHOT_TS" OBJECTS=ok "BACKUP_GLOBALS=$BKG" \
       "OBJ_COUNT=${OBJ_COUNT}" "OBJ_MANIFEST_SHA256=${OBJ_MSHA}" OFFSITE_VERIFY=readback-sha256 "${arch[@]}"; then
    bsm_verify "$MAN" "$(dirname "$FILE")" 1 || { echo "[backup-run] manifest self-check failed: $BSM_REASON" >&2; fail manifest-verify 1; }
    # R1: sign the manifest (private key only in the root-owned BACKUP_SIGN_GNUPGHOME) and verify the result the way a restore would (independent public key + pinned fingerprints).
    sk_o="$(bk_stat %u %u "${BACKUP_SIGN_GNUPGHOME:-/nonexistent}")"; sk_m="$(bk_stat %a %Lp "${BACKUP_SIGN_GNUPGHOME:-/nonexistent}")"
    [[ -d "${BACKUP_SIGN_GNUPGHOME:-}" && "$sk_o" == "$BK_ROOT_UID" && "$sk_m" =~ ^[0-7]{3,4}$ ]] && (( (8#$sk_m & 8#077) == 0 )) \
      || { echo "[backup-run] BACKUP_SIGN_GNUPGHOME must be a root-owned directory with mode 0700" >&2; fail sign-key-perms 1; }
    if [[ -n "${BACKUP_SIGN_PASSPHRASE_FILE:-}" ]]; then
      pf_o="$(bk_stat %u %u "$BACKUP_SIGN_PASSPHRASE_FILE")"; pf_m="$(bk_stat %a %Lp "$BACKUP_SIGN_PASSPHRASE_FILE")"
      [[ -f "$BACKUP_SIGN_PASSPHRASE_FILE" && ! -L "$BACKUP_SIGN_PASSPHRASE_FILE" && "$pf_o" == "$BK_ROOT_UID" && "$pf_m" =~ ^(600|400)$ ]] \
        || { echo "[backup-run] BACKUP_SIGN_PASSPHRASE_FILE must be a root-owned regular file with mode 0600/0400" >&2; fail sign-key-perms 1; }
    fi
    bsm_sign "$MAN" || { echo "[backup-run] manifest signing failed: $BSM_REASON" >&2; fail manifest-sign 1; }
    bsm_sig_verify "$MAN" || { echo "[backup-run] manifest signature self-check failed: $BSM_REASON" >&2; fail manifest-sign 1; }
    if [[ -n "${BACKUP_READ_GROUP:-}" ]]; then
      for sf in "$MAN" "$MAN.sig"; do chgrp "$BACKUP_READ_GROUP" "$sf" && chmod 640 "$sf"; done || fail manifest-perms 1
    fi
    MANIFEST_FIELDS=("SET_MANIFEST=$(basename "$MAN")" "SET_MANIFEST_SHA256=$(bs_sha256 "$MAN")" "restore_point_ts=$RESTORE_POINT_TS")
  else fail manifest-write 1; fi
else
  echo "[backup-run] no objects archive -> NO restore-set manifest: this run is NOT a restore point (DB-only)" >&2
fi

# --- 4. offsite (credentials: backup-writer put-only + a separate read-only verify identity). Attested ONLY after offsite-sync.sh uploaded archives, listed them, uploaded manifest+sig
# and READ BACK every object with a matching sha256 (size alone is not proof);
# the marker line must name THIS run's restore point, so a bare exit 0 is never enough.
OFFSITE=skipped; OFFSITE_RC=0; OFFSITE_TS=""; OFFSITE_RP=""; OFFSITE_STEP=offsite-sync.sh
export BACKUP_RUN_ACTIVE=1
if [[ "${OFFSITE_ENABLED:-0}" == 1 && -n "$MAN" ]]; then
  FOUT="$(OFFSITE_MANIFEST="$MAN" bash "$HERE/offsite-sync.sh" 2>&1)"; rc=$?
  printf '%s\n' "$FOUT" | grep -v '^OFFSITE_VERIFIED_' | tail -n 20 | redact
  if [[ $rc -eq 0 && "$(grep '^OFFSITE_VERIFIED_RESTORE_POINT_TS=' <<<"$FOUT" | tail -n1 | cut -d= -f2-)" == "$RESTORE_POINT_TS" ]]; then
    OFFSITE=ok; OFFSITE_TS="$(date -u +%s)"; OFFSITE_RP="$RESTORE_POINT_TS"; resolve offsite-sync.sh
  else OFFSITE=failed; OFFSITE_RC=$rc; [[ $rc -ne 0 ]] || OFFSITE_RC=11; fi   # local backup is still valid: attest it (offsite_result=failed), then alert
elif [[ "${OFFSITE_ENABLED:-0}" == 1 ]]; then
  echo "[backup-run] OFFSITE_ENABLED=1 but this run has no restore set (objects backup disabled): nothing uploaded, offsite NOT attested" >&2
  OFFSITE=failed; OFFSITE_RC=12; OFFSITE_STEP=offsite-no-restore-set   # misconfiguration, not a success: attest offsite_result=failed, alert, non-zero exit
else
  echo "[backup-run] OFFSITE_ENABLED!=1 -> offsite copy skipped (local only; NOT sufficient for DR)" >&2
fi

# --- 5. attestation: record names/sizes/sha256 only. Monitor contract (lowercase keys): restore_point_ts (this run's set, if a restore point),
# offsite_restore_point_ts / offsite_ts = last VERIFIED offsite set (kept from the previous status unless this run verified one), offsite_result ok|failed.
fields=("VERIFY=ok" "OFFSITE=$OFFSITE" "BACKUP_GLOBALS=$BKG" "${OBJ_FIELDS[@]}")
if [[ "$OFFSITE" == ok ]]; then fields+=("offsite_restore_point_ts=$OFFSITE_RP" "offsite_ts=$OFFSITE_TS" offsite_result=ok)
else
  while IFS= read -r l; do [[ -z "$l" || "$l" == offsite_result=* ]] || fields+=("$l"); done < <(bs_prev_offsite "$STATUS_DIR")
  fields+=("offsite_result=$OFFSITE")
fi
fields+=(${MANIFEST_FIELDS[@]+"${MANIFEST_FIELDS[@]}"} "${arch[@]}")
bs_write "$STATUS_DIR" ok "${fields[@]}" || fail status-write 1
# retention LAST: only after THIS set is complete, signed and verified (a failed run never prunes). Keepers must pass the manifest/sha256 check; the newest verified set is never deleted.
if [[ -n "$MAN" ]]; then
  bsm_verify_ok() { bsm_verify "$1" "$2" 1; }
  BK_PRUNE_VERIFY=bsm_verify_ok bk_prune_sets "$BACKUP_DIR" "${BACKUP_KEEP_ALL_HOURS:-48}" "${BACKUP_RETENTION_DAYS:-30}" | tail -n 5; [[ ${PIPESTATUS[0]} -eq 0 ]] || echo "[backup-run] WARN: retention failed" >&2
fi
if [[ $OFFSITE_RC -ne 0 ]]; then alert "$OFFSITE_STEP" "$OFFSITE_RC"; exit "$OFFSITE_RC"; fi   # local OK + attested; offsite failure is still an incident
echo "[backup-run] OK run=$BS_RUN_ID status=$STATUS_DIR/status"
