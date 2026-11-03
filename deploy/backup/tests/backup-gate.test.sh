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
# throwaway signing keys: K1 = the production-like signer (trusted), K2 = rotation successor, K3 = untrusted outsider
# shellcheck source=sign-fixture.sh
. "$HERE/tests/sign-fixture.sh"
SH1="$T/sign1"; SH2="$T/sign2"; SH3="$T/sign3"
F1="$(mk_signkey "$SH1" one)"; F2="$(mk_signkey "$SH2" two)"; F3="$(mk_signkey "$SH3" three)"
pub_export "$SH1" "$F1" "$T/pub1.gpg"; pub_export "$SH2" "$F2" "$T/pub2.gpg"; cat "$T/pub1.gpg" "$T/pub2.gpg" > "$T/pub12.gpg"
export BACKUP_SIGN_GNUPGHOME="$SH1" BACKUP_SIGN_KEY_FPR="$F1" BACKUP_VERIFY_KEYRING="$T/pub1.gpg" BACKUP_TRUSTED_SIGN_FPRS="$F1"
trap 'kill_agents "$SH1" "$SH2" "$SH3" "$T/sigx"; chmod -R u+rwx "${T:?}" 2>/dev/null; rm -rf "${T:?}"' EXIT

# fake rclone (local dir as the remote "VOFF:<bucket>" = $FAKE_REMOTE/<bucket>): copy --files-from / lsf. Fault injection via env:
#   FAKE_RCLONE_FAIL_COPY=1 (upload errors) FAKE_RCLONE_TRUNC=<substr> (stores half the bytes: size mismatch) FAKE_RCLONE_SKIP=<substr> (exit 0, object never stored)
#   FAKE_RCLONE_FAIL_LSF=1. Every stored name is appended to $FAKE_REMOTE/.puts (upload order).
mkrclone() { # bindir
  mkdir -p "$1"
  cat > "$1/rclone" <<'FAKE'
#!/usr/bin/env bash
cmd="$1"; shift; pos=(); ff=""
while [[ $# -gt 0 ]]; do case "$1" in
  --files-from) ff="$2"; shift 2;; --include|--format|--separator|--retries|--low-level-retries|--max-age|--filter) shift 2;;
  -*) shift;; *) pos+=("$1"); shift;; esac; done
rdir() { local r="${1#*:}"; echo "$FAKE_REMOTE/$r"; }
case "$cmd" in
  copy)
    [[ "${FAKE_RCLONE_FAIL_COPY:-0}" == 1 ]] && { echo "fake rclone: upload failed" >&2; exit 1; }
    d="$(rdir "${pos[1]}")"; mkdir -p "$d"
    while IFS= read -r n; do
      [[ -n "${FAKE_RCLONE_SKIP:-}" && "$n" == *"$FAKE_RCLONE_SKIP"* ]] && continue
      [[ -e "$d/$n" ]] && continue
      if [[ -n "${FAKE_RCLONE_TRUNC:-}" && "$n" == *"$FAKE_RCLONE_TRUNC"* ]]; then head -c "$(( $(wc -c < "${pos[0]}/$n") / 2 ))" "${pos[0]}/$n" > "$d/$n"
      elif [[ -n "${FAKE_RCLONE_CORRUPT:-}" && "$n" == *"$FAKE_RCLONE_CORRUPT"* ]]; then { b="$(head -c1 "${pos[0]}/$n")"; [[ "$b" == Z ]] && printf 'Y' || printf 'Z'; tail -c +2 "${pos[0]}/$n"; } > "$d/$n"   # SAME size, different content (first byte always changed)
      else cp "${pos[0]}/$n" "$d/$n"; fi
      echo "$n" >> "$FAKE_REMOTE/.puts"
    done < "$ff";;
  cat)
    [[ "${FAKE_RCLONE_FAIL_CAT:-0}" == 1 ]] && exit 1
    [[ "${pos[0]}" == VRD:* ]] || { echo "fake rclone: cat only through the VRD (read-only) remote" >&2; exit 2; }
    cat "$(rdir "${pos[0]}")"; exit $?;;
  lsf)
    [[ "${FAKE_RCLONE_FAIL_LSF:-0}" == 1 ]] && exit 1
    d="$(rdir "${pos[0]}")"; [[ -d "$d" ]] || exit 0
    for f in "$d"/*; do [[ -f "$f" ]] && printf '%s\t%s\n' "$(basename "$f")" "$(wc -c < "$f" | tr -d ' ')"; done; exit 0;;
  *) exit 1;;
esac
FAKE
  chmod +x "$1/rclone"
}
# fixture: $T/<n>/{status/,backup/}. Every status carries its restore-set manifest (a restore point needs one); OFFS overrides OFFSITE=
BS_RUN_ID=gate-test; export BS_RUN_ID
RP0=1790000000
write_status() { # dir result [extra...]   extra GLOBALS_*/BACKUP_GLOBALS=* also go to the manifest
  local d="$1" r="$2" kv mfx=(); shift 2
  for kv in "$@"; do case "$kv" in GLOBALS_*|BACKUP_GLOBALS=*) mfx+=("$kv");; esac; done
  MF="velto-set-20261102-010101.manifest"
  bsm_write "$B/$MF" "RUN_ID=$BS_RUN_ID" "RESTORE_POINT_TS=$RP0" "OBJECTS_SNAPSHOT_TS=$((RP0+5))" OBJECTS=ok OFFSITE_VERIFY=readback-sha256 \
    "DB_ARCHIVE=$DB" "DB_SIZE=$(bs_size "$B/$DB")" "DB_SHA256=$(sha "$B/$DB")" \
    "OBJ_ARCHIVE=$OB" "OBJ_SIZE=$(bs_size "$B/$OB")" "OBJ_SHA256=$(sha "$B/$OB")" ${mfx[@]+"${mfx[@]}"}
  bsm_sign "$B/$MF"
  chmod 640 "$B/$MF"
  bs_write "$d" "$r" VERIFY=ok "OFFSITE=${OFFS:-skipped}" OBJECTS=ok \
    "DB_ARCHIVE=$DB" "DB_SIZE=$(bs_size "$B/$DB")" "DB_SHA256=$(sha "$B/$DB")" \
    "OBJ_ARCHIVE=$OB" "OBJ_SIZE=$(bs_size "$B/$OB")" "OBJ_SHA256=$(sha "$B/$OB")" \
    "SET_MANIFEST=$MF" "SET_MANIFEST_SHA256=$(sha "$B/$MF")" "restore_point_ts=$RP0" "$@"
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
mk fail3; OFFS=failed write_status "$T/fail3/status" ok
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
mk os; OFFS=failed write_status "$T/os/status" ok offsite_ts=1790000000 offsite_result=failed
mkrclone "$T/os/bin"; FRM="$T/os/remote"
if VELTO_REQUIRE_OFFSITE=1 check; then bad "OFFSITE=failed passed with REQUIRE_OFFSITE=1"; else ok "before sync: REQUIRE_OFFSITE=1 rejects OFFSITE=failed"; fi
FAKE_REMOTE="$FRM" PATH="$T/os/bin:$PATH" BACKUP_DIR="$B" BACKUP_STATUS_DIR="$T/os/status" OFFSITE_BUCKET=b OFFSITE_S3_ENDPOINT=http://127.0.0.1:9 OFFSITE_S3_ACCESS_KEY_ID=k OFFSITE_S3_SECRET_ACCESS_KEY=s OFFSITE_VERIFY_S3_ACCESS_KEY_ID=rk OFFSITE_VERIFY_S3_SECRET_ACCESS_KEY=rs BACKUP_REQUIRE_KEY_SEPARATION=0 \
  bash "$HERE/offsite-sync.sh" >"$T/os/out" 2>&1 || bad "offsite-sync.sh failed: $(tail -n3 "$T/os/out")"
grep -q '^OFFSITE=ok$' "$S" && grep -q '^offsite_result=ok$' "$S" && grep -q "^offsite_restore_point_ts=$RP0\$" "$S" && ok "standalone offsite-sync (upload + listing verification) sets OFFSITE=ok, offsite_result=ok, offsite_restore_point_ts" || bad "status not updated: $(tr '\n' ' ' < "$S")"
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


echo "== restore point + VERIFIED offsite (backup-run.sh: stub backup/objects, fake rclone)"
sv() { grep -E "^$1=" "$RS/status" | head -n1 | cut -d= -f2-; }
mkrun() { # name -> R (script dir) RB (backups) RS (status dir) RR (fake remote) RBIN RM (alert log) RO (output)
  local d="$T/$1"; R="$d/run"; RB="$d/backup"; RS="$d/status"; RR="$d/remote"; RBIN="$d/bin"; RO="$d/out"; RM="$d/alerts.log"
  mkdir -p "$R" "$RB" "$RS" "$RR"; chmod 755 "$d" "$R" "$RS"; chmod 750 "$RB"; mkrclone "$RBIN"
  cp "$HERE/backup-run.sh" "$HERE/backup-status-lib.sh" "$HERE/offsite-sync.sh" "$HERE/backup-common.sh" "$R/"
  sed -i.bak "s/^BK_ROOT_UID=0\$/BK_ROOT_UID=$ME/" "$R/backup-run.sh" && rm -f "$R/backup-run.sh.bak"
  printf '%s\n' '#!/usr/bin/env bash' 'TS="${STUB_TS:?}"' 'head -c 3000 /dev/urandom > "$BACKUP_DIR/velto-db-$TS.dump.gpg"; head -c 500 /dev/urandom > "$BACKUP_DIR/velto-globals-$TS.sql.gpg"; [[ "${STUB_NO_FP:-0}" == 1 ]] || head -c 400 /dev/urandom > "$BACKUP_DIR/velto-fp-$TS.txt.gpg"' \
    'echo "GLOBALS_FILE=$BACKUP_DIR/velto-globals-$TS.sql.gpg"; [[ "${STUB_NO_FP:-0}" == 1 ]] || echo "FP_FILE=$BACKUP_DIR/velto-fp-$TS.txt.gpg"; echo "BACKUP_FILE=$BACKUP_DIR/velto-db-$TS.dump.gpg"' > "$R/backup.sh"
  printf '%s\n' '#!/usr/bin/env bash' 'TS="${STUB_TS:?}"; [[ "${STUB_OBJ_FAIL:-0}" == 1 ]] && { echo "objects boom" >&2; exit 7; }' \
    'head -c 4000 /dev/urandom > "$BACKUP_DIR/velto-objects-$TS.tar.gpg"' 'echo "OBJECTS_COUNT=3"; echo "OBJECTS_MANIFEST_SHA256=$(printf "b%.0s" {1..64})"; echo "OBJECTS_FILE=$BACKUP_DIR/velto-objects-$TS.tar.gpg"' > "$R/objects-backup.sh"
  chmod 755 "$R"/*.sh
  printf '#!/bin/sh\necho "$@" >> "%s"\n' "$RM" > "$d/mon"; chmod 755 "$d/mon"
}
runbk() { # STUB_TS-and-fault env as args
  env PATH="$RBIN:$PATH" FAKE_REMOTE="$RR" BACKUP_DIR="$RB" BACKUP_STATUS_DIR="$RS" OFFSITE_ENABLED=1 OFFSITE_BUCKET=bkt OFFSITE_S3_ENDPOINT=http://127.0.0.1:9 \
    OFFSITE_S3_ACCESS_KEY_ID=AKIDFAKE123 OFFSITE_S3_SECRET_ACCESS_KEY=SECRETFAKE123 OFFSITE_VERIFY_S3_ACCESS_KEY_ID=AKIDREAD456 OFFSITE_VERIFY_S3_SECRET_ACCESS_KEY=SECRETREAD456 BACKUP_ALLOW_NO_FLOCK=1 BACKUP_REQUIRE_KEY_SEPARATION=0 BACKUP_GLOBALS=1 VELTO_MONITOR_BIN="$d_mon" "$@" bash "$R/backup-run.sh" > "$RO" 2>&1
  RC=$?
}
if [[ "$ME" == 0 ]]; then ok "restore-point run tests skipped (running as root: BK_ROOT_UID stand-in not applicable)"; else
mkrun rp; d_mon="$(dirname "$RM")/mon"; : > "$RM"
T_A0=$(date -u +%s); STUB_TS=20261102-010101 runbk STUB_TS=20261102-010101; T_A1=$(date -u +%s)
[[ $RC -eq 0 ]] && ok "run A: backup-run.sh exit 0" || bad "run A rc=$RC: $(tail -n 5 "$RO")"
RP_A="$(sv restore_point_ts)"
[[ "$RP_A" =~ ^[0-9]{10}$ ]] && (( RP_A >= T_A0 && RP_A <= T_A1 )) && ok "ok status: restore_point_ts = epoch captured at run start (before pg_dump)" || bad "restore_point_ts=$RP_A"
[[ "$(sv offsite_restore_point_ts)" == "$RP_A" && "$(sv offsite_result)" == ok && "$(sv offsite_ts)" =~ ^[0-9]{10}$ ]] && ok "verified upload: offsite_restore_point_ts == restore_point_ts, offsite_ts set, offsite_result=ok" || bad "offsite fields: $(tr '\n' ' ' < "$RS/status")"
OFF_TS_A="$(sv offsite_ts)"
[[ "$(tail -n 1 "$RR/.puts")" == velto-set-20261102-010101.manifest && -f "$RR/bkt/velto-set-20261102-010101.manifest" ]] && ok "manifest uploaded LAST (after every archive)" || bad "upload order: $(tr '\n' ' ' < "$RR/.puts")"
B="$RB"; S="$RS/status"; check && ok "deploy gate accepts the run's status + manifest (objects required)" || bad "gate: $(cat "$T/err")"
grep -qE '^RESTORE_POINT_TS=[0-9]+$' "$RB/velto-set-20261102-010101.manifest" && grep -qE '^OBJECTS_SNAPSHOT_TS=[0-9]+$' "$RB/velto-set-20261102-010101.manifest" && grep -q '^OFFSITE_VERIFY=readback-sha256$' "$RB/velto-set-20261102-010101.manifest" && ok "manifest: restore point + objects snapshot ts + sizes/sha256 + verify method" || bad "manifest content"
for k in DB OBJ GLOBALS FP; do grep -qE "^${k}_SHA256=[0-9a-f]{64}\$" "$RB/velto-set-20261102-010101.manifest" || bad "manifest lacks ${k}_SHA256"; done

fault() { # label ts expected-rc alert-pattern [ENV=..]   (run B..E: previous verified offsite point must survive)
  local lbl="$1" ts="$2" erc="$3" apat="$4"; shift 4; sleep 1; : > "$RM"
  runbk "STUB_TS=$ts" "$@"
  [[ $RC -eq $erc ]] && ok "$lbl: exit $erc" || bad "$lbl: rc=$RC (want $erc): $(tail -n 4 "$RO")"
  [[ "$(sv offsite_result)" == failed && "$(sv OFFSITE)" == failed ]] && ok "$lbl: offsite_result=failed" || bad "$lbl: result=$(sv offsite_result)"
  [[ "$(sv offsite_restore_point_ts)" == "$RP_A" && "$(sv offsite_ts)" == "$OFF_TS_A" ]] && ok "$lbl: previous offsite_restore_point_ts/offsite_ts KEPT" || bad "$lbl: lost previous: $(tr '\n' ' ' < "$RS/status")"
  [[ "$(sv restore_point_ts)" =~ ^[0-9]{10}$ && "$(sv restore_point_ts)" -gt "$RP_A" ]] && ok "$lbl: local restore_point_ts advanced, offsite one did not" || bad "$lbl: restore_point_ts=$(sv restore_point_ts)"
  grep -qE "$apat" "$RM" && ok "$lbl: alert with structured fields ($apat)" || bad "$lbl: alert log: $(cat "$RM")"
}
fault "upload fails" 20261102-020202 10 'backup-offsite-sync.sh VELTO-BACKUP-FAILED host=[^ ]+ step=offsite-sync.sh exit=10 ts=' FAKE_RCLONE_FAIL_COPY=1
fault "size mismatch offsite (objects truncated)" 20261102-030303 11 'step=offsite-sync.sh exit=11' FAKE_RCLONE_TRUNC=objects
[[ ! -e "$RR/bkt/velto-set-20261102-030303.manifest" ]] && ok "size mismatch: manifest NOT uploaded for the unverified set" || bad "manifest uploaded despite failed archive verification"
fault "manifest missing offsite" 20261102-040404 11 'step=offsite-sync.sh exit=11' FAKE_RCLONE_SKIP=.manifest
fault "listing unavailable" 20261102-050505 11 'step=offsite-sync.sh exit=11' FAKE_RCLONE_FAIL_LSF=1

PUTS_BEFORE="$(wc -l < "$RR/.puts" | tr -d ' ')"; sleep 1; : > "$RM"
runbk STUB_TS=20261102-060606 STUB_OBJ_FAIL=1
[[ $RC -eq 7 && "$(sv RESULT)" == failed && "$(sv STEP)" == objects-backup.sh ]] && ok "objects backup failure: run failed (RESULT=failed STEP=objects-backup.sh)" || bad "objects fail: rc=$RC $(tr '\n' ' ' < "$RS/status")"
[[ -z "$(sv restore_point_ts)" && -z "$(sv SET_MANIFEST)" && ! -e "$RB/velto-set-20261102-060606.manifest" ]] && ok "objects failure: no restore point, no manifest" || bad "restore point despite objects failure"
[[ "$(sv offsite_restore_point_ts)" == "$RP_A" && "$(wc -l < "$RR/.puts" | tr -d ' ')" == "$PUTS_BEFORE" ]] && ok "objects failure: nothing uploaded, previous offsite point kept" || bad "objects failure side effects"
grep -q 'step=objects-backup.sh exit=7' "$RM" && ok "objects failure alerted" || bad "no alert for objects failure"
if VELTO_REQUIRE_OFFSITE=0 check; then bad "gate accepted a failed status"; else ok "gate rejects the failed (no restore point) status"; fi

sleep 1; : > "$RM"; runbk STUB_TS=20261102-070707 OBJECTS_BACKUP_ENABLED=0
[[ $RC -eq 12 && -z "$(sv restore_point_ts)" && -z "$(sv SET_MANIFEST)" && "$(sv OBJECTS)" == disabled && "$(sv offsite_restore_point_ts)" == "$RP_A" ]] && ok "objects disabled + OFFSITE_ENABLED=1: DB-only run is NOT a restore point and NOT success (exit 12)" || bad "objects disabled: rc=$RC $(tr '\n' ' ' < "$RS/status")"
[[ "$(sv offsite_result)" == failed ]] && grep -q 'step=offsite-no-restore-set exit=12' "$RM" && ok "objects disabled + offsite enabled: offsite_result=failed and structured alert sent" || bad "offsite-enabled-without-objects not alerted/attested: $(tr '\n' ' ' < "$RS/status") :: $(cat "$RM")"
check && bad "gate accepted a DB-only status with objects required" || { grep -q "no object-store archive" "$T/err" && ok "gate: DB-only status rejected when objects required" || bad "gate reason: $(cat "$T/err")"; }

echo "== manifest missing / tampered / corrupted status = not a restore point"
mkrun mp; d_mon="$(dirname "$RM")/mon"; : > "$RM"; STUB_TS=20261102-080808 runbk STUB_TS=20261102-080808; B="$RB"; S="$RS/status"; MP="$RB/velto-set-20261102-080808.manifest"
[[ $RC -eq 0 ]] && check && ok "fresh ok set accepted" || bad "fresh set: $(cat "$T/err")"
cp "$MP" "$T/mp.save"; rm -f "$MP"; expect_fail "set manifest deleted" "manifest missing"
cp "$T/mp.save" "$MP"; chmod 640 "$MP"; sed -i.bak 's/^OBJ_COUNT=.*/OBJ_COUNT=9/' "$MP" && rm -f "$MP.bak"; expect_fail "manifest content altered (status pins its sha256)" "manifest sha256 mismatch"
cp "$T/mp.save" "$MP"; chmod 640 "$MP"; check && ok "restored manifest accepted again" || bad "restore manifest: $(cat "$T/err")"
cp "$S" "$T/mp.status"; grep -vE '^(SET_MANIFEST|SET_MANIFEST_SHA256|restore_point_ts)=' "$T/mp.status" > "$S.n" && mv "$S.n" "$S"; chmod 644 "$S"; expect_fail "status without SET_MANIFEST" "not a restore point"
cp "$T/mp.status" "$S"; printf 'offsite_result=failed\n' >> "$S"; expect_fail "corrupted status: duplicate key" "duplicate"
cp "$T/mp.status" "$S"; printf 'offsite_ts=$(id)\n' >> "$S"; expect_fail "corrupted status: injected shell syntax" "malformed"
cp "$T/mp.status" "$S"; sed -i.bak 's/^restore_point_ts=.*/restore_point_ts=1790000999/' "$S" && rm -f "$S.bak"; expect_fail "status/manifest restore_point_ts disagree" "disagree"
cp "$T/mp.status" "$S"; check && ok "intact status accepted again" || bad "intact: $(cat "$T/err")"
printf '%s\n' VELTO_SET_MANIFEST=1 RESTORE_POINT_TS=1790000000 OBJECTS_SNAPSHOT_TS=1790000005 OBJECTS=failed > "$T/velto-set-20261102-090909.manifest"
bsm_verify "$T/velto-set-20261102-090909.manifest" "$RB" 0 && bad "manifest with OBJECTS!=ok accepted" || ok "manifest with failed objects backup is NOT a restore point"
bs_update "$RS" 'offsite_ts=$(id)' && bad "bs_update accepted a malformed value" || ok "bs_update refuses malformed values"
bs_write "$RS" ok offsite_ts=abc offsite_restore_point_ts=12abc; bs_write_failed "$RS" x 1
! grep -qE '^offsite_(ts|restore_point_ts)=' "$RS/status" && ok "malformed previous offsite_ts / offsite_restore_point_ts dropped (not copied forward)" || bad "malformed offsite values kept"

echo "== no secrets in outputs"
if grep -rqE 'AKIDFAKE123|SECRETFAKE123' "$T/rp/out" "$T/rp/alerts.log" "$T/rp/status/status" "$T/mp/out" "$RB"/*.manifest "$T/rp/backup"/*.manifest 2>/dev/null; then bad "secret found in run output/status/manifest/alerts"; else ok "no access key/secret in run output, status, manifests or alerts"; fi
fi


echo "== restore drill: set selection, objects consistency, verdict (restore-drill.sh uses these functions; the DB part needs Postgres and is not run here)"
[[ "$(bs_verdict 0 1 1)" == PASS ]] && ok "verdict: verified set + consistent objects + 0 fails = PASS" || bad "verdict PASS"
bs_verdict 0 0 0 >/dev/null; [[ $? -eq 2 ]] && ok "verdict: DB-only (no set) = PARTIAL (rc 2), never PASS" || bad "verdict PARTIAL rc"
[[ "$(bs_verdict 0 1 0)" == PARTIAL ]] && ok "verdict: set but objects unproven = PARTIAL" || bad "verdict set/objects"
[[ "$(bs_verdict 2 1 1)" == FAIL ]] && ok "verdict: any failed check = FAIL" || bad "verdict FAIL"
grep -q 'bs_verdict "\$FAILS" "\$SET_OK" "\$OBJ_OK"' "$HERE/restore-drill.sh" && grep -q 'DUMP_FILE and DRILL_SET_MANIFEST' "$HERE/restore-drill.sh" && ok "restore-drill.sh wired to the verdict + set selection" || bad "drill wiring"
if ! command -v gpg >/dev/null; then ok "objects-archive tests skipped (no gpg)"; else
  PF="$T/pass"; printf 'drillpass' > "$PF"; chmod 600 "$PF"
  mkobj() { # name keys... -> $T/<name>/ with velto-objects-*.tar.gpg, MANIFEST.tsv; sets OA OM OC
    local n="$1" k; shift; local d="$T/$n"; mkdir -p "$d/w/data"; OA="$d/velto-objects-20261102-010101.tar.gpg"
    printf '# velto-objects-manifest v1\n' > "$d/w/MANIFEST.tsv"
    for k in "$@"; do mkdir -p "$d/w/data/$(dirname "$k")"; printf 'content-%s' "$k" > "$d/w/data/$k"
      printf '%s\t%s\t%s\n' "$(sha "$d/w/data/$k")" "$(bs_size "$d/w/data/$k")" "$k" >> "$d/w/MANIFEST.tsv"; done
    tar -C "$d/w" -cf - MANIFEST.tsv data | gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PF" --symmetric --cipher-algo AES256 -o "$OA" 2>/dev/null
    OM="$(sha "$d/w/MANIFEST.tsv")"; OC=$#
  }
  mkobj o1 products/c1/a.png exports/1c/c1/j1.xml
  bsm_objects_extract "$OA" "$PF" "$OM" "$OC" "$T/o1x" && ok "objects archive: decrypts, embedded manifest + every object verified" || bad "objects extract: $BSM_REASON"
  bsm_objects_extract "$OA" "$PF" "$ZERO64" "$OC" "$T/o1y" && bad "wrong manifest hash accepted" || ok "objects archive: embedded manifest hash != set manifest rejected"
  bsm_objects_extract "$OA" "$PF" "$OM" 5 "$T/o1z" && bad "wrong count accepted" || ok "objects archive: object count mismatch rejected"
  printf 'x' | dd of="$OA" bs=1 seek=50 conv=notrunc 2>/dev/null; bsm_objects_extract "$OA" "$PF" "$OM" "$OC" "$T/o1w" && bad "corrupt objects archive accepted" || ok "corrupted objects archive rejected"
  printf 'products/c1/a.png\t\nexports/1c/c1/j1.xml\t%s\n' "$(sha "$T/o1/w/data/exports/1c/c1/j1.xml")" > "$T/db1.keys"
  bsm_keys_check "$T/db1.keys" "$T/o1/w/MANIFEST.tsv" && ok "DB-referenced keys all in the archive (missing=0, stale=0)" || bad "keys ok: missing=$BSM_MISSING stale=$BSM_STALE"
  printf 'products/c1/a.png\t\nproducts/c1/gone.png\t\n' > "$T/db2.keys"
  bsm_keys_check "$T/db2.keys" "$T/o1/w/MANIFEST.tsv"; [[ "$BSM_MISSING" == 1 ]] && ok "DB references an object absent from the archive -> missing=1 (FAIL)" || bad "missing not detected: $BSM_MISSING"
  printf 'exports/1c/c1/j1.xml\t%s\n' "$ZERO64" > "$T/db3.keys"
  bsm_keys_check "$T/db3.keys" "$T/o1/w/MANIFEST.tsv"; [[ "$BSM_STALE" == 1 && "$BSM_MISSING" == 0 ]] && ok "overwritten 1C export key (fileHash != archived sha256) -> stale=1 (FAIL)" || bad "stale not detected: $BSM_STALE"
  # set selection: manifest required, corrupted newest set skipped, loose archives ignored
  sd="$T/sel"; mkdir -p "$sd"; BS_RUN_ID=sel
  mkset() { # TS corrupt(0|1)
    local ts="$1" db="velto-db-$1.dump.gpg" ob="velto-objects-$1.tar.gpg"
    head -c 700 /dev/urandom > "$sd/$db"; head -c 900 /dev/urandom > "$sd/$ob"
    bsm_write "$sd/velto-set-$ts.manifest" RUN_ID=sel SET_TS=$ts RESTORE_POINT_TS=1790000000 OBJECTS_SNAPSHOT_TS=1790000001 OBJECTS=ok \
      "DB_ARCHIVE=$db" "DB_SIZE=700" "DB_SHA256=$(sha "$sd/$db")" "OBJ_ARCHIVE=$ob" "OBJ_SIZE=900" "OBJ_SHA256=$(sha "$sd/$ob")"
    bsm_sign "$sd/velto-set-$ts.manifest"
    [[ "$2" == 0 ]] || flipbyte "$sd/$ob" 10
  }
  mkset 20261101-010101 0; mkset 20261102-010101 1
  head -c 700 /dev/urandom > "$sd/velto-db-20261103-010101.dump.gpg"   # newest DB archive, NO manifest
  bsm_select "$sd" && [[ "$BSM_SELECTED" == "$sd/velto-set-20261101-010101.manifest" && "$BSM_REJECTED" == 1 ]] && ok "drill selection: newest set with matching checksums (corrupted newer set + manifest-less archive skipped)" || bad "selection: '$BSM_SELECTED' rejected=$BSM_REJECTED"
  rm -f "$sd/velto-set-20261101-010101.manifest"; bsm_select "$sd" && bad "set chosen with no valid manifest" || ok "drill selection: no valid manifest -> no set (archives alone are never a restore point)"
fi


echo "== R1: signed manifest + full content verification (bsm_verify_signed); keys are throwaway, verification keyring is independent of the set"
mkr1() { # name -> $R1/<name>: valid signed set (db, objects, globals, fingerprint), BACKUP_SIGN_* = K1
  local d="$T/r1/$1"; mkdir -p "$d"; chmod 755 "$d"; local ts=20261103-120000 ots=20261103-120005   # objects archive is named a few seconds after the DB dump
  head -c 700 /dev/urandom > "$d/velto-db-$ts.dump.gpg"; head -c 900 /dev/urandom > "$d/velto-objects-$ots.tar.gpg"; head -c 300 /dev/urandom > "$d/velto-globals-$ts.sql.gpg"; head -c 200 /dev/urandom > "$d/velto-fp-$ts.txt.gpg"
  bsm_write "$d/velto-set-$ts.manifest" RUN_ID=r1 SET_TS=$ts RESTORE_POINT_TS=1790000000 OBJECTS_SNAPSHOT_TS=1790000001 OBJECTS=ok BACKUP_GLOBALS=1 OBJ_COUNT=1 "OBJ_MANIFEST_SHA256=$ZERO64" OFFSITE_VERIFY=readback-sha256 \
    "DB_ARCHIVE=velto-db-$ts.dump.gpg" "DB_SIZE=700" "DB_SHA256=$(sha "$d/velto-db-$ts.dump.gpg")" "OBJ_ARCHIVE=velto-objects-$ots.tar.gpg" "OBJ_SIZE=900" "OBJ_SHA256=$(sha "$d/velto-objects-$ots.tar.gpg")" \
    "GLOBALS_ARCHIVE=velto-globals-$ts.sql.gpg" "GLOBALS_SIZE=300" "GLOBALS_SHA256=$(sha "$d/velto-globals-$ts.sql.gpg")" "FP_ARCHIVE=velto-fp-$ts.txt.gpg" "FP_SIZE=200" "FP_SHA256=$(sha "$d/velto-fp-$ts.txt.gpg")"
  M1="$d/velto-set-$ts.manifest"; R1D="$d"; R1TS="$ts"; R1OTS="$ots"
}
vs() { bsm_verify_signed "$M1" "$R1D"; }   # reason in BSM_REASON
expect_rej() { # label reason-substring
  if vs; then bad "$1: ACCEPTED"; elif [[ "$BSM_REASON" == *"$2"* ]]; then ok "$1: rejected ($BSM_REASON)"; else bad "$1: wrong reason: $BSM_REASON"; fi
}
mkr1 good; bsm_sign "$M1"
vs && ok "signed set (K1 pinned): signature, every sha256, no extra files = accepted" || bad "good set rejected: $BSM_REASON"
mkr1 unsigned; expect_rej "unsigned set (no .sig)" "signature missing"
mkr1 tm; bsm_sign "$M1"; sed -i.bak 's/^RESTORE_POINT_TS=1790000000$/RESTORE_POINT_TS=1700000000/' "$M1" && rm -f "$M1.bak"; expect_rej "tampered manifest (RESTORE_POINT_TS lowered after signing)" "signature"
mkr1 ta; bsm_sign "$M1"; flipbyte "$R1D/velto-objects-$R1OTS.tar.gpg" 10; expect_rej "tampered archive (same size, flipped byte)" "sha256 mismatch"
mkr1 tf; bsm_sign "$M1"; flipbyte "$R1D/velto-fp-$R1TS.txt.gpg" 5; expect_rej "tampered fingerprint archive" "FP archive sha256 mismatch"
mkr1 ut; BACKUP_SIGN_GNUPGHOME="$SH3" BACKUP_SIGN_KEY_FPR="$F3" bsm_sign "$M1"
BACKUP_VERIFY_KEYRING="$T/pub1.gpg" expect_rej "signed by an untrusted key (K3 not in keyring)" "signature"
cat "$T/pub1.gpg" > "$T/pub13.gpg"; pub_export "$SH3" "$F3" "$T/pub3.gpg"; cat "$T/pub1.gpg" "$T/pub3.gpg" > "$T/pub13.gpg"
BACKUP_VERIFY_KEYRING="$T/pub13.gpg" expect_rej "K3 in the keyring but NOT pinned in BACKUP_TRUSTED_SIGN_FPRS" "untrusted key"
mkr1 rot; BACKUP_SIGN_GNUPGHOME="$SH2" BACKUP_SIGN_KEY_FPR="$F2" bsm_sign "$M1"
BACKUP_VERIFY_KEYRING="$T/pub12.gpg" BACKUP_TRUSTED_SIGN_FPRS="$F1 $F2" vs && ok "key rotation: set signed by K2 accepted while both K1+K2 are pinned" || bad "rotated key rejected: $BSM_REASON"
BACKUP_VERIFY_KEYRING="$T/pub12.gpg" BACKUP_TRUSTED_SIGN_FPRS="$F1,$F2" vs && ok "pinned list may be comma separated" || bad "comma list rejected"
BACKUP_VERIFY_KEYRING="$T/pub12.gpg" BACKUP_TRUSTED_SIGN_FPRS="$F1" expect_rej "rotation: K2 key present but only K1 pinned" "untrusted key"
mkr1 exp; SHX="$T/sigx"; FX="$(mk_signkey "$SHX" expired 20200101T000000)"; pub_export "$SHX" "$FX" "$T/pubx.gpg"
gpg --homedir "$SHX" --batch --pinentry-mode loopback --passphrase '' --faked-system-time 20200101T120000 --local-user "$FX!" --detach-sign -o "$M1.sig" "$M1" 2>/dev/null
BACKUP_VERIFY_KEYRING="$T/pubx.gpg" BACKUP_TRUSTED_SIGN_FPRS="$FX" expect_rej "expired signing key (pinned)" "signature"
mkr1 rev; SH4="$T/sign4"; F4="$(mk_signkey "$SH4" revoked)"; BACKUP_SIGN_GNUPGHOME="$SH4" BACKUP_SIGN_KEY_FPR="$F4" bsm_sign "$M1"; rev_pub "$SH4" "$F4" "$T/pub4rev.gpg"
BACKUP_VERIFY_KEYRING="$T/pub4rev.gpg" BACKUP_TRUSTED_SIGN_FPRS="$F4" expect_rej "revoked signing key (pinned, revocation in the keyring)" "signature"
kill_agents "$SH4"
mkr1 cfg; bsm_sign "$M1"
BACKUP_VERIFY_KEYRING="" expect_rej "no BACKUP_VERIFY_KEYRING (fail closed)" "BACKUP_VERIFY_KEYRING"
BACKUP_TRUSTED_SIGN_FPRS="" expect_rej "no pinned fingerprints (fail closed)" "BACKUP_TRUSTED_SIGN_FPRS"
BACKUP_TRUSTED_SIGN_FPRS="not-a-fingerprint" expect_rej "malformed pinned fingerprint" "malformed"
BACKUP_TRUSTED_SIGN_FPRS="${F1:0:16}" expect_rej "short key id instead of the full primary fingerprint" "malformed"
mkr1 xtra; bsm_sign "$M1"; head -c 50 /dev/urandom > "$R1D/velto-objects-$R1OTS.tar.gpg.extra"; expect_rej "extra file in the set (unlisted)" "extra file"
mkr1 xplain; bsm_sign "$M1"; echo "plain dump" > "$R1D/velto-db-$R1TS.dump"; expect_rej "plaintext dump next to the set" "extra file"
mkr1 miss; bsm_sign "$M1"; rm -f "$R1D/velto-globals-$R1TS.sql.gpg"; expect_rej "missing file (globals archive listed in the manifest)" "GLOBALS archive missing"
mkr1 missfp; bsm_sign "$M1"; rm -f "$R1D/velto-fp-$R1TS.txt.gpg"; expect_rej "missing fingerprint archive listed in the manifest" "FP archive missing"
mkr1 other; bsm_sign "$M1"; head -c 40 /dev/urandom > "$R1D/velto-db-20261103-130000.dump.gpg"; vs && ok "files of ANOTHER set (other timestamp) in the directory are not 'extra'" || bad "other set confused: $BSM_REASON"
mkr1 sel; bsm_sign "$M1"; head -c 700 /dev/urandom > "$R1D/velto-db-20261103-140000.dump.gpg"
bsm_write "$R1D/velto-set-20261103-140000.manifest" RUN_ID=r1 RESTORE_POINT_TS=1790000000 OBJECTS_SNAPSHOT_TS=1790000001 OBJECTS=ok DB_ARCHIVE=velto-db-20261103-140000.dump.gpg DB_SIZE=700 "DB_SHA256=$(sha "$R1D/velto-db-20261103-140000.dump.gpg")" OBJ_ARCHIVE=velto-db-20261103-140000.dump.gpg OBJ_SIZE=700 "OBJ_SHA256=$(sha "$R1D/velto-db-20261103-140000.dump.gpg")"
bsm_select "$R1D" && [[ "$BSM_SELECTED" == "$M1" && "$BSM_REJECTED" == 1 ]] && ok "bsm_select skips a newer UNSIGNED set and picks the newest signed one" || bad "select: $BSM_SELECTED rejected=$BSM_REJECTED"
mkr1 pre; bsm_write "$R1D/velto-set-$R1TS.manifest" RUN_ID=r1 SET_TS=$R1TS RESTORE_POINT_TS=1790000000 OBJECTS_SNAPSHOT_TS=1790000001 OBJECTS=ok DB_ARCHIVE=velto-db-$R1TS.dump.gpg DB_SIZE=700 "DB_SHA256=$(sha "$R1D/velto-db-$R1TS.dump.gpg")" OBJ_ARCHIVE=velto-objects-$R1OTS.tar.gpg OBJ_SIZE=900 "OBJ_SHA256=$(sha "$R1D/velto-objects-$R1OTS.tar.gpg")" BACKUP_GLOBALS=0
rm -f "$R1D/velto-globals-$R1TS.sql.gpg" "$R1D/velto-fp-$R1TS.txt.gpg"; bsm_sign "$M1"
vs && [[ -z "$(bsm_get FP_ARCHIVE)" ]] && ok "pre-R4 set (no FP_ARCHIVE) stays structurally valid: the DRILL turns it into NOT_VERIFIED (exit 3), never PASS" || bad "pre-R4 set: $BSM_REASON"
grep -q 'NOT_VERIFIED' "$HERE/restore-drill.sh" && grep -q 'RC=3' "$HERE/restore-drill.sh" && ok "restore-drill.sh maps a missing fingerprint to NOT_VERIFIED / exit 3 (checked end-to-end in the isolated drill)" || bad "drill NOT_VERIFIED mapping missing"

echo "== R4: fingerprint comparison prints names + MATCH/MISMATCH only; tiered retention; lock"
. "$HERE/fingerprint-lib.sh"
FPE="$T/fp.exp"; FPA="$T/fp.act"
for spec in "${FP_TABLES[@]}"; do n="${spec%%:*}"; printf '%s|7|123456.78|%s\n' "$n" "$ZERO64"; done > "$FPE"
fp_check_shape < "$FPE" && ok "fp_check_shape: all ${#FP_TABLES[@]} tables present, well formed" || bad "fp_check_shape rejects a good file"
grep -v '^Payment|' "$FPE" | fp_check_shape && bad "fp_check_shape accepted a file with a missing table" || ok "fp_check_shape rejects a missing table"
cp "$FPE" "$FPA"; out="$(fp_compare "$FPE" "$FPA")" && [[ "$out" != *MISMATCH* ]] && ok "fp_compare: identical = all MATCH" || bad "fp_compare identical: $out"
sed 's/^Payment|7|123456.78|/Payment|7|123456.79|/' "$FPE" > "$FPA"; out="$(fp_compare "$FPE" "$FPA")"; rc=$?
[[ $rc -ne 0 && "$out" == *"Payment=MISMATCH"* && "$out" == *"Invoice=MATCH"* && "$out" != *123456* && "$out" != *"$ZERO64"* ]] && ok "fp_compare: one changed sum -> Payment=MISMATCH (rc!=0), others MATCH, no value printed" || bad "fp_compare mismatch: rc=$rc $out"
sed 's/^AuditLog|7|123456.78|a/AuditLog|7|123456.78|b/' "$FPE" > "$FPA"; out="$(fp_compare "$FPE" "$FPA")"; [[ "$out" == *"AuditLog=MISMATCH"* ]] && ok "fp_compare: changed row hash -> MISMATCH" || bad "hash change not detected"
grep -v '^Invoice|' "$FPE" > "$FPA"; out="$(fp_compare "$FPE" "$FPA")"; [[ "$out" == *"Invoice=MISMATCH"* ]] && ok "fp_compare: table missing on the restored side -> MISMATCH" || bad "missing table not flagged"
: > "$FPA"; fp_compare "$FPE" "$FPA" >/dev/null && bad "empty actual accepted" || ok "fp_compare: empty restored fingerprint -> not a match"
sqltxt="$(fp_sql)"; [[ "$sqltxt" == *"SET LOCAL DateStyle"* && "$sqltxt" == *"sha256(convert_to(string_agg"* ]] && ok "fp_sql: pinned text format + sha256 over ordered rows" || bad "fp_sql shape"

. "$HERE/backup-common.sh"
bkv() { [[ ! -e "$1.bad" ]]; }   # test verifier: a manifest with a <name>.bad marker fails its sha256/manifest check
BK_PRUNE_VERIFY=bkv
RT="$T/ret"; mkdir -p "$RT"; NOW=1793700000   # fixed clock
mkfiles() { local ts="$1" mf="$2"; : > "$RT/velto-db-$ts.dump.gpg"; : > "$RT/velto-db-$ts.dump.gpg.sha256"; : > "$RT/velto-objects-$ts.tar.gpg"; : > "$RT/velto-fp-$ts.txt.gpg"
  if [[ "$mf" == 1 ]]; then printf 'VELTO_SET_MANIFEST=1\nDB_ARCHIVE=velto-db-%s.dump.gpg\nOBJ_ARCHIVE=velto-objects-%s.tar.gpg\nFP_ARCHIVE=velto-fp-%s.txt.gpg\n' "$ts" "$ts" "$ts" > "$RT/velto-set-$ts.manifest"; : > "$RT/velto-set-$ts.manifest.sig"; fi; }
tsat() { date -d "@$1" +%Y%m%d-%H%M%S 2>/dev/null || date -r "$1" +%Y%m%d-%H%M%S; }
# every 20 min for 10 days (+ one orphan = archives of a failed run without a manifest, 3 days old)
for i in $(seq 0 719); do mkfiles "$(tsat $((NOW - i*1200 - 600)))" 1; done
ORPH="$(tsat $((NOW - 3*86400 - 300)))"; mkfiles "$ORPH" 0
# a set 40 days old (> 30 d): must go
OLD="$(tsat $((NOW - 40*86400)))"; mkfiles "$OLD" 1
N0="$(ls "$RT"/velto-set-*.manifest | wc -l | tr -d ' ')"
bk_prune_sets "$RT" 48 30 "$NOW" >/dev/null
N1="$(ls "$RT"/velto-set-*.manifest | wc -l | tr -d ' ')"; YOUNG="$(ls "$RT"/velto-set-*.manifest | awk -v c="$(tsat $((NOW-48*3600)))" '{n=$0; sub(/.*velto-set-/,"",n); sub(/\.manifest/,"",n); if (n >= c) k++} END{print k+0}')"
[[ "$YOUNG" == 144 ]] && ok "retention: all 144 sets of the last 48 h kept (3/h)" || bad "young sets kept: $YOUNG (want 144)"
[[ ! -e "$RT/velto-set-$OLD.manifest" && ! -e "$RT/velto-db-$OLD.dump.gpg" ]] && ok "retention: a 40-day-old set is deleted completely" || bad "old set kept"
[[ ! -e "$RT/velto-db-$ORPH.dump.gpg" && ! -e "$RT/velto-objects-$ORPH.tar.gpg" ]] && ok "retention: orphan archives (no manifest) older than 48 h are deleted" || bad "orphan kept"
OLDER=$((N1 - YOUNG)); (( OLDER >= 1 && OLDER <= 9 )) && ok "retention: older than 48 h only one set per day remains ($OLDER daily sets for the 10-day span; was $N0 manifests)" || bad "daily keepers: $OLDER"
for m in "$RT"/velto-set-*.manifest; do b="$(basename "$m" .manifest)"; t="${b#velto-set-}"; [[ -e "$RT/velto-db-$t.dump.gpg" && -e "$RT/velto-objects-$t.tar.gpg" && -e "$RT/velto-fp-$t.txt.gpg" && -e "$m.sig" ]] || { bad "kept set $t is incomplete"; break; }; done && ok "retention: every kept set is complete (db, objects, fingerprint, manifest, sig)"
if command -v flock >/dev/null; then
  mkrun lk; d_mon="$(dirname "$RM")/mon"; : > "$RM"; exec 8>"$RS/.backup-run.lock"; flock -n 8 || bad "test could not take the lock"
  STUB_TS=20261103-150000 runbk STUB_TS=20261103-150000; ls "$RB"/velto-db-* >/dev/null 2>&1 && bad "overlapping run did work while the lock was held" || { [[ $RC -eq 75 ]] && grep -q 'previous run still active' "$RO" && grep -q 'backup-lock-busy VELTO-BACKUP-FAILED .*step=lock-busy exit=75' "$RM" && ok "flock: a second run while one holds the lock does NOTHING and is REPORTED (exit 75 + structured alert lock-busy), never a silent success" || bad "overlap handling rc=$RC: $(tail -n2 "$RO") / $(cat "$RM")"; }
  exec 8>&-
else ok "flock not installed on this host (macOS): overlap + lock-busy alert test runs in the Linux runner/drill (BACKUP_ALLOW_NO_FLOCK=1 is the dev-only escape, refused otherwise)"; fi


echo "== audit fixes: rename/rollback binding, freshness (replay), non-detached sig, passphrase perms, snapshot holder, verified retention"
mkr1 bind; bsm_sign "$M1"; vs && ok "bound set (name TS == signed SET_TS) accepted" || bad "bound set rejected: $BSM_REASON"
cp "$M1" "$R1D/velto-set-20261103-130000.manifest"; cp "$M1.sig" "$R1D/velto-set-20261103-130000.manifest.sig"
if bsm_verify_signed "$R1D/velto-set-20261103-130000.manifest" "$R1D"; then bad "renamed (validly signed) manifest ACCEPTED: rollback/rename possible"; else [[ "$BSM_REASON" == *"not bound"* ]] && ok "validly signed manifest renamed to another timestamp: rejected ($BSM_REASON)" || bad "rename: wrong reason $BSM_REASON"; fi
rm -f "$R1D"/velto-set-20261103-130000.manifest*
mkr1 bind2; sed -i.bak "s/^DB_ARCHIVE=velto-db-$R1TS/DB_ARCHIVE=velto-db-20261103-110000/" "$M1" && rm -f "$M1.bak"; mv "$R1D/velto-db-$R1TS.dump.gpg" "$R1D/velto-db-20261103-110000.dump.gpg"; bsm_sign "$M1"
expect_rej "signed manifest listing a DB archive of another timestamp" "timestamp differs"
mkr1 bind3; sed -i.bak "s/^OBJ_ARCHIVE=velto-objects-$R1OTS/OBJ_ARCHIVE=velto-objects-20261103-110000/" "$M1" && rm -f "$M1.bak"; mv "$R1D/velto-objects-$R1OTS.tar.gpg" "$R1D/velto-objects-20261103-110000.tar.gpg"; bsm_sign "$M1"
expect_rej "signed manifest with an objects archive OLDER than the set" "older than the set"
mkr1 nots; sed -i.bak '/^SET_TS=/d' "$M1" && rm -f "$M1.bak"; bsm_sign "$M1"; expect_rej "manifest without SET_TS (name not bound)" "not bound"

mkr1 fresh; bsm_sign "$M1"; vs >/dev/null; RPF=1790000000
BSM_NOW=$((RPF+600)) bsm_fresh_check 60 "" && ok "freshness: 10-min-old signed restore point within a 60-min bound = accepted" || bad "fresh rejected: $BSM_REASON"
BSM_NOW=$((RPF+7200)) bsm_fresh_check 60 "" && bad "STALE (2 h) set accepted" || { [[ "$BSM_REASON" == *STALE* ]] && ok "freshness: older validly-signed set (replay after newer sets were deleted) = FAIL (STALE)" || bad "stale reason $BSM_REASON"; }
BSM_NOW=$((RPF+60)) bsm_fresh_check "" "" && bad "no freshness bound accepted" || ok "freshness: no bound and no RUN_ID given = FAIL (bound is required)"
BSM_NOW=$((RPF+7200)) bsm_fresh_check "" "r1" && ok "explicit historical restore: expected RUN_ID equal to the signed one = accepted" || bad "run id override rejected"
BSM_NOW=$((RPF+60)) bsm_fresh_check 60 "other" && bad "wrong RUN_ID accepted" || ok "explicit RUN_ID that differs from the signed RUN_ID = FAIL"
BSM_NOW=$((RPF-3600)) bsm_fresh_check 60 "" && bad "future restore point accepted" || ok "signed RESTORE_POINT_TS in the future = FAIL"

mkr1 nodet; gpg --homedir "$SH1" --batch --pinentry-mode loopback --passphrase '' --local-user "$F1!" --sign -o "$M1.sig" "$M1" 2>/dev/null
expect_rej "non-detached (embedded-data) signature" "not a detached"

fps="$(cat "$HERE/fingerprint-lib.sh")"
[[ "$fps" == *"kill -0 \$\$"* && "$fps" == *"FP_SNAP_MAX_SECONDS"* && "$fps" == *"9>&-"* ]] && ok "snapshot holder: wait is bounded (timeout + parent-pid liveness) and does not inherit flock fd 9" || bad "snapshot holder not bounded"

# verified retention
RV="$T/retv"; RT="$RV"; rm -rf "$RV"; mkdir -p "$RV"; NOW=1793700000
d1="$(tsat $((NOW - 5*86400)))"; d2="$(tsat $((NOW - 5*86400 + 1200)))"; mkfiles "$d1" 1; mkfiles "$d2" 1; : > "$RT/velto-set-$d1.manifest.bad"   # earliest set of that day is corrupt
bk_prune_sets "$RV" 48 30 "$NOW" >/dev/null
[[ ! -e "$RV/velto-set-$d1.manifest" && -e "$RV/velto-set-$d2.manifest" ]] && ok "retention: the daily keeper is the earliest set that PASSES verification (corrupt earlier one is not kept as the day's survivor)" || bad "keeper choice: $(ls "$RV" | tr '\n' ' ')"
rm -rf "$RV"; mkdir -p "$RV"; d3="$(tsat $((NOW - 60*86400)))"; mkfiles "$d3" 1; mkfiles "$(tsat $((NOW - 61*86400)))" 1; : > "$RV/velto-set-$d3.manifest.bad"   # newest set is corrupt, an older one verifies
d4="$(tsat $((NOW - 61*86400)))"; bk_prune_sets "$RV" 48 30 "$NOW" >/dev/null
[[ -e "$RV/velto-set-$d4.manifest" && -e "$RV/velto-db-$d4.dump.gpg" ]] && ok "retention: the newest VERIFIED set (60+ days old, nothing newer verifies) is never deleted" || bad "newest verified set deleted: $(ls "$RV" | tr '\n' ' ')"
unset BK_PRUNE_VERIFY; bk_prune_sets "$RV" 48 30 "$NOW" >/dev/null 2>&1 && bad "pruned without a verifier" || ok "retention: no verifier = refuses to prune (fail closed)"; BK_PRUNE_VERIFY=bkv

echo "== R2: offsite read-back (fake rclone: remote = local dir); size is not proof"
mkrun rb; d_mon="$(dirname "$RM")/mon"; : > "$RM"
STUB_TS=20261103-160000 runbk STUB_TS=20261103-160000
[[ $RC -eq 0 && "$(sv offsite_result)" == ok ]] && ok "read-back run A: exit 0, offsite_result=ok" || bad "run A rc=$RC: $(tail -n3 "$RO")"
[[ -f "$RR/bkt/velto-set-20261103-160000.manifest.sig" && -f "$RR/bkt/velto-fp-20261103-160000.txt.gpg" ]] && ok "signature and fingerprint archive reached offsite" || bad "sig/fp not offsite: $(ls "$RR/bkt" | tr '\n' ' ')"
PU="$(grep -n 'velto-set-20261103-160000.manifest' "$RR/.puts" | cut -d: -f1 | tr '\n' ' ')"; LAST="$(tail -n 1 "$RR/.puts")"
[[ "$LAST" == velto-set-20261103-160000.manifest && "$(tail -n 2 "$RR/.puts" | head -n 1)" == velto-set-20261103-160000.manifest.sig ]] && ok "upload order: archives -> sig -> manifest LAST ($PU)" || bad "order: $(tr '\n' ' ' < "$RR/.puts")"
RP_B="$(sv offsite_restore_point_ts)"; OFF_TS_B="$(sv offsite_ts)"
rb_fault() { # label ts alert-pattern ENV...
  local lbl="$1" ts="$2" apat="$3"; shift 3; sleep 1; : > "$RM"
  runbk "STUB_TS=$ts" "$@"
  [[ $RC -eq 11 ]] && ok "$lbl: exit 11" || bad "$lbl: rc=$RC: $(tail -n 3 "$RO")"
  [[ "$(sv offsite_result)" == failed && "$(sv offsite_restore_point_ts)" == "$RP_B" && "$(sv offsite_ts)" == "$OFF_TS_B" ]] && ok "$lbl: offsite_result=failed, previous verified offsite point kept" || bad "$lbl: status $(tr '\n' ' ' < "$RS/status")"
  grep -qE "$apat" "$RM" && ok "$lbl: alert sent" || bad "$lbl: no alert: $(cat "$RM")"
}
rb_fault "remote content differs, SAME size (listing alone would pass)" 20261103-170000 'step=offsite-sync.sh exit=11' FAKE_RCLONE_CORRUPT=objects
grep -q 'read-back sha256 MISMATCH offsite: velto-objects-20261103-170000.tar.gpg' "$RO" && ok "mismatch names the object, no hash/values in the log" || bad "mismatch log: $(grep -i offsite "$RO" | tail -n 3)"
rb_fault "remote fingerprint archive corrupted (same size)" 20261103-180000 'step=offsite-sync.sh exit=11' FAKE_RCLONE_CORRUPT=velto-fp
rb_fault "remote manifest corrupted (same size)" 20261103-190000 'step=offsite-sync.sh exit=11' FAKE_RCLONE_CORRUPT=.manifest
rb_fault "remote signature corrupted (same size)" 20261103-200000 'step=offsite-sync.sh exit=11' FAKE_RCLONE_CORRUPT=.sig
rb_fault "read-back download fails" 20261103-210000 'step=offsite-sync.sh exit=11' FAKE_RCLONE_FAIL_CAT=1
PUTS_BEFORE="$(wc -l < "$RR/.puts" | tr -d ' ')"; sleep 1; : > "$RM"
runbk STUB_TS=20261103-220000 OFFSITE_VERIFY_S3_ACCESS_KEY_ID= OFFSITE_VERIFY_S3_SECRET_ACCESS_KEY=
[[ $RC -eq 11 && "$(sv offsite_result)" == failed && "$(wc -l < "$RR/.puts" | tr -d ' ')" == "$PUTS_BEFORE" ]] && grep -q 'read-back verification unavailable' "$RO" && ok "no read-back identity: exit 11, offsite_result=failed, NOTHING uploaded (fail closed)" || bad "no verify key: rc=$RC $(tail -n 3 "$RO")"
sleep 1; : > "$RM"; runbk STUB_TS=20261103-230000 BACKUP_SIGN_KEY_FPR="$F3"
[[ $RC -ne 0 && "$(sv RESULT)" == failed && "$(sv STEP)" == manifest-sign && ! -e "$RB/velto-set-20261103-230000.manifest.sig" ]] && ok "signing failure (key not in the signing home): run failed at manifest-sign, no restore point" || bad "sign failure: rc=$RC $(tr '\n' ' ' < "$RS/status" | cut -c1-200)"
sleep 1; : > "$RM"; runbk STUB_TS=20261103-235000 STUB_NO_FP=1
[[ $RC -ne 0 && "$(sv RESULT)" == failed && "$(sv STEP)" == fingerprint-missing && ! -e "$RB/velto-set-20261103-235000.manifest" ]] && ok "backup without a fingerprint: failed (fingerprint-missing), no manifest = no restore point" || bad "no-fp: rc=$RC $(tr '\n' ' ' < "$RS/status" | cut -c1-200)"
sleep 1; : > "$RM"; runbk STUB_TS=20261104-000100 BACKUP_VERIFY_KEYRING="$T/pub3.gpg"
[[ $RC -ne 0 && "$(sv STEP)" == manifest-sign ]] && ok "backup host self-check: signature not verifiable with the configured keyring -> failed" || bad "self-check: rc=$RC step=$(sv STEP)"


echo "== retention only after a verified set; sign passphrase file perms"
mkrun pr; d_mon="$(dirname "$RM")/mon"; : > "$RM"
head -c 100 /dev/urandom > "$RB/velto-db-20200101-000000.dump.gpg"; head -c 100 /dev/urandom > "$RB/velto-objects-20200101-000005.tar.gpg"
runbk STUB_TS=20261105-010101 STUB_OBJ_FAIL=1
[[ $RC -eq 7 && -e "$RB/velto-db-20200101-000000.dump.gpg" ]] && ok "failed run (objects) does NOT prune: old files untouched" || bad "failed run pruned or wrong rc=$RC"
sleep 1; runbk STUB_TS=20261105-020202
[[ $RC -eq 0 && ! -e "$RB/velto-db-20200101-000000.dump.gpg" && -e "$RB/velto-set-20261105-020202.manifest" ]] && ok "verified run prunes AFTER the new set: 2020 orphans gone, the new set kept" || bad "successful run prune: rc=$RC $(ls "$RB" | tr '\n' ' ')"
printf 'x' > "$T/spass"; chmod 644 "$T/spass"; sleep 1; runbk STUB_TS=20261105-030303 BACKUP_SIGN_PASSPHRASE_FILE="$T/spass"
[[ $RC -ne 0 && "$(sv STEP)" == sign-key-perms ]] && ok "BACKUP_SIGN_PASSPHRASE_FILE mode 0644: refused (sign-key-perms)" || bad "pass perms 644: rc=$RC step=$(sv STEP)"
chmod 600 "$T/spass"; sleep 1; runbk STUB_TS=20261105-040404 BACKUP_SIGN_PASSPHRASE_FILE="$T/spass"
[[ $RC -eq 0 ]] && ok "BACKUP_SIGN_PASSPHRASE_FILE 0600 owned by the trusted uid: accepted" || bad "pass perms 600: rc=$RC $(tail -n 3 "$RO")"

printf '\n%d passed, %d failed\n' "$pass" "$fail"; [[ $fail -eq 0 ]]
