#!/usr/bin/env bash
# Velto encrypted DB backup (TZ 12.2 / 10.3 / 11.3). Run from cron/systemd timer on the VPS (user action).
#   pg_dump -Fc (as velto_system: app role cannot read AuditLog under FORCE RLS)
#   + pg_dumpall --globals-only (roles; needs a role allowed to read pg_authid -> BACKUP_GLOBALS_URL, optional)
#   -> gpg --symmetric AES256, passphrase from a file/env that is NEVER stored in the repo.
# Env:
#   DATABASE_SYSTEM_URL        required (velto_system URL; ?schema= is stripped)
#   BACKUP_DIR                 required (output dir, e.g. /var/backups/velto; mode 700)
#   BACKUP_PASSPHRASE_FILE     path to passphrase file (preferred) OR BACKUP_PASSPHRASE (env)
#   BACKUP_RETENTION_DAYS      default 14
#   BACKUP_GLOBALS_URL         optional superuser URL for pg_dumpall --globals-only; if unset globals are skipped with a warning
# Exit 0 only if every produced artifact was written, encrypted and verified readable. Non-zero => alert (TZ 12.3 "backup failure").
set -Eeuo pipefail
umask 077

: "${DATABASE_SYSTEM_URL:?DATABASE_SYSTEM_URL is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
[[ "$RETENTION" =~ ^[0-9]+$ ]] || { echo "BACKUP_RETENTION_DAYS must be an integer" >&2; exit 1; }
command -v gpg >/dev/null || { echo "gpg not found" >&2; exit 1; }
command -v pg_dump >/dev/null || { echo "pg_dump not found" >&2; exit 1; }

PASSFILE=""
CLEAN_PASS=0
if [[ -n "${BACKUP_PASSPHRASE_FILE:-}" ]]; then
  [[ -s "$BACKUP_PASSPHRASE_FILE" ]] || { echo "BACKUP_PASSPHRASE_FILE missing/empty" >&2; exit 1; }
  PASSFILE="$BACKUP_PASSPHRASE_FILE"
elif [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
  PASSFILE="$(mktemp)"; CLEAN_PASS=1
  printf '%s' "$BACKUP_PASSPHRASE" > "$PASSFILE"
else
  echo "set BACKUP_PASSPHRASE_FILE or BACKUP_PASSPHRASE" >&2; exit 1
fi
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"

TS="$(date +%Y%m%d-%H%M%S)"
DUMP="$BACKUP_DIR/velto-db-$TS.dump.gpg"
GLOB="$BACKUP_DIR/velto-globals-$TS.sql.gpg"
cleanup() { [[ "$CLEAN_PASS" == 1 ]] && rm -f "$PASSFILE"; [[ "${OK:-0}" == 1 ]] || rm -f "$DUMP" "$GLOB" "$DUMP.sha256" "$GLOB.sha256"; }
trap cleanup EXIT

# Portable sha256 (Linux sha256sum / macOS shasum). Sidecar uses the bare file name so `sha256sum -c` works from the backup dir.
if command -v sha256sum >/dev/null; then SHA=(sha256sum); else SHA=(shasum -a 256); fi
seal() { local d b; d="$(dirname "$1")"; b="$(basename "$1")"; (cd "$d" && "${SHA[@]}" "$b" > "$b.sha256" && "${SHA[@]}" -c "$b.sha256" >/dev/null) || { echo "[backup] sha256 FAILED for $1" >&2; return 1; }; }

enc() { gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASSFILE" --symmetric --cipher-algo AES256 -o "$1"; }
dec() { gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$PASSFILE" --decrypt "$1"; }

echo "[backup] pg_dump -Fc -> $DUMP"
pg_dump -Fc "${DATABASE_SYSTEM_URL%%\?*}" | enc "$DUMP"
# Verify by streaming (no plaintext on disk): pg_restore -l may stop reading early => drain stdin to avoid SIGPIPE/pipefail on dec.
dec "$DUMP" | { pg_restore -l >/dev/null; rc=$?; cat >/dev/null; exit $rc; } || { echo "[backup] verification FAILED for $DUMP" >&2; exit 1; }
seal "$DUMP"

if [[ -n "${BACKUP_GLOBALS_URL:-}" ]]; then
  echo "[backup] pg_dumpall --globals-only -> $GLOB"
  pg_dumpall --globals-only -d "${BACKUP_GLOBALS_URL%%\?*}" | enc "$GLOB"
  dec "$GLOB" | grep 'CREATE ROLE' >/dev/null || { echo "[backup] globals verification FAILED" >&2; exit 1; }
  seal "$GLOB"
else
  echo "[backup] WARN: BACKUP_GLOBALS_URL unset -> globals skipped (roles come from packages/database/scripts/provision-roles.sql)" >&2
fi
OK=1

echo "[backup] retention: deleting velto-*.gpg and .gpg.sha256 older than $RETENTION days"
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'velto-db-*.gpg' -o -name 'velto-globals-*.gpg' -o -name 'velto-db-*.gpg.sha256' -o -name 'velto-globals-*.gpg.sha256' \) -mtime +"$RETENTION" -print -delete
echo "[backup] OK $(du -h "$DUMP" | cut -f1) $DUMP"
echo "BACKUP_FILE=$DUMP"  # last line: deploy.sh parses this (path may contain spaces)
