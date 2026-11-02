#!/usr/bin/env bash
# Offsite copy of ALREADY-ENCRYPTED backups (*.gpg + *.sha256) to any S3-compatible bucket via rclone.
# Credentials are SEPARATE from the app's S3_* / MinIO keys: a dedicated, write-only identity (see docs/release/BACKUP-RESTORE-RUNBOOK.md).
# The gpg passphrase is NEVER uploaded. Plaintext is never uploaded (only velto-*.gpg / velto-*.gpg.sha256 are included).
# Uses `rclone copy --immutable` (never deletes, never overwrites; errors if an existing object differs) — NOT `sync`.
# Env (from the root-only env file; no secrets in the repo):
#   BACKUP_DIR                       local dir with the backups
#   OFFSITE_BUCKET                   bucket (+ optional prefix), e.g. velto-backups/prod
#   OFFSITE_S3_ENDPOINT              S3 API endpoint of the offsite provider (must differ from the app's storage)
#   OFFSITE_S3_ACCESS_KEY_ID / OFFSITE_S3_SECRET_ACCESS_KEY   dedicated put-only credentials
#   OFFSITE_S3_REGION                optional; OFFSITE_S3_PROVIDER optional (default Other)
#   OFFSITE_MAX_AGE                  only upload files newer than this (default 3d; rclone --max-age)
# Needs: rclone. Run by backup-run.sh when OFFSITE_ENABLED=1.
set -Eeuo pipefail
: "${BACKUP_DIR:?}" "${OFFSITE_BUCKET:?}" "${OFFSITE_S3_ENDPOINT:?}" "${OFFSITE_S3_ACCESS_KEY_ID:?}" "${OFFSITE_S3_SECRET_ACCESS_KEY:?}"
command -v rclone >/dev/null || { echo "rclone not found" >&2; exit 1; }
[[ "$OFFSITE_S3_ENDPOINT" == https://* ]] || { echo "OFFSITE_S3_ENDPOINT must be https://" >&2; exit 1; }
# rclone config entirely via env (nothing written to disk, creds not on the command line)
export RCLONE_CONFIG_VOFF_TYPE=s3 RCLONE_CONFIG_VOFF_PROVIDER="${OFFSITE_S3_PROVIDER:-Other}" \
  RCLONE_CONFIG_VOFF_ENDPOINT="$OFFSITE_S3_ENDPOINT" RCLONE_CONFIG_VOFF_REGION="${OFFSITE_S3_REGION:-}" \
  RCLONE_CONFIG_VOFF_ACCESS_KEY_ID="$OFFSITE_S3_ACCESS_KEY_ID" RCLONE_CONFIG_VOFF_SECRET_ACCESS_KEY="$OFFSITE_S3_SECRET_ACCESS_KEY" \
  RCLONE_CONFIG_VOFF_NO_CHECK_BUCKET=true   # put-only key cannot create/list buckets
unset OFFSITE_S3_SECRET_ACCESS_KEY OFFSITE_S3_ACCESS_KEY_ID
echo "[offsite] rclone copy --immutable $BACKUP_DIR -> VOFF:$OFFSITE_BUCKET"
rclone copy "$BACKUP_DIR" "VOFF:$OFFSITE_BUCKET" --immutable --max-age "${OFFSITE_MAX_AGE:-3d}" \
  --include 'velto-db-*.gpg' --include 'velto-db-*.gpg.sha256' --include 'velto-globals-*.gpg' --include 'velto-globals-*.gpg.sha256' \
  --s3-no-head --retries 3 --low-level-retries 5 --stats-one-line -v
echo "[offsite] OK"
