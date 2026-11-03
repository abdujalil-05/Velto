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
bs_sha256_stdin() { if command -v sha256sum >/dev/null; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }

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
#   VELTO_SET_MANIFEST=1 RUN_ID RESTORE_POINT_TS OBJECTS_SNAPSHOT_TS OBJECTS=ok  DB_/OBJ_/GLOBALS_/FP_ {ARCHIVE,SIZE,SHA256}  OBJ_COUNT OBJ_MANIFEST_SHA256 OFFSITE_VERIFY
# FP = gpg-encrypted financial fingerprint (fingerprint-lib.sh) taken in the SAME snapshot as the dump; optional only for pre-R4 sets (the drill then says NOT_VERIFIED).
# AUTHENTICITY: velto-set-<TS>.manifest.sig = detached gpg signature of the manifest (separate signing key, bsm_sign / bsm_sig_verify below).
# Written AFTER every archive is final and uploaded LAST: a set without its manifest (or with OBJECTS!=ok) is NOT a restore point.
BS_ARCHIVE_RE='^velto-(db|objects|globals|fp)-[0-9]{8}-[0-9]{6}\.(dump|tar|sql|txt)\.gpg$'
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
  for f in DB OBJ GLOBALS FP; do
    name="$(bsm_get ${f}_ARCHIVE)"
    if [[ -z "$name" ]]; then
      [[ $f == GLOBALS && "$(bsm_get BACKUP_GLOBALS)" != 1 ]] && continue
      [[ $f == FP ]] && continue   # pre-R4 set: still a valid restore point, but the drill reports NOT_VERIFIED (never PASS)
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

# ---------------------------------------------------------------- manifest signature (R1)
# Detached gpg signature of the manifest with a SEPARATE signing key (NOT the backup passphrase; it never encrypts anything). The private key lives only in
# BACKUP_SIGN_GNUPGHOME (root-owned 0700, backup host). Verification NEVER trusts anything shipped inside the backup: it imports BACKUP_VERIFY_KEYRING
# (an exported PUBLIC key file kept apart from the backup, e.g. on the restore workstation) into a fresh temporary homedir and pins the signer's
# PRIMARY-key fingerprint to BACKUP_TRUSTED_SIGN_FPRS (space/comma separated, >1 allowed for rotation). Result comes from --status-fd, not from gpg's exit text.

# bsm_sign <manifest>: needs BACKUP_SIGN_GNUPGHOME + BACKUP_SIGN_KEY_FPR (+ optional BACKUP_SIGN_PASSPHRASE_FILE). Writes <manifest>.sig atomically.
bsm_sign() {
  local mf="$1" tmp; BSM_REASON=""
  [[ -n "${BACKUP_SIGN_GNUPGHOME:-}" && -d "$BACKUP_SIGN_GNUPGHOME" && "${BACKUP_SIGN_KEY_FPR:-}" =~ ^[0-9A-Fa-f]{40}([0-9A-Fa-f]{24})?$ ]] \
    || { bsm_fail "signing not configured (BACKUP_SIGN_GNUPGHOME / BACKUP_SIGN_KEY_FPR)"; return 1; }
  tmp="$(umask 022; mktemp "$(dirname "$mf")/.sig.XXXXXX")" || { bsm_fail "cannot create temp signature"; return 1; }
  if gpg --homedir "$BACKUP_SIGN_GNUPGHOME" --batch --yes --quiet --pinentry-mode loopback ${BACKUP_SIGN_PASSPHRASE_FILE:+--passphrase-file "$BACKUP_SIGN_PASSPHRASE_FILE"} \
       --local-user "$BACKUP_SIGN_KEY_FPR!" --detach-sign -o "$tmp" "$mf" 2>/dev/null && [[ -s "$tmp" ]]; then
    chmod 0644 "$tmp"; mv -f "$tmp" "$mf.sig"
  else rm -f "$tmp"; bsm_fail "gpg signing failed"; return 1; fi
}

# bsm_sig_verify <manifest>: 0 only for a GOODSIG+VALIDSIG by a non-expired, non-revoked key whose PRIMARY fingerprint is pinned. Sets BSM_REASON (never prints key material).
bsm_sig_verify() {
  local mf="$1" sig="$1.sig" gh st fp pinned ok=0 npin=0 line f rc
  BSM_REASON=""
  [[ -n "${BACKUP_VERIFY_KEYRING:-}" && -f "$BACKUP_VERIFY_KEYRING" ]] || { bsm_fail "BACKUP_VERIFY_KEYRING unset or missing: signature cannot be verified (fail closed)"; return 1; }
  pinned="$(tr ',a-f' ' A-F' <<<"${BACKUP_TRUSTED_SIGN_FPRS:-}")"
  for f in $pinned; do [[ "$f" =~ ^[0-9A-F]{40}([0-9A-F]{24})?$ ]] || { bsm_fail "BACKUP_TRUSTED_SIGN_FPRS has a malformed entry"; return 1; }; npin=$((npin+1)); done
  (( npin > 0 )) || { bsm_fail "BACKUP_TRUSTED_SIGN_FPRS empty: no trusted signer (fail closed)"; return 1; }
  [[ -f "$sig" && ! -L "$sig" ]] || { bsm_fail "manifest signature missing: $(basename "$sig")"; return 1; }
  if gpg --list-packets "$sig" 2>/dev/null | grep -qE '^:(literal data|onepass_sig) packet'; then bsm_fail "manifest signature is not a detached signature"; return 1; fi
  gh="$(umask 077; mktemp -d)" || { bsm_fail "cannot create temp gpg home"; return 1; }
  if ! gpg --homedir "$gh" --batch --quiet --import "$BACKUP_VERIFY_KEYRING" >/dev/null 2>&1; then rm -rf "$gh"; bsm_fail "cannot import BACKUP_VERIFY_KEYRING"; return 1; fi
  st="$(gpg --homedir "$gh" --batch --no-autostart --status-fd 1 --verify "$sig" "$mf" 2>/dev/null)"; rc=$?
  gpgconf --homedir "$gh" --kill all >/dev/null 2>&1; rm -rf "$gh"
  if grep -qE '^\[GNUPG:\] (BADSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|ERRSIG|NO_PUBKEY|KEYREVOKED|KEYEXPIRED) ' <<<"$st"; then bsm_fail "manifest signature rejected (bad, expired, revoked or unknown signer)"; return 1; fi
  if [[ $rc -ne 0 ]] || ! grep -q '^\[GNUPG:\] GOODSIG ' <<<"$st"; then bsm_fail "manifest signature invalid"; return 1; fi
  [[ "$(grep -c '^\[GNUPG:\] VALIDSIG ' <<<"$st")" == 1 ]] || { bsm_fail "manifest signature: not exactly one valid signature"; return 1; }
  line="$(grep '^\[GNUPG:\] VALIDSIG ' <<<"$st")"; fp="$(awk '{print toupper($12)}' <<<"$line")"
  for f in $pinned; do [[ "$fp" == "$f" ]] && ok=1; done
  (( ok == 1 )) || { bsm_fail "manifest signed by an untrusted key (primary fingerprint not in BACKUP_TRUSTED_SIGN_FPRS)"; return 1; }
}

# bsm_set_complete <manifest> <dir>: the set contains EXACTLY what the manifest lists: no extra file carrying any timestamp of this set (the manifest's and those of the
# listed archives: objects/globals/fingerprint are named a few seconds after the DB dump) - an unlisted archive, a stray plaintext, a second manifest variant - and, via
# bsm_verify, no missing one. Allowed: manifest, .sig, each listed archive and its .sha256 sidecar. Files of OTHER sets (other timestamps) are not extras.
bsm_set_complete() {
  local mf="$1" dir="$2" f n allowed=$'\n' extra="" tss=" " t pat=()
  BSM_REASON=""
  t="$(basename "$mf" | sed -E 's/^velto-set-([0-9]{8}-[0-9]{6})\.manifest$/\1/')"; tss+="$t "
  allowed+="$(basename "$mf")"$'\n'"$(basename "$mf").sig"$'\n'
  for f in DB OBJ GLOBALS FP; do
    n="$(bsm_get ${f}_ARCHIVE)"; [[ -n "$n" ]] || continue
    allowed+="$n"$'\n'"$n.sha256"$'\n'
    t="$(sed -E 's/^velto-[a-z]+-([0-9]{8}-[0-9]{6})\..*$/\1/' <<<"$n")"; [[ "$tss" == *" $t "* ]] || tss+="$t "
  done
  for t in $tss; do pat+=(-o -name "velto-*-$t.*" -o -name "velto-set-$t.*"); done
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    [[ "$allowed" == *$'\n'"$f"$'\n'* ]] || extra="$f"
  done < <(find "$dir" -maxdepth 1 -type f \( -name 'velto-set-x-none' "${pat[@]}" \) -exec basename {} \; | sort)
  [[ -z "$extra" ]] || { bsm_fail "extra file in the set (not listed in the manifest): $extra"; return 1; }
}

# bsm_bind_check <manifest>: the file NAME is not signed, so bind it to signed content (anti rollback-by-rename): signed SET_TS == the name's timestamp, DB/GLOBALS/FP
# archive names carry that same timestamp, the objects archive (created seconds later) never an earlier one. Needs BSM_TEXT (bsm_verify ran).
bsm_bind_check() {
  local ts f n t
  ts="$(basename "$1" | sed -E 's/^velto-set-([0-9]{8}-[0-9]{6})\.manifest$/\1/')"
  [[ -n "$(bsm_get RUN_ID)" && "$(bsm_get SET_TS)" == "$ts" ]] || { bsm_fail "manifest file name is not bound to the signed content (SET_TS/RUN_ID mismatch): possible rename/rollback"; return 1; }
  for f in DB GLOBALS FP OBJ; do
    n="$(bsm_get ${f}_ARCHIVE)"; [[ -n "$n" ]] || continue
    t="$(sed -E 's/^velto-[a-z]+-([0-9]{8}-[0-9]{6})\..*$/\1/' <<<"$n")"
    if [[ $f == OBJ ]]; then [[ ! "$t" < "$ts" ]] || { bsm_fail "$f archive is older than the set (timestamp mismatch)"; return 1; }
    else [[ "$t" == "$ts" ]] || { bsm_fail "$f archive timestamp differs from the set (mismatch)"; return 1; }; fi
  done
}

# bsm_fresh_check <max_age_minutes> <expected_run_id>: replay guard on SIGNED data (an old validly signed set must not pass as the current one when newer sets are gone).
# expected_run_id set = explicit historical restore (RUN_ID must equal it); else max age is REQUIRED and RESTORE_POINT_TS must be within it (and not in the future).
bsm_fresh_check() {
  local max="$1" want="$2" rp now; BSM_REASON=""
  if [[ -n "$want" ]]; then [[ "$(bsm_get RUN_ID)" == "$want" ]] || { bsm_fail "signed RUN_ID differs from the expected one"; return 1; }; return 0; fi
  [[ "$max" =~ ^[0-9]+$ && "$max" -gt 0 ]] || { bsm_fail "freshness bound required: set DRILL_MAX_RESTORE_POINT_AGE_MINUTES, or DRILL_EXPECT_RUN_ID for a historical restore"; return 1; }
  rp="$(bsm_get RESTORE_POINT_TS)"; now="${BSM_NOW:-$(date +%s)}"
  (( rp <= now + 120 )) || { bsm_fail "signed RESTORE_POINT_TS is in the future"; return 1; }
  (( now - rp <= max * 60 )) || { bsm_fail "set is STALE: signed restore point is $(( (now - rp) / 60 )) min old, limit $max min (replay of an older set? use DRILL_EXPECT_RUN_ID for a deliberate historical restore)"; return 1; }
}

# bsm_verify_signed <manifest> <dir>: THE restore-side check, in this order: signature -> manifest structure + size/sha256 of EVERY listed file -> name bound to signed content -> no extra files.
bsm_verify_signed() {
  bsm_sig_verify "$1" || return 1
  bsm_verify "$1" "$2" 1 || return 1
  bsm_bind_check "$1" || return 1
  bsm_set_complete "$1" "$2"
}

# bsm_select <dir>: newest set whose manifest exists AND verifies (valid pinned signature, OBJECTS=ok, exact size + sha256 of every file, no extra files). Sets BSM_SELECTED (path) and BSM_REJECTED (count).
# A set without a manifest is invisible here: loose archives are never a restore point.
BSM_SELECTED=""; BSM_REJECTED=0
export BSM_SELECTED BSM_REJECTED
bsm_select() {
  local m; BSM_SELECTED=""; BSM_REJECTED=0
  while IFS= read -r m; do
    if bsm_verify_signed "$m" "$1"; then BSM_SELECTED="$m"; return 0; fi
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
