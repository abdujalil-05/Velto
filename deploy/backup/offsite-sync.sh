#!/usr/bin/env bash
# Offsite copy of ONE RESTORE SET (the archives + .sha256 + fingerprint listed in its velto-set-<TS>.manifest, plus the manifest and its detached .manifest.sig) to any S3-compatible bucket via rclone, then VERIFICATION.
# Order: validate the set locally (signature, sizes, sha256, no extra files) -> upload archives -> LIST + exact-size check -> upload .sig, then the manifest LAST -> LIST + size check of everything
# -> READ-BACK: every object (archives, fingerprint, sig, manifest) is downloaded through a READ-ONLY identity and its sha256 compared with the local/manifest value.
# Offsite is attested (stdout marker OFFSITE_VERIFIED_RESTORE_POINT_TS=<n>) only after that. Size is NOT proof of content, and a multipart ETag is not an MD5, so the read-back is the mandatory
# default for every provider; if it cannot run (no OFFSITE_VERIFY_* identity, download error) or any hash differs, the run FAILS CLOSED (exit 11 -> offsite_result=failed). There is no switch to skip it.
# Egress cost: the whole set is downloaded once per run (about 1x the upload volume; 3 runs/h at a 20-min cadence). Provider-side checksums (S3 additional checksums) could replace it; not used: provider unknown.
# Identity = "backup-writer" offsite key: PUT-ONLY on the offsite bucket (policies/offsite-backup-writer-put-only.json). It is NEVER the app's key:
# the script fails if OFFSITE_S3_ACCESS_KEY_ID equals the app's S3_ACCESS_KEY (VELTO_APP_ENV_FILE) or the object-read key (OBJECTS_SRC_*).
# The gpg passphrase is NEVER uploaded; plaintext is never uploaded (include-list below).
# `rclone copy --ignore-existing` (never deletes, never overwrites; skips names already offsite via LIST, no HEAD/GET needed) - NOT `sync`. Unique timestamped names.
# The read-back identity (OFFSITE_VERIFY_S3_*) is a THIRD, separate key: GET+LIST only (policies/offsite-restore-read.json), no write/delete, never equal to the writer, app or objects keys.
# Verified against MinIO: with a put+list-only key, `--immutable` fails on re-run (needs HEAD) and a bucket PREFIX in the remote path fails (rclone HEADs it) -> OFFSITE_BUCKET is a bare bucket name.
# Offsite bucket: versioning + Object Lock (retention 30 days, PO D-4) - see policies/README.md. Nothing here deletes anything offsite.
# Env (root-only env file; no secrets in the repo):
#   BACKUP_DIR, OFFSITE_BUCKET (bare bucket name, no '/'), OFFSITE_S3_ENDPOINT (https://; http:// only for loopback tests)
#   OFFSITE_S3_ACCESS_KEY_ID / OFFSITE_S3_SECRET_ACCESS_KEY, OFFSITE_S3_REGION, OFFSITE_S3_PROVIDER (default Other)
#   OFFSITE_VERIFY_S3_ACCESS_KEY_ID / OFFSITE_VERIFY_S3_SECRET_ACCESS_KEY (read-only, mandatory), OFFSITE_VERIFY_S3_ENDPOINT (default: OFFSITE_S3_ENDPOINT)
#   BACKUP_VERIFY_KEYRING + BACKUP_TRUSTED_SIGN_FPRS (public key + pinned fingerprints: the manifest signature is re-verified before anything is uploaded)
#   OFFSITE_MANIFEST (path of the set manifest; set by backup-run.sh. Standalone: taken from SET_MANIFEST in the status file)
#   VELTO_APP_ENV_FILE (required for the key-separation check; BACKUP_REQUIRE_KEY_SEPARATION=0 disables - NOT for production)
set -Euo pipefail
: "${BACKUP_DIR:?}" "${OFFSITE_BUCKET:?}" "${OFFSITE_S3_ENDPOINT:?}" "${OFFSITE_S3_ACCESS_KEY_ID:?}" "${OFFSITE_S3_SECRET_ACCESS_KEY:?}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup-common.sh
. "$HERE/backup-common.sh"
[[ "$OFFSITE_BUCKET" != */* ]] || { echo "OFFSITE_BUCKET must be a bare bucket name (a put+list-only key cannot open a prefix root)" >&2; exit 1; }
command -v rclone >/dev/null || { echo "rclone not found" >&2; exit 1; }
READBACK_OK=0
if [[ -n "${OFFSITE_VERIFY_S3_ACCESS_KEY_ID:-}" && -n "${OFFSITE_VERIFY_S3_SECRET_ACCESS_KEY:-}" ]]; then READBACK_OK=1; fi
bk_assert_key_separation "OFFSITE_S3_ACCESS_KEY_ID" "$OFFSITE_S3_ACCESS_KEY_ID" ${OFFSITE_VERIFY_S3_ACCESS_KEY_ID:+"OFFSITE_VERIFY_S3_ACCESS_KEY_ID" "$OFFSITE_VERIFY_S3_ACCESS_KEY_ID"} \
  ${OBJECTS_SRC_ACCESS_KEY_ID:+"OBJECTS_SRC_ACCESS_KEY_ID" "$OBJECTS_SRC_ACCESS_KEY_ID"} || exit 1
# put-only key cannot create/list buckets (NO_CHECK_BUCKET is set by bk_remote)
bk_remote VOFF "$OFFSITE_S3_ENDPOINT" "$OFFSITE_S3_ACCESS_KEY_ID" "$OFFSITE_S3_SECRET_ACCESS_KEY" "${OFFSITE_S3_REGION:-}" "${OFFSITE_S3_PROVIDER:-Other}" || exit 1
if [[ $READBACK_OK == 1 ]]; then
  bk_remote VRD "${OFFSITE_VERIFY_S3_ENDPOINT:-$OFFSITE_S3_ENDPOINT}" "$OFFSITE_VERIFY_S3_ACCESS_KEY_ID" "$OFFSITE_VERIFY_S3_SECRET_ACCESS_KEY" "${OFFSITE_S3_REGION:-}" "${OFFSITE_S3_PROVIDER:-Other}" || exit 1
fi
unset OFFSITE_S3_SECRET_ACCESS_KEY OFFSITE_S3_ACCESS_KEY_ID OFFSITE_VERIFY_S3_SECRET_ACCESS_KEY OFFSITE_VERIFY_S3_ACCESS_KEY_ID
# --- the set: manifest (explicit, or the one the status attests)
SDIR="${BACKUP_STATUS_DIR:-/var/lib/velto-backup}"
# shellcheck source=backup-status-lib.sh
. "$HERE/backup-status-lib.sh"
MANIFEST="${OFFSITE_MANIFEST:-}"
if [[ -z "$MANIFEST" ]]; then
  mn="$(grep -E '^SET_MANIFEST=' "$SDIR/status" 2>/dev/null | head -n1 | cut -d= -f2-)"
  [[ "$mn" =~ $BS_MANIFEST_RE ]] && MANIFEST="$BACKUP_DIR/$mn"
fi
fail() { echo "[offsite] FAILED: $2" >&2; STANDALONE_FAIL "$1"; exit "$1"; }
STANDALONE_FAIL() { # keep previous offsite_ts / offsite_restore_point_ts; only the result changes
  [[ -z "${BACKUP_RUN_ACTIVE:-}" && -f "$SDIR/status" ]] && { bs_update "$SDIR" offsite_result=failed OFFSITE=failed || echo "[offsite] WARN: could not update status" >&2; }
  return 0
}
[[ -n "$MANIFEST" ]] || fail 12 "no restore-set manifest (OFFSITE_MANIFEST unset and no SET_MANIFEST in the status): nothing to upload"
[[ $READBACK_OK == 1 ]] || fail 11 "read-back verification unavailable: OFFSITE_VERIFY_S3_ACCESS_KEY_ID / OFFSITE_VERIFY_S3_SECRET_ACCESS_KEY not set (size alone is no proof; nothing uploaded)"
bsm_sig_verify "$MANIFEST" || fail 12 "manifest signature invalid: $BSM_REASON"
bsm_verify "$MANIFEST" "$BACKUP_DIR" 1 || fail 12 "restore set invalid: $BSM_REASON"
bsm_set_complete "$MANIFEST" "$BACKUP_DIR" || fail 12 "restore set invalid: $BSM_REASON"
RP="$(bsm_get RESTORE_POINT_TS)"; MNAME="$(basename "$MANIFEST")"

TMPD="$(umask 077; mktemp -d)"; trap 'rm -rf "${TMPD:?}"' EXIT
: > "$TMPD/archives.lst"; : > "$TMPD/expect-archives.tsv"
: > "$TMPD/expect-sha.tsv"
for f in DB GLOBALS OBJ FP; do
  n="$(bsm_get ${f}_ARCHIVE)"; [[ -n "$n" ]] || continue
  echo "$n" >> "$TMPD/archives.lst"; [[ ! -f "$BACKUP_DIR/$n.sha256" ]] || echo "$n.sha256" >> "$TMPD/archives.lst"
  printf '%s\t%s\n' "$n" "$(bsm_get ${f}_SIZE)" >> "$TMPD/expect-archives.tsv"
  printf '%s\t%s\n' "$n" "$(bsm_get ${f}_SHA256)" >> "$TMPD/expect-sha.tsv"
done
echo "$MNAME.sig" > "$TMPD/sig.lst"; echo "$MNAME" > "$TMPD/manifest.lst"
{ cat "$TMPD/expect-archives.tsv"; printf '%s\t%s\n' "$MNAME.sig" "$(bs_size "$MANIFEST.sig")"; printf '%s\t%s\n' "$MNAME" "$(bs_size "$MANIFEST")"; } > "$TMPD/expect-all.tsv"
printf '%s\t%s\n%s\t%s\n' "$MNAME.sig" "$(bs_sha256 "$MANIFEST.sig")" "$MNAME" "$(bs_sha256 "$MANIFEST")" >> "$TMPD/expect-sha.tsv"

upload() { # list-file; --ignore-existing: skips names already offsite via LIST (unique names; S3 PUT is atomic, so no partial object can exist under a name)
  rclone copy "$BACKUP_DIR" "VOFF:$OFFSITE_BUCKET" --files-from "$1" --ignore-existing --s3-no-head --retries 3 --low-level-retries 5 --stats-one-line -v
}
verify_remote() { # expect.tsv (name<TAB>size): every entry present offsite with EXACT size (LIST only: works with the put+list-only key)
  rclone lsf "VOFF:$OFFSITE_BUCKET" --files-only --format ps --separator $'\t' --include 'velto-*' > "$TMPD/remote.tsv" 2>"$TMPD/lsf.err" \
    || { echo "[offsite] listing failed" >&2; return 1; }
  awk -F'\t' 'NR==FNR{r[$1]=$2; next} { if (!($1 in r)) {print "missing offsite: " $1; bad=1} else if (r[$1] != $2) {print "size differs offsite: " $1; bad=1} } END{exit bad}' \
    "$TMPD/remote.tsv" "$1" > "$TMPD/verify.txt" || { head -n 5 "$TMPD/verify.txt" >&2; return 1; }
}

readback() { # expect-sha.tsv (name<TAB>sha256): download each object through the READ-ONLY identity and compare the sha256 of the BYTES (content proof; size/ETag are not)
  local n want got
  while IFS=$'\t' read -r n want; do
    got="$(set -o pipefail; rclone cat "VRD:$OFFSITE_BUCKET/$n" --retries 3 --low-level-retries 5 2>/dev/null | bs_sha256_stdin)" || { echo "[offsite] read-back download failed: $n" >&2; return 1; }
    [[ "$got" == "$want" ]] || { echo "[offsite] read-back sha256 MISMATCH offsite: $n" >&2; return 1; }
  done < "$1"
}

echo "[offsite] set $MNAME -> VOFF:$OFFSITE_BUCKET (archives first, then sig, manifest last; then read-back)"
upload "$TMPD/archives.lst" || fail 10 "archive upload failed"
verify_remote "$TMPD/expect-archives.tsv" || fail 11 "archives not verified offsite (before the manifest was uploaded)"
upload "$TMPD/sig.lst" || fail 10 "signature upload failed"
upload "$TMPD/manifest.lst" || fail 10 "manifest upload failed"
verify_remote "$TMPD/expect-all.tsv" || fail 11 "set not verified offsite (archives + sig + manifest)"
readback "$TMPD/expect-sha.tsv" || fail 11 "offsite content differs from the local set or cannot be read back"
echo "[offsite] OK: listing (exact sizes) + read-back sha256 of every object (archives, fingerprint, signature, manifest) equal the local set"
echo "OFFSITE_VERIFIED_RESTORE_POINT_TS=$RP"
# Standalone run (not via backup-run.sh): confirm in the status attestation (atomic, root-owned dir), only for the set the status itself attests.
if [[ -z "${BACKUP_RUN_ACTIVE:-}" && -f "$SDIR/status" ]]; then
  bs_update "$SDIR" "offsite_restore_point_ts=$RP" "offsite_ts=$(date -u +%s)" offsite_result=ok OFFSITE=ok || echo "[offsite] WARN: could not update status" >&2
fi
