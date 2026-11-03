#!/usr/bin/env bash
# Velto object-store backup (D-1): mirror the app bucket's 5 prefix groups -> manifest -> tar -> gpg AES256 (same passphrase as the DB dump).
#   products/{companyId}/  imports/{customers|products}/{companyId}/  opening/{opening-customers|opening-stock}/{companyId}/
#   exports/1c/{companyId}/  exports/company/{companyId}/        (keys: apps/api storage.service.ts + FILE-RETENTION-MATRIX.md)
# Any S3-compatible backend through rclone (AWS S3, Wasabi, B2, MinIO, ...): not MinIO-specific.
# NEVER deletes anything in the app bucket (read-only identity; no lifecycle). Local retention only prunes OLD BACKUP ARCHIVES (backup.sh).
# Env (root-only file /etc/velto/backup.env):
#   BACKUP_DIR, BACKUP_PASSPHRASE_FILE                      as backup.sh
#   OBJECTS_SRC_ENDPOINT / _BUCKET / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY / _REGION / _PROVIDER    READ-ONLY identity on the app bucket
#   VELTO_APP_ENV_FILE                                      app env file; its S3_ACCESS_KEY must differ from the keys above (fail-closed)
#   BACKUP_READ_GROUP                                       optional: group that may read the CIPHERTEXT (the deploy user's group)
#   OBJECTS_MIN_FREE_MB                                     optional free-space guard for the staging dir
# Output (stdout, last lines): OBJECTS_FILE=<path> OBJECTS_COUNT=<n> OBJECTS_MANIFEST_SHA256=<hex>
set -Eeuo pipefail
umask 077
: "${BACKUP_DIR:?}" "${OBJECTS_SRC_ENDPOINT:?}" "${OBJECTS_SRC_BUCKET:?}" "${OBJECTS_SRC_ACCESS_KEY_ID:?}" "${OBJECTS_SRC_SECRET_ACCESS_KEY:?}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup-common.sh
. "$HERE/backup-common.sh"
# shellcheck source=backup-status-lib.sh
. "$HERE/backup-status-lib.sh"
command -v rclone >/dev/null && command -v gpg >/dev/null && command -v tar >/dev/null || { echo "rclone, gpg and tar are required" >&2; exit 1; }
[[ -s "${BACKUP_PASSPHRASE_FILE:-}" ]] || { echo "BACKUP_PASSPHRASE_FILE missing/empty" >&2; exit 1; }
bk_assert_key_separation "OBJECTS_SRC_ACCESS_KEY_ID" "$OBJECTS_SRC_ACCESS_KEY_ID" ${OFFSITE_S3_ACCESS_KEY_ID:+"OFFSITE_S3_ACCESS_KEY_ID" "$OFFSITE_S3_ACCESS_KEY_ID"}
bk_remote VSRC "$OBJECTS_SRC_ENDPOINT" "$OBJECTS_SRC_ACCESS_KEY_ID" "$OBJECTS_SRC_SECRET_ACCESS_KEY" "${OBJECTS_SRC_REGION:-}" "${OBJECTS_SRC_PROVIDER:-Other}"
unset OBJECTS_SRC_SECRET_ACCESS_KEY OBJECTS_SRC_ACCESS_KEY_ID
SRC="VSRC:$OBJECTS_SRC_BUCKET"

# The five prefix groups (everything else in the bucket is reported, not copied)
FILTER=(--filter '+ products/**' --filter '+ imports/customers/**' --filter '+ imports/products/**'
        --filter '+ opening/opening-customers/**' --filter '+ opening/opening-stock/**'
        --filter '+ exports/1c/**' --filter '+ exports/company/**' --filter '- *')

mkdir -p "$BACKUP_DIR"; chmod o-rwx "$BACKUP_DIR"
WORK="$(mktemp -d "$BACKUP_DIR/.objects-work.XXXXXX")"
OK=0; TS="$(date +%Y%m%d-%H%M%S)"; OUT="$BACKUP_DIR/velto-objects-$TS.tar.gpg"
cleanup() { rm -rf "${WORK:?}"; [[ "$OK" == 1 ]] || rm -f "$OUT" "$OUT.sha256"; }
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
enc() { gpg --batch --yes --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" --symmetric --cipher-algo AES256 -o "$1"; }
dec() { gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" --decrypt "$1"; }

echo "[objects] listing $OBJECTS_SRC_BUCKET (5 prefix groups)"
rclone lsf "$SRC" -R --files-only --format ps --separator $'\t' "${FILTER[@]}" | LC_ALL=C sort -t $'\t' -k1,1 > "$WORK/pre.tsv"
# sizes: lsf prints "path<TAB>size"; keys with control chars are refused (they cannot be represented in the manifest)
if grep -q $'\r' "$WORK/pre.tsv"; then echo "[objects] key with control characters: refusing" >&2; exit 1; fi
PRE_COUNT="$(wc -l < "$WORK/pre.tsv" | tr -d ' ')"
OTHER="$(rclone lsf "$SRC" -R --files-only 2>/dev/null | grep -Evc '^(products/|imports/(customers|products)/|opening/(opening-customers|opening-stock)/|exports/(1c|company)/)' || true)"
[[ "${OTHER:-0}" == 0 ]] || echo "[objects] WARN: $OTHER object(s) outside the 5 prefix groups are NOT backed up" >&2
if [[ -n "${OBJECTS_MIN_FREE_MB:-}" ]]; then
  free="$(df -Pk "$BACKUP_DIR" | awk 'NR==2{print int($4/1024)}')"
  (( free >= OBJECTS_MIN_FREE_MB )) || { echo "[objects] only ${free} MB free, need ${OBJECTS_MIN_FREE_MB}" >&2; exit 1; }
fi

mkdir "$WORK/data"
echo "[objects] copying $PRE_COUNT object(s)"
rclone copy "$SRC" "$WORK/data" "${FILTER[@]}" --checksum --retries 3 --low-level-retries 5 --transfers 8 >/dev/null

# manifest = what is really on disk now: sha256, size, key (sorted by key, bytewise)
{
  echo "# velto-objects-manifest v1 bucket=$OBJECTS_SRC_BUCKET created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ( cd "$WORK/data" && find . -type f -print | sed 's#^\./##' | LC_ALL=C sort | while IFS= read -r k; do
      printf '%s\t%s\t%s\n' "$(bs_sha256 "$k")" "$(bs_size "$k")" "$k"
    done )
} > "$WORK/MANIFEST.tsv"
# every object that existed BEFORE the copy must be present with the same size (objects added meanwhile are fine)
awk -F'\t' 'NR==FNR{ if ($0 !~ /^#/) have[$3]=$2; next } { if (!($1 in have)) {print "missing: " $1; bad=1} else if (have[$1] != $2) {print "size differs: " $1; bad=1} } END{exit bad}' \
  "$WORK/MANIFEST.tsv" "$WORK/pre.tsv" >"$WORK/diff.txt" || { echo "[objects] copy is inconsistent with the source listing:" >&2; head -n 5 "$WORK/diff.txt" >&2; exit 1; }
COUNT="$(grep -vc '^#' "$WORK/MANIFEST.tsv" || true)"
MSHA="$(bs_sha256 "$WORK/MANIFEST.tsv")"

echo "[objects] tar + gpg -> $OUT"
tar -C "$WORK" -cf - MANIFEST.tsv data | enc "$OUT"
# verify: stream-decrypt, the tar must list MANIFEST.tsv + all objects, and the embedded manifest must hash to MSHA
LISTED="$(dec "$OUT" | tar -tf - | grep -c -v '/$' || true)"
(( LISTED == COUNT + 1 )) || { echo "[objects] verification FAILED: archive lists $LISTED files, expected $((COUNT + 1))" >&2; exit 1; }
EMB="$(dec "$OUT" | tar -xOf - MANIFEST.tsv | { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; } | cut -d' ' -f1)"
[[ "$EMB" == "$MSHA" ]] || { echo "[objects] verification FAILED: embedded manifest hash differs" >&2; exit 1; }
( cd "$BACKUP_DIR" && b="$(basename "$OUT")" && { if command -v sha256sum >/dev/null; then sha256sum "$b"; else shasum -a 256 "$b"; fi; } > "$b.sha256" )
if [[ -n "${BACKUP_READ_GROUP:-}" ]]; then chgrp "$BACKUP_READ_GROUP" "$OUT" "$OUT.sha256" && chmod 640 "$OUT" "$OUT.sha256"; fi
OK=1
echo "[objects] OK $COUNT object(s), $(du -h "$OUT" | cut -f1)"
echo "OBJECTS_COUNT=$COUNT"; echo "OBJECTS_MANIFEST_SHA256=$MSHA"; echo "OBJECTS_FILE=$OUT"
