#!/usr/bin/env bash
# Sourced library (not executable on its own): the backup STATUS ATTESTATION.
#   writer  (bs_write)   runs as root inside velto-backup.service; file lives in a root-owned dir the deploy user cannot write.
#   checker (vbs_check)  runs as velto-deploy from deploy.sh (via verify-backup-status.sh) and in the test harness.
# Format: strict KEY=VALUE lines, values [A-Za-z0-9._:-]* only. It is DATA: never `source`d, only grep-parsed.
# Contains: run id, epoch/UTC time, result, archive BASENAMES, sizes, sha256 of the ciphertext. No secrets, no key paths, no contents.

bs_stat() { # fmt-linux fmt-bsd file
  stat -c "$1" "$3" 2>/dev/null || stat -f "$2" "$3" 2>/dev/null
}
bs_uid()  { bs_stat %u %u "$1"; }
bs_perm() { bs_stat %a %Lp "$1"; }
bs_size() { bs_stat %s %z "$1"; }
bs_sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# ---------------------------------------------------------------- writer (root)
# bs_write <status_dir> <result ok|failed> [KEY=VALUE ...]  -> atomic: temp file in the same dir, chmod 0644, sync, rename(2)
bs_write() {
  local dir="$1" result="$2"; shift 2
  local now tmp kv
  now="$(date -u +%s)"
  [[ -d "$dir" ]] || { echo "[status] status dir missing: $dir" >&2; return 1; }
  tmp="$(umask 022; mktemp "$dir/.status.XXXXXX")" || return 1
  {
    echo "VELTO_BACKUP_STATUS=1"
    echo "RUN_ID=${BS_RUN_ID:-$now-$$}"
    echo "TIMESTAMP_EPOCH=$now"
    echo "TIMESTAMP_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "RESULT=$result"
    # lowercase keys = contract with deploy/monitoring/velto-monitor.sh (grep-parsed, never sourced)
    echo "ts=$now"
    echo "result=$result"
    for kv in "$@"; do
      [[ "$kv" =~ ^[A-Za-z][A-Za-z0-9_]*=[A-Za-z0-9._:-]*$ ]] || { echo "[status] refusing malformed field" >&2; rm -f "$tmp"; return 1; }
      echo "$kv"
    done
  } > "$tmp"
  chmod 0644 "$tmp"
  sync 2>/dev/null || true
  mv -f "$tmp" "$dir/status"
}

# bs_write_failed <status_dir> <step> <rc>: failed attestation that KEEPS offsite_ts/offsite_result of the previous status (monitor contract:
# offsite_ts = last CONFIRMED offsite copy), so a local failure is not misread as "offsite missing".
bs_write_failed() {
  local dir="$1" ts res keep=()
  ts="$(grep -E '^offsite_ts=' "$dir/status" 2>/dev/null | head -n1 | cut -d= -f2-)"
  res="$(grep -E '^offsite_result=' "$dir/status" 2>/dev/null | head -n1 | cut -d= -f2-)"
  [[ "$ts" =~ ^[0-9]{9,11}$ ]] || ts=""
  [[ "$res" =~ ^[a-z]+$ ]] || res=unknown
  [[ -z "$ts" ]] || keep=("offsite_ts=$ts" "offsite_result=$res")
  bs_write "$dir" failed "STEP=$2" "EXIT=$3" ${keep[@]+"${keep[@]}"}
}

# bs_update <status_dir> key=value ...: atomically rewrite the existing status with these keys replaced/added (root; used by a standalone offsite-sync).
bs_update() {
  local dir="$1" tmp kv k; shift
  [[ -f "$dir/status" ]] || return 1
  tmp="$(umask 022; mktemp "$dir/.status.XXXXXX")" || return 1
  cp "$dir/status" "$tmp"
  for kv in "$@"; do
    [[ "$kv" =~ ^[A-Za-z][A-Za-z0-9_]*=[A-Za-z0-9._:-]*$ ]] || { rm -f "$tmp"; return 1; }
    k="${kv%%=*}"; grep -v "^$k=" "$tmp" > "$tmp.n" || true; echo "$kv" >> "$tmp.n"; mv "$tmp.n" "$tmp"
  done
  chmod 0644 "$tmp"; sync 2>/dev/null || true; mv -f "$tmp" "$dir/status"
}

# ---------------------------------------------------------------- checker (deploy user)
VBS_REASON=""   # last failure reason (read by callers)
export VBS_REASON
vbs_fail() { VBS_REASON="$1"; echo "[backup-gate] FAIL: $1" >&2; return 1; }

# vbs_get KEY -> value of the single KEY=... line of $VBS_TEXT
vbs_get() { grep -E "^$1=" <<<"$VBS_TEXT" | head -n1 | cut -d= -f2-; }

# vbs_dir_ok <dir> <uid>: owned by uid, not group/world-writable
vbs_dir_ok() {
  local d="$1" uid="$2" p
  [[ -d "$d" && ! -L "$d" ]] || return 1
  [[ "$(bs_uid "$d")" == "$uid" ]] || return 1
  p="$(bs_perm "$d")"; [[ "$p" =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#$p & 8#022) == 0 ))
}

# vbs_check <status_file> <backup_dir> <max_age_min> <expect_uid> <require_objects 0|1> [now_epoch]
# Production passes expect_uid=0 as a LITERAL (verify-backup-status.sh has no way to change it). Only the test harness
# calls this function directly with another uid, because the sandbox cannot create root-owned files. Exports VBS_* on success.
vbs_check() {
  local sf="$1" bd="$2" maxmin="$3" uid="$4" reqobj="$5" now="${6:-$(date -u +%s)}"
  local p ts age name size sha f f_path
  VBS_REASON=""
  [[ "$maxmin" =~ ^[0-9]+$ && "$uid" =~ ^[0-9]+$ ]] || { vbs_fail "bad parameters"; return 1; }
  [[ -e "$sf" ]] || { vbs_fail "no backup status attestation ($sf): no backup has been recorded"; return 1; }
  [[ -f "$sf" && ! -L "$sf" ]] || { vbs_fail "status is not a regular file"; return 1; }
  [[ "$(bs_uid "$sf")" == "$uid" ]] || { vbs_fail "status file is not owned by the backup identity (uid $uid): forged or misconfigured"; return 1; }
  p="$(bs_perm "$sf")"; [[ "$p" =~ ^[0-7]{3,4}$ ]] || { vbs_fail "cannot stat status"; return 1; }
  (( (8#$p & 8#022) == 0 )) || { vbs_fail "status file is group/world-writable (mode $p): forged or misconfigured"; return 1; }
  vbs_dir_ok "$(dirname "$sf")" "$uid" || { vbs_fail "status directory is not owned by uid $uid or is group/world-writable: anyone writing there could forge a backup"; return 1; }
  vbs_dir_ok "$bd" "$uid" || { vbs_fail "backup directory is not owned by uid $uid or is group/world-writable"; return 1; }

  VBS_TEXT="$(cat "$sf")" || { vbs_fail "cannot read status"; return 1; }
  # strict grammar: every line KEY=VALUE, no duplicates
  if grep -vqE '^[A-Za-z][A-Za-z0-9_]*=[A-Za-z0-9._:-]*$' <<<"$VBS_TEXT"; then vbs_fail "status has malformed lines"; return 1; fi
  if [[ -n "$(cut -d= -f1 <<<"$VBS_TEXT" | sort | uniq -d)" ]]; then vbs_fail "status has duplicate keys"; return 1; fi
  [[ "$(vbs_get VELTO_BACKUP_STATUS)" == 1 ]] || { vbs_fail "unknown status format version"; return 1; }
  [[ "$(vbs_get RESULT)" == ok ]] || { vbs_fail "last backup run did not succeed (RESULT=$(vbs_get RESULT) STEP=$(vbs_get STEP)); the backup service failed"; return 1; }
  [[ "$(vbs_get VERIFY)" == ok ]] || { vbs_fail "last backup was not verified (VERIFY!=ok)"; return 1; }
  [[ "${VELTO_REQUIRE_OFFSITE:-0}" != 1 || "$(vbs_get OFFSITE)" == ok ]] || { vbs_fail "offsite copy required (VELTO_REQUIRE_OFFSITE=1) but OFFSITE!=ok"; return 1; }
  ts="$(vbs_get TIMESTAMP_EPOCH)"; [[ "$ts" =~ ^[0-9]{9,11}$ ]] || { vbs_fail "bad timestamp"; return 1; }
  (( ts <= now + 120 )) || { vbs_fail "status timestamp is in the future"; return 1; }
  age=$(( (now - ts) / 60 ))
  (( age <= maxmin )) || { vbs_fail "backup is stale: ${age} min old, limit ${maxmin} min (VELTO_BACKUP_MAX_AGE_MIN)"; return 1; }

  for f in DB OBJ GLOBALS; do
    name="$(vbs_get ${f}_ARCHIVE)"
    if [[ -z "$name" ]]; then
      if [[ $f == DB ]]; then vbs_fail "status has no DB archive"; return 1; fi
      if [[ $f == OBJ && "$reqobj" == 1 ]]; then vbs_fail "status has no object-store archive (VELTO_REQUIRE_OBJECTS=1)"; return 1; fi
      if [[ $f == GLOBALS && "$(vbs_get BACKUP_GLOBALS)" == 1 ]]; then vbs_fail "status says globals are backed up (BACKUP_GLOBALS=1) but has no GLOBALS archive"; return 1; fi
      continue
    fi
    [[ "$name" =~ ^velto-(db|objects|globals)-[0-9]{8}-[0-9]{6}\.(dump|tar|sql)\.gpg$ && "$name" != */* ]] || { vbs_fail "$f archive name not allowed"; return 1; }
    f_path="$bd/$name"
    [[ -f "$f_path" && ! -L "$f_path" ]] || { vbs_fail "$f archive missing: $name"; return 1; }
    [[ "$(bs_uid "$f_path")" == "$uid" ]] || { vbs_fail "$f archive not owned by uid $uid: $name"; return 1; }
    [[ -r "$f_path" ]] || { vbs_fail "$f archive not readable by the deploy user (ciphertext must be group-readable, see deploy/system/): $name"; return 1; }
    size="$(vbs_get ${f}_SIZE)"; sha="$(vbs_get ${f}_SHA256)"
    [[ "$size" =~ ^[0-9]+$ && "$sha" =~ ^[0-9a-f]{64}$ ]] || { vbs_fail "$f size/sha256 malformed in status"; return 1; }
    [[ "$(bs_size "$f_path")" == "$size" ]] || { vbs_fail "$f archive size mismatch (truncated or replaced): $name"; return 1; }
    [[ "$(bs_sha256 "$f_path")" == "$sha" ]] || { vbs_fail "$f archive sha256 mismatch (corrupted or replaced): $name"; return 1; }
    export "VBS_${f}_ARCHIVE=$name"
  done
  VBS_RUN_ID="$(vbs_get RUN_ID)"
  export VBS_RUN_ID VBS_TIMESTAMP_EPOCH="$ts" VBS_AGE_MIN="$age"
  return 0
}

# vbs_gate <status_file> <backup_dir> <max_age_min> <expect_uid> <require_objects> <trigger 0|1>
# trigger=1: first ask root to take a FRESH backup via the single sudoers rule (`systemctl start velto-backup.service`; Type=oneshot, so this
# blocks until the run ends and returns non-zero if it failed), then require a status written after that moment.
# Any failure returns 1 -> the caller aborts BEFORE install/migrate. Nothing here restores or modifies anything.
# VBS_START_CMD: an env var of that name WOULD be picked up (scalar -> element 0), so verify-backup-status.sh unsets it before sourcing/using this; only the test harness assigns it.
vbs_gate() {
  local sf="$1" bd="$2" maxmin="$3" uid="$4" reqobj="$5" trigger="$6" t0
  if [[ "$trigger" == 1 ]]; then
    if [[ -z "${VBS_START_CMD[*]:-}" ]]; then VBS_START_CMD=(sudo -n /usr/bin/systemctl start velto-backup.service); fi
    t0="$(date -u +%s)"
    echo "[backup-gate] requesting a fresh backup: ${VBS_START_CMD[*]}" >&2
    "${VBS_START_CMD[@]}" || { vbs_fail "backup service failed or could not be started (sudoers rule missing? see deploy/system/): deploy aborted, nothing was changed"; return 1; }
    vbs_check "$sf" "$bd" "$maxmin" "$uid" "$reqobj" || return 1
    (( VBS_TIMESTAMP_EPOCH >= t0 - 1 )) || { vbs_fail "service returned success but the status was not refreshed"; return 1; }
    return 0
  fi
  vbs_check "$sf" "$bd" "$maxmin" "$uid" "$reqobj"
}
