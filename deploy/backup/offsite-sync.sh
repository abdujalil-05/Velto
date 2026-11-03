#!/usr/bin/env bash
# Offsite copy of ALREADY-ENCRYPTED backups (velto-{db,globals,objects}-* .gpg + .sha256) to any S3-compatible bucket via rclone.
# Identity = "backup-writer" offsite key: PUT-ONLY on the offsite bucket (policies/offsite-backup-writer-put-only.json). It is NEVER the app's key:
# the script fails if OFFSITE_S3_ACCESS_KEY_ID equals the app's S3_ACCESS_KEY (VELTO_APP_ENV_FILE) or the object-read key (OBJECTS_SRC_*).
# The gpg passphrase is NEVER uploaded; plaintext is never uploaded (include-list below).
# `rclone copy --ignore-existing` (never deletes, never overwrites; skips names already offsite via LIST, no HEAD/GET needed) - NOT `sync`. Unique timestamped names.
# Verified against MinIO: with a put+list-only key, `--immutable` fails on re-run (needs HEAD) and a bucket PREFIX in the remote path fails (rclone HEADs it) -> OFFSITE_BUCKET is a bare bucket name.
# Offsite bucket: versioning + Object Lock (retention 30 days, PO D-4) - see policies/README.md. Nothing here deletes anything offsite.
# Env (root-only env file; no secrets in the repo):
#   BACKUP_DIR, OFFSITE_BUCKET (bare bucket name, no '/'), OFFSITE_S3_ENDPOINT (https://; http:// only for loopback tests)
#   OFFSITE_S3_ACCESS_KEY_ID / OFFSITE_S3_SECRET_ACCESS_KEY, OFFSITE_S3_REGION, OFFSITE_S3_PROVIDER (default Other)
#   OFFSITE_MAX_AGE (default 3d: only files newer than this are offered)
#   VELTO_APP_ENV_FILE (required for the key-separation check; BACKUP_REQUIRE_KEY_SEPARATION=0 disables - NOT for production)
set -Eeuo pipefail
: "${BACKUP_DIR:?}" "${OFFSITE_BUCKET:?}" "${OFFSITE_S3_ENDPOINT:?}" "${OFFSITE_S3_ACCESS_KEY_ID:?}" "${OFFSITE_S3_SECRET_ACCESS_KEY:?}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup-common.sh
. "$HERE/backup-common.sh"
[[ "$OFFSITE_BUCKET" != */* ]] || { echo "OFFSITE_BUCKET must be a bare bucket name (a put+list-only key cannot open a prefix root)" >&2; exit 1; }
command -v rclone >/dev/null || { echo "rclone not found" >&2; exit 1; }
bk_assert_key_separation "OFFSITE_S3_ACCESS_KEY_ID" "$OFFSITE_S3_ACCESS_KEY_ID" ${OBJECTS_SRC_ACCESS_KEY_ID:+"OBJECTS_SRC_ACCESS_KEY_ID" "$OBJECTS_SRC_ACCESS_KEY_ID"} || exit 1
# put-only key cannot create/list buckets (NO_CHECK_BUCKET is set by bk_remote)
bk_remote VOFF "$OFFSITE_S3_ENDPOINT" "$OFFSITE_S3_ACCESS_KEY_ID" "$OFFSITE_S3_SECRET_ACCESS_KEY" "${OFFSITE_S3_REGION:-}" "${OFFSITE_S3_PROVIDER:-Other}" || exit 1
unset OFFSITE_S3_SECRET_ACCESS_KEY OFFSITE_S3_ACCESS_KEY_ID
echo "[offsite] rclone copy --ignore-existing $BACKUP_DIR -> VOFF:$OFFSITE_BUCKET"
rclone copy "$BACKUP_DIR" "VOFF:$OFFSITE_BUCKET" --ignore-existing --max-age "${OFFSITE_MAX_AGE:-3d}" \
  --filter '+ velto-db-*.gpg' --filter '+ velto-db-*.gpg.sha256' --filter '+ velto-globals-*.gpg' --filter '+ velto-globals-*.gpg.sha256' \
  --filter '+ velto-objects-*.gpg' --filter '+ velto-objects-*.gpg.sha256' --filter '- *' \
  --s3-no-head --retries 3 --low-level-retries 5 --stats-one-line -v
echo "[offsite] OK"
# Standalone run (not via backup-run.sh): confirm in the status attestation (atomic, root-owned dir).
if [[ -z "${BACKUP_RUN_ACTIVE:-}" && -f "${BACKUP_STATUS_DIR:-/var/lib/velto-backup}/status" ]]; then
  # shellcheck source=backup-status-lib.sh
  . "$HERE/backup-status-lib.sh"
  bs_update "${BACKUP_STATUS_DIR:-/var/lib/velto-backup}" "offsite_ts=$(date -u +%s)" offsite_result=ok OFFSITE=ok || echo "[offsite] WARN: could not update status" >&2
fi
