#!/usr/bin/env bash
# Production gate used by deploy.sh (as velto-deploy). Exit 0 only for a fresh, root-attested, intact backup.
# Deliberately NO knob for the expected owner: it is the literal uid 0. The only tunables are the (harmless) paths, the age limit
# and requirement flags; pointing the paths at a self-made directory still fails the root-owner check.
#   VELTO_BACKUP_STATUS_FILE  default /var/lib/velto-backup/status
#   VELTO_BACKUP_DIR          default /var/backups/velto
#   VELTO_BACKUP_MAX_AGE_MIN  default 60 with --trigger (fresh backup just taken), 90 without (hourly timer + jitter + run time); max 1440 (larger is rejected)
#   VELTO_REQUIRE_OBJECTS     default 1   (0 only while the object backup is not yet enabled)
#   VELTO_REQUIRE_OFFSITE     default 0
# --trigger: first `sudo -n systemctl start velto-backup.service` (fresh backup), then check that the status was refreshed.
set -uo pipefail
unset VBS_START_CMD   # never inherit the sudo command from the environment (a scalar env var would be run as the command)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup-status-lib.sh
. "$HERE/backup-status-lib.sh"
TRIGGER=0; [[ "${1:-}" == "--trigger" ]] && TRIGGER=1
MAX_AGE="${VELTO_BACKUP_MAX_AGE_MIN:-$(( TRIGGER == 1 ? 60 : 90 ))}"
[[ "$MAX_AGE" =~ ^[0-9]{1,4}$ ]] && (( 10#$MAX_AGE <= 1440 )) || { echo "[backup-gate] FAIL: VELTO_BACKUP_MAX_AGE_MIN must be an integer <= 1440 (got '$MAX_AGE')" >&2; exit 1; }
MAX_AGE=$((10#$MAX_AGE))
if vbs_gate "${VELTO_BACKUP_STATUS_FILE:-/var/lib/velto-backup/status}" "${VELTO_BACKUP_DIR:-/var/backups/velto}" \
     "$MAX_AGE" 0 "${VELTO_REQUIRE_OBJECTS:-1}" "$TRIGGER"; then
  echo "[backup-gate] OK run=$VBS_RUN_ID age=${VBS_AGE_MIN}min db=$VBS_DB_ARCHIVE objects=${VBS_OBJ_ARCHIVE:-none}"
  echo "VBS_DB_ARCHIVE=$VBS_DB_ARCHIVE"
  echo "VBS_TIMESTAMP_EPOCH=$VBS_TIMESTAMP_EPOCH"
else
  exit 1
fi
