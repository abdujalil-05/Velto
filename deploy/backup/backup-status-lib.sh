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

# bs_prev_offsite <status_dir>: prints the offsite attestation lines of the PREVIOUS status that must survive a failed/unconfirmed run
# (monitor contract: offsite_ts / offsite_restore_point_ts = last CONFIRMED + VERIFIED offsite restore set). Values are re-validated ([0-9]{9,11}),
# a malformed previous value is dropped. offsite_ts and offsite_result are kept together (as before); offsite_restore_point_ts independently.
bs_prev_offsite() {
  local dir="$1" ts rp res
  ts="$(grep -E '^offsite_ts=' "$dir/status" 2>/dev/null | head -n1 | cut -d= -f2-)"
  rp="$(grep -E '^offsite_restore_point_ts=' "$dir/status" 2>/dev/null | head -n1 | cut -d= -f2-)"
  res="$(grep -E '^offsite_result=' "$dir/status" 2>/dev/null | head -n1 | cut -d= -f2-)"
  [[ "$ts" =~ ^[0-9]{9,11}$ ]] || ts=""
  [[ "$rp" =~ ^[0-9]{9,11}$ ]] || rp=""
  [[ "$res" =~ ^[a-z]+$ ]] || res=unknown
  if [[ -n "$ts" ]]; then echo "offsite_ts=$ts"; echo "offsite_result=$res"; fi
  if [[ -n "$rp" ]]; then echo "offsite_restore_point_ts=$rp"; fi
  return 0
}

# bs_write_failed <status_dir> <step> <rc>: failed attestation that KEEPS the previous offsite_* fields, so a local failure is not misread as "offsite missing".
bs_write_failed() {
  local dir="$1" l keep=()
  while IFS= read -r l; do [[ -z "$l" ]] || keep+=("$l"); done < <(bs_prev_offsite "$dir")
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

# ---------------------------------------------------------------- restore-set manifest
# velto-set-<TS>.manifest = the RESTORE POINT record of one run: same strict KEY=VALUE grammar as the status (data, never sourced, no secrets):
#   VELTO_SET_MANIFEST=1 RUN_ID RESTORE_POINT_TS OBJECTS_SNAPSHOT_TS OBJECTS=ok  DB_/OBJ_/GLOBALS_ {ARCHIVE,SIZE,SHA256}  OBJ_COUNT OBJ_MANIFEST_SHA256 OFFSITE_VERIFY
# Written AFTER every archive is final and uploaded LAST: a set without its manifest (or with OBJECTS!=ok) is NOT a restore point.
BS_ARCHIVE_RE='^velto-(db|objects|globals)-[0-9]{8}-[0-9]{6}\.(dump|tar|sql)\.gpg$'
BS_MANIFEST_RE='^velto-set-[0-9]{8}-[0-9]{6}\.manifest$'
BSM_REASON=""; BSM_TEXT=""; BSM_OBJ_NUM=""
export BSM_REASON BSM_TEXT BSM_OBJ_NUM
bsm_get() { grep -E "^$1=" <<<"$BSM_TEXT" | head -n1 | cut -d= -f2-; }
bsm_fail() { BSM_REASON="$1"; return 1; }

# bsm_write <manifest_file> KEY=VALUE ...: atomic (temp in the same dir + rename), refuses malformed fields
bsm_write() {
  local out="$1" tmp kv body; shift
  [[ "$(basename "$out")" =~ $BS_MANIFEST_RE ]] || { echo "[manifest] bad manifest name" >&2; return 1; }
  body="VELTO_SET_MANIFEST=1"
  for kv in "$@"; do
    [[ "$kv" =~ ^[A-Za-z][A-Za-z0-9_]*=[A-Za-z0-9._:-]*$ ]] || { echo "[manifest] refusing malformed field" >&2; return 1; }
    body+=$'\n'"$kv"
  done
  tmp="$(umask 022; mktemp "$(dirname "$out")/.manifest.XXXXXX")" || return 1
  printf '%s\n' "$body" > "$tmp"
  chmod 0644 "$tmp"
  sync 2>/dev/null || true; mv -f "$tmp" "$out"
}

# bsm_verify <manifest_file> <archive_dir> <check_files 1|0>: structure + (check_files=1) every listed archive exists, regular, exact size and sha256.
# Required: OBJECTS=ok, DB + OBJ archives, GLOBALS iff BACKUP_GLOBALS=1. Sets BSM_TEXT (getter bsm_get) and BSM_REASON.
bsm_verify() {
  local mf="$1" dir="$2" chk="$3" f name size sha p
  BSM_REASON=""
  [[ "$(basename "$mf")" =~ $BS_MANIFEST_RE ]] || { bsm_fail "manifest name not allowed"; return 1; }
  [[ -f "$mf" && ! -L "$mf" ]] || { bsm_fail "set manifest missing: no restore point"; return 1; }
  BSM_TEXT="$(cat "$mf")" || { bsm_fail "cannot read manifest"; return 1; }
  if grep -vqE '^[A-Za-z][A-Za-z0-9_]*=[A-Za-z0-9._:-]*$' <<<"$BSM_TEXT"; then bsm_fail "manifest has malformed lines"; return 1; fi
  if [[ -n "$(cut -d= -f1 <<<"$BSM_TEXT" | sort | uniq -d)" ]]; then bsm_fail "manifest has duplicate keys"; return 1; fi
  [[ "$(bsm_get VELTO_SET_MANIFEST)" == 1 ]] || { bsm_fail "unknown manifest format version"; return 1; }
  [[ "$(bsm_get OBJECTS)" == ok ]] || { bsm_fail "set has no verified objects backup (OBJECTS!=ok): not a restore point"; return 1; }
  for p in RESTORE_POINT_TS OBJECTS_SNAPSHOT_TS; do
    [[ "$(bsm_get $p)" =~ ^[0-9]{9,11}$ ]] || { bsm_fail "manifest $p malformed"; return 1; }
  done
  (( $(bsm_get RESTORE_POINT_TS) <= $(bsm_get OBJECTS_SNAPSHOT_TS) )) || { bsm_fail "manifest: objects snapshot is older than the DB restore point"; return 1; }
  for f in DB OBJ GLOBALS; do
    name="$(bsm_get ${f}_ARCHIVE)"
    if [[ -z "$name" ]]; then
      [[ $f == GLOBALS && "$(bsm_get BACKUP_GLOBALS)" != 1 ]] && continue
      bsm_fail "manifest has no $f archive"; return 1
    fi
    [[ "$name" =~ $BS_ARCHIVE_RE ]] || { bsm_fail "$f archive name not allowed"; return 1; }
    size="$(bsm_get ${f}_SIZE)"; sha="$(bsm_get ${f}_SHA256)"
    [[ "$size" =~ ^[0-9]+$ && "$sha" =~ ^[0-9a-f]{64}$ ]] || { bsm_fail "$f size/sha256 malformed in manifest"; return 1; }
    [[ "$chk" == 1 ]] || continue
    [[ -f "$dir/$name" && ! -L "$dir/$name" ]] || { bsm_fail "$f archive missing: $name"; return 1; }
    [[ "$(bs_size "$dir/$name")" == "$size" ]] || { bsm_fail "$f archive size mismatch: $name"; return 1; }
    [[ "$(bs_sha256 "$dir/$name")" == "$sha" ]] || { bsm_fail "$f archive sha256 mismatch: $name"; return 1; }
  done
  return 0
}

# bsm_select <dir>: newest set whose manifest exists AND verifies (OBJECTS=ok, exact size + sha256 of every archive). Sets BSM_SELECTED (path) and BSM_REJECTED (count).
# A set without a manifest is invisible here: loose archives are never a restore point.
BSM_SELECTED=""; BSM_REJECTED=0
export BSM_SELECTED BSM_REJECTED
bsm_select() {
  local m; BSM_SELECTED=""; BSM_REJECTED=0
  while IFS= read -r m; do
    if bsm_verify "$m" "$1" 1; then BSM_SELECTED="$m"; return 0; fi
    BSM_REJECTED=$((BSM_REJECTED+1))
  done < <(find "$1" -maxdepth 1 -type f -name 'velto-set-*.manifest' | sort -r)
  return 1
}

# bsm_objects_extract <objects.tar.gpg> <passphrase_file> <expected_manifest_sha256> <expected_count> <workdir>: decrypt + untar into <workdir>/obj, require the embedded
# MANIFEST.tsv to hash to the SET manifest's OBJ_MANIFEST_SHA256 and every object to match its sha256/size and the count. 0 = intact; reason in BSM_REASON.
bsm_objects_extract() {
  local arch="$1" pf="$2" msha="$3" cnt="$4" w="$5" osha osize okey n=0 bad=0
  BSM_REASON=""; mkdir -p "$w/obj"
  gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$pf" --decrypt "$arch" 2>/dev/null | tar -xf - -C "$w/obj" 2>/dev/null \
    || { bsm_fail "objects archive: decrypt/extract failed"; return 1; }
  [[ -f "$w/obj/MANIFEST.tsv" && "$(bs_sha256 "$w/obj/MANIFEST.tsv")" == "$msha" ]] || { bsm_fail "objects archive: embedded manifest hash differs from the set manifest"; return 1; }
  while IFS=$'\t' read -r osha osize okey; do
    n=$((n+1))
    [[ -f "$w/obj/data/$okey" && "$(bs_size "$w/obj/data/$okey")" == "$osize" && "$(bs_sha256 "$w/obj/data/$okey")" == "$osha" ]] || bad=$((bad+1))
  done < <(grep -v '^#' "$w/obj/MANIFEST.tsv")
  [[ $bad -eq 0 && "$n" == "$cnt" ]] || { bsm_fail "objects archive: bad objects=$bad listed=$n expected=${cnt:-?}"; return 1; }
  BSM_OBJ_NUM="$n"
}

# bsm_keys_check <db.keys (key<TAB>fileHash-or-empty)> <MANIFEST.tsv>: DB-referenced object keys missing from the objects archive (BSM_MISSING) and
# ExportJob.fileHash != archived sha256, i.e. another version of an overwritten key (BSM_STALE). Both must be 0. BSM_DBKEYS = distinct keys referenced.
BSM_MISSING=0; BSM_STALE=0; BSM_DBKEYS=0
export BSM_MISSING BSM_STALE BSM_DBKEYS
bsm_keys_check() {
  local dk="$1" mt="$2" ak; ak="$(mktemp)" || return 1
  grep -v '^#' "$mt" | awk -F'\t' '{print $3 "\t" $1}' | LC_ALL=C sort -t $'\t' -k1,1 > "$ak"
  BSM_DBKEYS="$(cut -f1 "$dk" | LC_ALL=C sort -u | wc -l | tr -d ' ')"
  BSM_MISSING="$(cut -f1 "$dk" | LC_ALL=C sort -u | LC_ALL=C comm -23 - <(cut -f1 "$ak") | wc -l | tr -d ' ')"
  BSM_STALE="$(awk -F'\t' 'NR==FNR{a[$1]=$2; next} ($2 != "" && ($1 in a) && a[$1] != $2){n++} END{print n+0}' "$ak" "$dk")"
  rm -f "$ak"
  [[ "$BSM_MISSING" == 0 && "$BSM_STALE" == 0 ]]
}

# bs_verdict <fails> <set_ok 1|0> <objects_consistent 1|0>: PASS (rc 0) only for a verified set with consistent objects and 0 failed checks; FAIL (1); DB-only/unproven = PARTIAL (2).
bs_verdict() {
  if [[ "$1" -ne 0 ]]; then echo FAIL; return 1
  elif [[ "$2" == 1 && "$3" == 1 ]]; then echo PASS; return 0
  else echo PARTIAL; return 2; fi
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
  local p ts age name size sha f f_path mname
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
    [[ "$name" =~ $BS_ARCHIVE_RE && "$name" != */* ]] || { vbs_fail "$f archive name not allowed"; return 1; }
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
  # restore set: with objects required a RESTORE POINT needs its manifest (pinned by sha256 in the root-written status) consistent with the status
  mname="$(vbs_get SET_MANIFEST)"
  if [[ -z "$mname" ]]; then
    [[ "$reqobj" == 1 ]] && { vbs_fail "status has no restore-set manifest (SET_MANIFEST): not a restore point"; return 1; }
  else
    [[ "$mname" =~ $BS_MANIFEST_RE ]] || { vbs_fail "manifest name not allowed"; return 1; }
    f_path="$bd/$mname"
    [[ -f "$f_path" && ! -L "$f_path" ]] || { vbs_fail "restore-set manifest missing: $mname"; return 1; }
    [[ "$(bs_uid "$f_path")" == "$uid" ]] || { vbs_fail "manifest not owned by uid $uid: $mname"; return 1; }
    [[ "$(bs_sha256 "$f_path")" == "$(vbs_get SET_MANIFEST_SHA256)" ]] || { vbs_fail "manifest sha256 mismatch (replaced or corrupted): $mname"; return 1; }
    bsm_verify "$f_path" "$bd" 0 || { vbs_fail "$BSM_REASON"; return 1; }
    for f in RUN_ID DB_ARCHIVE DB_SHA256 OBJ_ARCHIVE OBJ_SHA256 GLOBALS_ARCHIVE GLOBALS_SHA256; do
      [[ "$(bsm_get $f)" == "$(vbs_get $f)" ]] || { vbs_fail "manifest and status disagree on $f"; return 1; }
    done
    [[ "$(bsm_get RESTORE_POINT_TS)" == "$(vbs_get restore_point_ts)" ]] || { vbs_fail "manifest and status disagree on restore_point_ts"; return 1; }
  fi
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
