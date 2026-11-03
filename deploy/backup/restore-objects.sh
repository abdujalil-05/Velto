#!/usr/bin/env bash
# Restore an object-store backup (velto-objects-*.tar.gpg) into an EMPTY bucket (or a local dir). NEVER targets the live app bucket by default:
# a non-empty destination is refused unless --allow-nonempty. Verifies every object against the embedded manifest (sha256) before upload
# and byte-compares after upload (rclone check --download).
#   restore-objects.sh <archive.gpg> --to-dir <dir> | --to-bucket   [--prefix products/ ...] [--allow-nonempty]
# Env: BACKUP_PASSPHRASE_FILE; for --to-bucket: RESTORE_S3_ENDPOINT RESTORE_S3_BUCKET RESTORE_S3_ACCESS_KEY_ID RESTORE_S3_SECRET_ACCESS_KEY [RESTORE_S3_REGION RESTORE_S3_PROVIDER]
# Needs a restore identity that can PUT to the destination (restore reads the offsite copy with a separate read-only identity: download the file first).
set -Eeuo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup-common.sh
. "$HERE/backup-common.sh"
# shellcheck source=backup-status-lib.sh
. "$HERE/backup-status-lib.sh"
ARCH="${1:?usage: restore-objects.sh <archive.gpg> (--to-dir <dir> | --to-bucket) [--prefix p ...] [--allow-nonempty]}"; shift
MODE=""; DIR=""; NONEMPTY=0; INC=(); EXC=()
while [[ $# -gt 0 ]]; do case "$1" in
  --to-dir) MODE=dir; DIR="${2:?}"; shift 2;;
  --to-bucket) MODE=bucket; shift;;
  --prefix) INC+=(--filter "+ ${2:?}**"); EXC=(--filter '- *'); shift 2;;
  --allow-nonempty) NONEMPTY=1; shift;;
  *) echo "unknown arg $1" >&2; exit 2;; esac; done
[[ -n "$MODE" ]] || { echo "choose --to-dir or --to-bucket" >&2; exit 2; }
[[ -f "$ARCH" && -s "${BACKUP_PASSPHRASE_FILE:-}" ]] || { echo "archive or BACKUP_PASSPHRASE_FILE missing" >&2; exit 1; }
if [[ -f "$ARCH.sha256" ]]; then ( cd "$(dirname "$ARCH")" && b="$(basename "$ARCH")" && grep -q " $b\$" "$b.sha256" && [[ "$(cut -d' ' -f1 "$b.sha256")" == "$(bs_sha256 "$b")" ]] ) || { echo "sha256 sidecar mismatch for the archive" >&2; exit 1; }; fi
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK:?}"' EXIT
gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" --decrypt "$ARCH" | tar -xf - -C "$WORK"
[[ -f "$WORK/MANIFEST.tsv" && -d "$WORK/data" ]] || { echo "archive layout invalid" >&2; exit 1; }
# 1. every object must match the manifest and nothing extra may be present
n=0
while IFS=$'\t' read -r sha size key; do
  [[ "$sha" == \#* ]] && continue
  [[ "$key" != /* && "$key" != *..* ]] || { echo "unsafe key in manifest" >&2; exit 1; }
  f="$WORK/data/$key"
  [[ -f "$f" && "$(bs_size "$f")" == "$size" && "$(bs_sha256 "$f")" == "$sha" ]] || { echo "OBJECT MISMATCH: $key" >&2; exit 1; }
  n=$((n+1))
done < "$WORK/MANIFEST.tsv"
extra="$(find "$WORK/data" -type f | wc -l | tr -d ' ')"
[[ "$extra" == "$n" ]] || { echo "archive has $extra files, manifest lists $n" >&2; exit 1; }
echo "[restore-objects] $n object(s) match the manifest"
if [[ "$MODE" == dir ]]; then
  mkdir -p "$DIR"; [[ -z "$(ls -A "$DIR")" || $NONEMPTY == 1 ]] || { echo "destination dir not empty" >&2; exit 1; }
  rclone copy "$WORK/data" "$DIR" ${INC[@]+"${INC[@]}"} ${EXC[@]+"${EXC[@]}"} >/dev/null
  echo "[restore-objects] OK -> $DIR"; exit 0
fi
: "${RESTORE_S3_ENDPOINT:?}" "${RESTORE_S3_BUCKET:?}" "${RESTORE_S3_ACCESS_KEY_ID:?}" "${RESTORE_S3_SECRET_ACCESS_KEY:?}"
bk_assert_key_separation "RESTORE_S3_ACCESS_KEY_ID" "$RESTORE_S3_ACCESS_KEY_ID"
bk_remote VDST "$RESTORE_S3_ENDPOINT" "$RESTORE_S3_ACCESS_KEY_ID" "$RESTORE_S3_SECRET_ACCESS_KEY" "${RESTORE_S3_REGION:-}" "${RESTORE_S3_PROVIDER:-Other}"
DST="VDST:$RESTORE_S3_BUCKET"
if [[ $NONEMPTY != 1 && -n "$(rclone lsf "$DST" --max-depth 1 2>/dev/null | head -n1)" ]]; then echo "destination bucket is not empty (use --allow-nonempty only if you are sure)" >&2; exit 1; fi
rclone copy "$WORK/data" "$DST" ${INC[@]+"${INC[@]}"} ${EXC[@]+"${EXC[@]}"} --immutable --transfers 8 >/dev/null
rclone check "$WORK/data" "$DST" --download --one-way ${INC[@]+"${INC[@]}"} ${EXC[@]+"${EXC[@]}"} >/dev/null 2>"$WORK/check.log" || { echo "post-restore byte comparison FAILED" >&2; tail -n 3 "$WORK/check.log" >&2; exit 1; }
echo "[restore-objects] OK -> bucket $RESTORE_S3_BUCKET (byte-compared)"
