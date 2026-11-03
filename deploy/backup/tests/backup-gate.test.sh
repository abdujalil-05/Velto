#!/usr/bin/env bash
# Negative + positive tests for the deploy backup gate (backup-status-lib.sh / verify-backup-status.sh).
# Runs on macOS and Linux WITHOUT root, no network, no docker.
# Root-ownership test seam (why it cannot be enabled in production):
#   vbs_check takes the expected owner uid as an ARGUMENT. The production entry point (verify-backup-status.sh) passes the literal 0 and
#   has no env var / flag to change it, so there is nothing for an attacker (or a typo) to switch on. This harness is the only caller that
#   passes another uid (its own), because a non-root sandbox cannot create root-owned files. Test: the CLI is run with test-looking env
#   (VELTO_TEST_MODE, VELTO_EXPECTED_UID) and must still reject a non-root-owned status.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../backup-status-lib.sh
. "$HERE/backup-status-lib.sh"
T="$(mktemp -d)"; trap 'chmod -R u+rwx "${T:?}" 2>/dev/null; rm -rf "${T:?}"' EXIT
ME="$(id -u)"; pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }
sha() { bs_sha256 "$1"; }
ZERO64="$(printf 'a%.0s' {1..64})"

# fixture: $T/<n>/{status/,backup/}
write_status() { # dir result [extra...]
  local d="$1" r="$2"; shift 2
  bs_write "$d" "$r" VERIFY=ok OFFSITE=skipped OBJECTS=ok \
    "DB_ARCHIVE=$DB" "DB_SIZE=$(bs_size "$B/$DB")" "DB_SHA256=$(sha "$B/$DB")" \
    "OBJ_ARCHIVE=$OB" "OBJ_SIZE=$(bs_size "$B/$OB")" "OBJ_SHA256=$(sha "$B/$OB")" "$@"
}
mk() { # name -> sets S (status file) B (backup dir) DB OB
  local d="$T/$1"; S="$d/status/status"; B="$d/backup"
  mkdir -p "$d/status" "$B"; chmod 755 "$d/status"; chmod 750 "$B"
  DB="velto-db-20261102-010101.dump.gpg"; OB="velto-objects-20261102-010101.tar.gpg"
  head -c 2048 /dev/urandom > "$B/$DB"; head -c 4096 /dev/urandom > "$B/$OB"; chmod 640 "$B/$DB" "$B/$OB"
  write_status "$d/status" ok
}
check() { vbs_check "$S" "$B" 60 "$ME" 1 2>"$T/err"; }
expect_fail() { # label grep-pattern
  if check; then bad "$1: gate PASSED but must fail"; elif grep -qiE "$2" "$T/err"; then ok "$1"; else bad "$1: failed with unexpected reason: $(head -c 200 "$T/err")"; fi
}
set_ts() { sed -i.bak "s/^TIMESTAMP_EPOCH=.*/TIMESTAMP_EPOCH=$1/" "$S" && rm -f "$S.bak"; }

echo "== positive"
mk pos; check && ok "valid fresh status + intact archives pass" || bad "positive path: $(cat "$T/err")"
[[ "$VBS_DB_ARCHIVE" == velto-db-* && -n "$VBS_RUN_ID" ]] && ok "gate exports run id + archive name" || bad "exports"

echo "== no backup"
mk nob; rm -f "${S:?}"; expect_fail "no status file" "no backup"
mk nob2; rm -f "${S:?}" "${B:?}/${DB:?}"; expect_fail "no status and no archive" "no backup"

echo "== stale"
mk st
if vbs_check "$S" "$B" 60 "$ME" 1 "$(( $(date -u +%s) + 61*60 ))" 2>"$T/err"; then bad "61 min old passed"; else grep -q stale "$T/err" && ok "61 min old -> stale" || bad "stale reason"; fi
vbs_check "$S" "$B" 60 "$ME" 1 "$(( $(date -u +%s) + 59*60 ))" 2>/dev/null && ok "59 min old passes (limit 60)" || bad "59 min boundary"
if vbs_check "$S" "$B" 60 "$ME" 1 "$(( $(date -u +%s) - 600 ))" 2>"$T/err"; then bad "future timestamp passed"; else ok "timestamp in the future rejected"; fi

echo "== corrupted archive"
mk cor1; printf 'X' | dd of="$B/$DB" bs=1 seek=100 conv=notrunc 2>/dev/null; expect_fail "DB byte flipped (sha mismatch, same size)" "sha256 mismatch"
mk cor2; head -c 1000 "$B/$DB" > "$B/x" && mv "$B/x" "$B/$DB"; chmod 640 "$B/$DB"; expect_fail "DB truncated (size mismatch)" "size mismatch"
mk cor3; printf 'X' | dd of="$B/$OB" bs=1 seek=7 conv=notrunc 2>/dev/null; expect_fail "object archive corrupted" "OBJ archive sha256 mismatch"
mk cor4; rm -f "${B:?}/${OB:?}"; expect_fail "object archive missing" "archive missing"
mk cor5; ln -s /etc/hostname "$B/velto-db-20261102-020202.dump.gpg"
bs_write "$T/cor5/status" ok VERIFY=ok OFFSITE=skipped OBJECTS=ok "DB_ARCHIVE=velto-db-20261102-020202.dump.gpg" "DB_SIZE=1" "DB_SHA256=$ZERO64"; expect_fail "archive is a symlink" "archive missing"
mk cor6; bs_write "$T/cor6/status" ok VERIFY=ok OFFSITE=skipped OBJECTS=ok "DB_ARCHIVE=..-etc-passwd" "DB_SIZE=1" "DB_SHA256=$ZERO64"; expect_fail "archive name outside the allowed pattern" "name not allowed"
mk cor7; bs_write "$T/cor7/status" ok VERIFY=ok OFFSITE=skipped OBJECTS=ok "DB_ARCHIVE=$DB" "DB_SIZE=$(bs_size "$B/$DB")" "DB_SHA256=$(sha "$B/$DB")"; expect_fail "objects required but absent in status" "no object-store archive"
mk cor8; chmod 000 "$B/$DB"
if [[ "$ME" == 0 ]]; then ok "unreadable ciphertext (skipped: running as root)"; else expect_fail "ciphertext unreadable by deploy user" "not readable"; fi
chmod 640 "$B/$DB"

echo "== backup service failed"
mk fail1; write_status "$T/fail1/status" failed STEP=backup.sh EXIT=1 2>/dev/null; expect_fail "RESULT=failed in status" "did not succeed"
mk fail2; bs_write "$T/fail2/status" ok VERIFY=skipped OFFSITE=skipped OBJECTS=ok "DB_ARCHIVE=$DB" "DB_SIZE=1" "DB_SHA256=$ZERO64"; expect_fail "VERIFY!=ok" "not verified"
mk fail3; bs_write "$T/fail3/status" ok VERIFY=ok OFFSITE=failed OBJECTS=ok "DB_ARCHIVE=$DB" "DB_SIZE=$(bs_size "$B/$DB")" "DB_SHA256=$(sha "$B/$DB")" "OBJ_ARCHIVE=$OB" "OBJ_SIZE=$(bs_size "$B/$OB")" "OBJ_SHA256=$(sha "$B/$OB")"; 
if check; then ok "OFFSITE=failed alone does not block (local backup valid, alert fires separately)"; else bad "offsite failed must not block when not required"; fi
if VELTO_REQUIRE_OFFSITE=1 check; then bad "VELTO_REQUIRE_OFFSITE=1 with OFFSITE=failed passed"; else grep -q "offsite copy required" "$T/err" && ok "VELTO_REQUIRE_OFFSITE=1 + OFFSITE=failed -> abort" || bad "offsite reason"; fi
# systemctl start: non-zero / success-but-not-refreshed / success-and-refreshed
mk trig; old_ts=$(( $(date -u +%s) - 1800 )); set_ts "$old_ts"
VBS_START_CMD=(false)
if vbs_gate "$S" "$B" 60 "$ME" 1 1 2>"$T/err"; then bad "trigger failure passed"; else grep -q "service failed" "$T/err" && ok "systemctl start non-zero -> abort" || bad "trigger reason"; fi
VBS_START_CMD=(true)
if vbs_gate "$S" "$B" 60 "$ME" 1 1 2>"$T/err"; then bad "service ok but status not refreshed passed"; else grep -q "not refreshed" "$T/err" && ok "service success but status not refreshed -> abort" || bad "refresh reason"; fi
refresh() { write_status "$T/trig/status" ok; }
# shellcheck disable=SC2034  # read by vbs_gate
VBS_START_CMD=(refresh)
vbs_gate "$S" "$B" 60 "$ME" 1 1 2>"$T/err" && ok "trigger -> service writes new status -> pass" || bad "trigger positive: $(cat "$T/err")"
unset VBS_START_CMD

echo "== forged status"
mk fg1; chmod 664 "$S"; expect_fail "status group-writable" "writable"
mk fg2; chmod 646 "$S"; expect_fail "status world-writable" "writable"
mk fg3; chmod 775 "$T/fg3/status"; expect_fail "status dir group-writable" "status directory"
mk fg4; chmod 777 "$T/fg4/status"; expect_fail "status dir world-writable" "status directory"
mk fg5; chmod 770 "$B"; expect_fail "backup dir group-writable" "backup directory"
mk fg6
if vbs_check "$S" "$B" 60 "$((ME+1))" 1 2>"$T/err"; then bad "status not owned by backup uid passed"; else grep -q "not owned" "$T/err" && ok "status not owned by the root identity" || bad "owner reason"; fi
mk fg7; ln -s "$S" "$T/fg7/status/link"; S="$T/fg7/status/link"; expect_fail "status is a symlink" "regular file"
mk fg8; printf 'RESULT=ok\n' >> "$S"; expect_fail "duplicate key injected" "duplicate"
mk fg9; printf 'echo pwned; $(id)\n' >> "$S"; expect_fail "non-KEY=VALUE line injected" "malformed"
if [[ "$ME" != 0 ]]; then
  mk cli; out="$(VELTO_TEST_MODE=1 VELTO_EXPECTED_UID="$ME" VELTO_BACKUP_STATUS_FILE="$S" VELTO_BACKUP_DIR="$B" bash "$HERE/verify-backup-status.sh" 2>&1)"; rc=$?
  [[ $rc -ne 0 && "$out" == *"not owned"* ]] && ok "CLI: test-looking env cannot relax the root-owner check" || bad "CLI accepted non-root status (rc=$rc)"
else ok "CLI uid-0 hard-wire test skipped (running as root)"; fi

echo "== globals mandatory (BACKUP_GLOBALS=1)"
mk gl1; GL="velto-globals-20261102-010101.sql.gpg"; head -c 512 /dev/urandom > "$B/$GL"; chmod 640 "$B/$GL"
write_status "$T/gl1/status" ok BACKUP_GLOBALS=1; expect_fail "BACKUP_GLOBALS=1 without GLOBALS archive" "no GLOBALS archive"
write_status "$T/gl1/status" ok BACKUP_GLOBALS=1 "GLOBALS_ARCHIVE=$GL" "GLOBALS_SIZE=$(bs_size "$B/$GL")" "GLOBALS_SHA256=$(sha "$B/$GL")"; check && ok "BACKUP_GLOBALS=1 with intact GLOBALS archive passes" || bad "globals positive: $(cat "$T/err")"
write_status "$T/gl1/status" ok BACKUP_GLOBALS=0; check && ok "BACKUP_GLOBALS=0 without archive passes" || bad "globals=0: $(cat "$T/err")"

echo "== CLI hardening (verify-backup-status.sh)"
mk cl; : > "$T/pwned.sh"
for v in 1441 99999 abc 1e3 -5; do
  out="$(VELTO_BACKUP_MAX_AGE_MIN=$v VELTO_BACKUP_STATUS_FILE="$S" VELTO_BACKUP_DIR="$B" bash "$HERE/verify-backup-status.sh" 2>&1)"; rc=$?
  [[ $rc -ne 0 && "$out" == *"<= 1440"* ]] && ok "VELTO_BACKUP_MAX_AGE_MIN=$v rejected" || bad "max age $v accepted/other (rc=$rc)"
done
out="$(VELTO_BACKUP_MAX_AGE_MIN=1440 VELTO_BACKUP_STATUS_FILE="$S" VELTO_BACKUP_DIR="$B" bash "$HERE/verify-backup-status.sh" 2>&1)"
[[ "$out" != *"<= 1440"* ]] && ok "1440 is accepted by the cap (fails later only on owner)" || bad "1440 rejected by cap"
VBS_START_CMD="touch $T/injected" VELTO_BACKUP_STATUS_FILE="$S" VELTO_BACKUP_DIR="$B" bash "$HERE/verify-backup-status.sh" --trigger >/dev/null 2>&1
[[ ! -e "$T/injected" ]] && ok "env VBS_START_CMD is not executed (unset at top)" || bad "VBS_START_CMD injected from env"
grep -q 'TRIGGER == 1 ? 60 : 90' "$HERE/verify-backup-status.sh" && ok "default max age: 60 with --trigger, 90 without" || bad "default max age rule"

echo "== failed status keeps offsite fields"
mk kp; bs_write "$T/kp/status" ok VERIFY=ok OFFSITE=ok offsite_ts=1790000000 offsite_result=ok
bs_write_failed "$T/kp/status" backup.sh 2
grep -q '^offsite_ts=1790000000$' "$T/kp/status/status" && grep -q '^offsite_result=ok$' "$T/kp/status/status" && grep -q '^RESULT=failed$' "$T/kp/status/status" && grep -q '^STEP=backup.sh$' "$T/kp/status/status" && ok "failed status preserves offsite_ts/offsite_result" || bad "failed status lost offsite fields: $(tr '\n' ' ' < "$T/kp/status/status")"
mk kp2; rm -f "$T/kp2/status/status"; bs_write_failed "$T/kp2/status" backup.sh 2
! grep -q '^offsite_ts=' "$T/kp2/status/status" && grep -q '^RESULT=failed$' "$T/kp2/status/status" && ok "no previous status: failed status written without offsite fields" || bad "failed status w/o previous"
mk kp3; printf 'garbage\n' > /dev/null; bs_write "$T/kp3/status" ok offsite_ts='$(id)' 2>/dev/null; bs_write "$T/kp3/status" ok offsite_ts=abc offsite_result=ok; bs_write_failed "$T/kp3/status" x 1
! grep -q '^offsite_ts=' "$T/kp3/status/status" && ok "malformed previous offsite_ts dropped" || bad "malformed offsite_ts kept"

echo "== standalone offsite-sync updates OFFSITE= (VELTO_REQUIRE_OFFSITE=1 gate)"
mk os; bs_write "$T/os/status" ok VERIFY=ok OFFSITE=failed OBJECTS=ok "DB_ARCHIVE=$DB" "DB_SIZE=$(bs_size "$B/$DB")" "DB_SHA256=$(sha "$B/$DB")" "OBJ_ARCHIVE=$OB" "OBJ_SIZE=$(bs_size "$B/$OB")" "OBJ_SHA256=$(sha "$B/$OB")" offsite_ts=1790000000 offsite_result=failed
mkdir -p "$T/os/bin"; printf '#!/bin/sh\nexit 0\n' > "$T/os/bin/rclone"; chmod +x "$T/os/bin/rclone"
if VELTO_REQUIRE_OFFSITE=1 check; then bad "OFFSITE=failed passed with REQUIRE_OFFSITE=1"; else ok "before sync: REQUIRE_OFFSITE=1 rejects OFFSITE=failed"; fi
PATH="$T/os/bin:$PATH" BACKUP_DIR="$B" BACKUP_STATUS_DIR="$T/os/status" OFFSITE_BUCKET=b OFFSITE_S3_ENDPOINT=http://127.0.0.1:9 OFFSITE_S3_ACCESS_KEY_ID=k OFFSITE_S3_SECRET_ACCESS_KEY=s BACKUP_REQUIRE_KEY_SEPARATION=0 \
  bash "$HERE/offsite-sync.sh" >"$T/os/out" 2>&1 || bad "offsite-sync.sh failed: $(tail -n3 "$T/os/out")"
grep -q '^OFFSITE=ok$' "$S" && grep -q '^offsite_result=ok$' "$S" && ok "standalone offsite-sync sets OFFSITE=ok and offsite_result=ok" || bad "status not updated: $(tr '\n' ' ' < "$S")"
VELTO_REQUIRE_OFFSITE=1 check && ok "REQUIRE_OFFSITE=1 gate passes after the standalone sync" || bad "gate falsely rejects: $(cat "$T/err")"

echo "== backup-run.sh trust checks (sourced: functions only)"
brun() { ( . "$HERE/backup-run.sh" >/dev/null 2>&1; BK_ROOT_UID="${UIDX:-$ME}"; "$@" ); }
( export BK_ROOT_UID=5; . "$HERE/backup-run.sh" >/dev/null 2>&1; [[ "$BK_ROOT_UID" == 0 ]] ) && ok "BK_ROOT_UID is the literal 0 (env value ignored)" || bad "BK_ROOT_UID not literal 0"
grep -q '^BK_ROOT_UID=0$' "$HERE/backup-run.sh" && ok "production script hard-codes BK_ROOT_UID=0" || bad "literal missing"
mkdir -p "$T/ac"; chmod 755 "$T/ac"; printf '#!/bin/sh\nexit 0\n' > "$T/ac/hook"; chmod 755 "$T/ac/hook"
[[ "$(brun valid_alert_cmd "$T/ac/hook")" == "$T/ac/hook" ]] && ok "alert cmd: owner ok + 0755 file in 0755 dir accepted" || bad "alert cmd positive"
UIDX=$((ME+1)) brun valid_alert_cmd "$T/ac/hook" >/dev/null && bad "alert cmd not owned by root-uid accepted" || ok "alert cmd not owned by uid 0 rejected"
chmod 775 "$T/ac/hook"; brun valid_alert_cmd "$T/ac/hook" >/dev/null && bad "group-writable alert cmd accepted" || ok "group-writable alert cmd rejected"
chmod 755 "$T/ac/hook"; chmod 775 "$T/ac"; brun valid_alert_cmd "$T/ac/hook" >/dev/null && bad "alert cmd in group-writable dir accepted" || ok "alert cmd in group/world-writable parent dir rejected"
chmod 757 "$T/ac"; brun valid_alert_cmd "$T/ac/hook" >/dev/null && bad "alert cmd in world-writable dir accepted" || ok "alert cmd in world-writable parent dir rejected"
# self check on a copy of the script dir
mkdir -p "$T/sc"; cp "$HERE"/*.sh "$T/sc/"; chmod 755 "$T/sc" "$T"/sc/*.sh
sc() { ( HERE="$T/sc"; BK_ROOT_UID="${UIDX:-$ME}"; . "$T/sc/backup-run.sh" >/dev/null 2>&1; HERE="$T/sc"; BK_ROOT_UID="${UIDX:-$ME}"; bk_self_check ) 2>"$T/err"; }
sc && ok "self-check: root-owned (here: test uid) 0755 dir + scripts accepted" || bad "self-check positive: $(cat "$T/err")"
UIDX=$((ME+1)) sc && bad "self-check passed with wrong owner" || ok "self-check: dir/scripts not owned by uid 0 -> refuse"
chmod 775 "$T/sc/backup-status-lib.sh"; sc && bad "self-check passed with group-writable lib" || { grep -q "backup-status-lib.sh" "$T/err" && ok "self-check: group-writable sourced lib -> refuse (names the file)" || bad "self-check reason: $(cat "$T/err")"; }
chmod 755 "$T/sc/backup-status-lib.sh"; chmod 777 "$T/sc"; sc && bad "self-check passed with world-writable dir" || ok "self-check: world-writable script dir -> refuse"
chmod 755 "$T/sc"
chmod 775 "$T"; sc && bad "self-check passed with group-writable parent dir" || { grep -q "$T" "$T/err" && ok "self-check: group-writable ancestor dir -> refuse (names it)" || bad "ancestor reason: $(cat "$T/err")"; }
chmod 700 "$T"; chmod 755 "$T"
sc && ok "self-check: ancestors up to / accepted (root-owned sticky /tmp ok)" || bad "ancestor positive: $(cat "$T/err")"
printf 'x\n' > "$T/env-file.js"; chmod 644 "$T/env-file.js"
sc && ok "self-check: env-file.js trusted (owner uid 0 stand-in, 0644) accepted" || bad "env-file.js positive: $(cat "$T/err")"
chmod 666 "$T/env-file.js"; sc && bad "self-check passed with world-writable env-file.js" || ok "self-check: writable env-file.js -> refuse"
chmod 644 "$T/env-file.js"; UIDX=$((ME+1)) sc && bad "self-check passed with env-file.js not root-owned" || ok "self-check: env-file.js not owned by uid 0 -> refuse"
rm -f "$T/env-file.js"
# mon(): as root without runuser/monitor user must NOT execute the monitor (logger only)
printf '#!/bin/sh\necho ran >> "%s/mon-root.log"\n' "$T" > "$T/ac/mon2"; chmod 755 "$T/ac/mon2"; : > "$T/logger.log"
( VELTO_MONITOR_BIN="$T/ac/mon2" MONITOR_RUN_USER=velto-nouser-xyz . "$HERE/backup-run.sh" >/dev/null 2>&1
  id() { if [[ "${1:-}" == -u && -z "${2:-}" ]]; then echo 0; else command id "$@"; fi; }
  logger() { echo "$*" >> "$T/logger.log"; }
  mon --alert x y; echo "rc=$?" >> "$T/logger.log" )
[[ ! -e "$T/mon-root.log" ]] && grep -q 'NOT run as root' "$T/logger.log" && grep -q 'rc=1' "$T/logger.log" && ok "mon(): root without monitor user -> logger only, monitor not executed" || bad "mon() ran monitor as root or no log: $(cat "$T/logger.log")"
if [[ "$ME" != 0 ]]; then
  printf '#!/bin/sh\necho "$@" >> "%s/mon.log"\n' "$T" > "$T/ac/mon"; chmod 755 "$T/ac/mon"
  out="$(VELTO_MONITOR_BIN="$T/ac/mon" BACKUP_STATUS_DIR="$T/os/status" bash "$T/sc/backup-run.sh" 2>&1)"; rc=$?
  [[ $rc -ne 0 && "$out" == *"REFUSING TO RUN"* ]] && ok "executing the copy as a non-root user refuses to run" || bad "script ran from non-root-owned dir (rc=$rc)"
  grep -q "backup-self-check" "$T/mon.log" 2>/dev/null && ok "refusal raises the alert backup-self-check" || bad "no alert on self-check refusal"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"; [[ $fail -eq 0 ]]
