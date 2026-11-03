#!/usr/bin/env bash
# Velto encrypted DB backup (TZ 12.2 / 10.3 / 11.3). Run from cron/systemd timer on the VPS (user action).
#   pg_dump -Fc (as velto_backup: app role cannot read AuditLog under FORCE RLS)
#   + pg_dumpall --globals-only (roles; needs a role allowed to read pg_authid -> BACKUP_GLOBALS_URL, optional)
#   -> gpg --symmetric AES256, passphrase from a file/env that is NEVER stored in the repo.
# Env:
#   DATABASE_BACKUP_URL        required: URL of the dedicated read-only `velto_backup` role (packages/database/scripts/provision-backup-role.sql: SELECT only,
#                              BYPASSRLS so pg_dump is complete under FORCE RLS, read-only sessions). ?schema= is stripped. Password never in argv (0600 PGPASSFILE, pg-conn.sh).
#                              No --enable-row-security (it silently yields empty tenant tables). velto_system is NOT used for backups.
#   BACKUP_DIR                 required (output dir, e.g. /var/backups/velto; mode 700)
#   BACKUP_PASSPHRASE_FILE     path to passphrase file (preferred) OR BACKUP_PASSPHRASE (env)
#   BACKUP_RETENTION_DAYS      default 30 (PO D-4); prunes only old velto-*.gpg backup files, never application data
#   BACKUP_READ_GROUP          optional: group (the deploy user's) allowed to READ the ciphertext (0640 root:<group>); it never gets the passphrase
#   BACKUP_GLOBALS_URL         optional separate URL for pg_dumpall --globals-only; default: the same backup role (globals are dumped with --no-role-passwords,
#                              so no pg_authid access is needed; role passwords are re-set from provision-roles.sql/secrets on restore)
# Exit 0 only if every produced artifact was written, encrypted and verified readable. Non-zero => alert (TZ 12.3 "backup failure").
set -Eeuo pipefail
umask 077
unset PGPASSWORD PGSERVICE PGSERVICEFILE PGPASSFILE   # only the generated 0600 pgpass may supply the password

: "${DATABASE_BACKUP_URL:?DATABASE_BACKUP_URL is required (velto_backup role; velto_system is no longer used for backups)}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"
RETENTION="${BACKUP_RETENTION_DAYS:-30}"
[[ "$RETENTION" =~ ^[0-9]+$ ]] || { echo "BACKUP_RETENTION_DAYS must be an integer" >&2; exit 1; }
command -v gpg >/dev/null || { echo "gpg not found" >&2; exit 1; }
command -v pg_dump >/dev/null || { echo "pg_dump not found" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pg-conn.sh
. "$HERE/pg-conn.sh"
# DB passwords go ONLY to a 0600 PGPASSFILE in a 0700 mktemp dir (never argv); removed on EXIT/INT/TERM.
trap 'exit 130' INT; trap 'exit 143' TERM
trap pgc_cleanup EXIT
pgc_init
pgc_parse "$DATABASE_BACKUP_URL" || { echo "backup database URL is not parseable" >&2; exit 1; }
DB_ARGS=(-h "$PGC_HOST" -p "$PGC_PORT" -U "$PGC_USER" -d "$PGC_DB")
G_ARGS=(-h "$PGC_HOST" -p "$PGC_PORT" -U "$PGC_USER" -l "$PGC_DB")   # pg_dumpall: -l = maintenance database (same backup role by default)
if [[ -n "${BACKUP_GLOBALS_URL:-}" ]]; then
  pgc_parse "$BACKUP_GLOBALS_URL" || { echo "BACKUP_GLOBALS_URL is not parseable" >&2; exit 1; }
  G_ARGS=(-h "$PGC_HOST" -p "$PGC_PORT" -U "$PGC_USER" -l "$PGC_DB")
fi

PASSFILE=""
CLEAN_PASS=0
if [[ -n "${BACKUP_PASSPHRASE_FILE:-}" ]]; then
  [[ -s "$BACKUP_PASSPHRASE_FILE" ]] || { echo "BACKUP_PASSPHRASE_FILE missing/empty" >&2; exit 1; }
  PASSFILE="$BACKUP_PASSPHRASE_FILE"
elif [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
  CLEAN_PASS=1; trap '[[ "$CLEAN_PASS" == 1 ]] && rm -f "$PASSFILE"; pgc_cleanup' EXIT   # armed BEFORE the secret is written; replaced by the full cleanup trap below
  PASSFILE="$(umask 077; mktemp)"
  printf '%s' "$BACKUP_PASSPHRASE" > "$PASSFILE"
else
  echo "set BACKUP_PASSPHRASE_FILE or BACKUP_PASSPHRASE" >&2; exit 1
fi
# o-rwx only (not 700): an admin-granted ACL/group for the monitor (read+traverse the DIR, never the files) must survive; umask 077 makes new dirs 700.
mkdir -p "$BACKUP_DIR"; chmod o-rwx "$BACKUP_DIR"

TS="$(date +%Y%m%d-%H%M%S)"
DUMP="$BACKUP_DIR/velto-db-$TS.dump.gpg"
GLOB="$BACKUP_DIR/velto-globals-$TS.sql.gpg"
cleanup() { [[ "$CLEAN_PASS" == 1 ]] && rm -f "$PASSFILE"; pgc_cleanup; [[ "${OK:-0}" == 1 ]] || rm -f "$DUMP" "$GLOB" "$DUMP.sha256" "$GLOB.sha256"; }
trap cleanup EXIT

# Portable sha256 (Linux sha256sum / macOS shasum). Sidecar uses the bare file name so `sha256sum -c` works from the backup dir.
if command -v sha256sum >/dev/null; then SHA=(sha256sum); else SHA=(shasum -a 256); fi
seal() { local d b; d="$(dirname "$1")"; b="$(basename "$1")"; (cd "$d" && "${SHA[@]}" "$b" > "$b.sha256" && "${SHA[@]}" -c "$b.sha256" >/dev/null) || { echo "[backup] sha256 FAILED for $1" >&2; return 1; }; }

enc() { gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASSFILE" --symmetric --cipher-algo AES256 -o "$1"; }
dec() { gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$PASSFILE" --decrypt "$1"; }

# pg_dump major must equal the server major (a v17 dump does not restore on v16: SET transaction_timeout)
if command -v psql >/dev/null; then
  SRV="$(psql -w -X -tA "${DB_ARGS[@]}" -c 'SHOW server_version_num' 2>/dev/null | tr -d '[:space:]')"
  CLI="$(pg_dump --version | sed -E 's/^[^0-9]*([0-9]+).*/\1/')"
  [[ "$SRV" =~ ^[0-9]+$ ]] || { echo "[backup] cannot read the server version (psql failed)" >&2; exit 1; }
  (( SRV / 10000 == CLI )) || { echo "[backup] pg_dump major $CLI != server major $((SRV / 10000)): install the matching postgresql-client" >&2; exit 1; }
else echo "[backup] psql not found: cannot verify the pg_dump/server major version" >&2; exit 1; fi
echo "[backup] pg_dump -Fc -> $DUMP"
pg_dump -Fc -w "${DB_ARGS[@]}" | enc "$DUMP"
# Verify by streaming (no plaintext on disk): pg_restore -l may stop reading early => drain stdin to avoid SIGPIPE/pipefail on dec.
dec "$DUMP" | { pg_restore -l >/dev/null; rc=$?; cat >/dev/null; exit $rc; } || { echo "[backup] verification FAILED for $DUMP" >&2; exit 1; }
seal "$DUMP"

if [[ "${BACKUP_GLOBALS:-1}" == 1 ]]; then
  echo "[backup] pg_dumpall --globals-only --no-role-passwords -> $GLOB"
  pg_dumpall --globals-only --no-role-passwords -w "${G_ARGS[@]}" | enc "$GLOB"
  # grep -q would close the pipe early (SIGPIPE under pipefail): read everything.
  dec "$GLOB" | grep 'CREATE ROLE' >/dev/null || { echo "[backup] globals verification FAILED" >&2; exit 1; }
  seal "$GLOB"
else
  echo "[backup] WARN: BACKUP_GLOBALS=0 -> globals skipped (roles come from packages/database/scripts/provision-roles.sql)" >&2
  GLOB=""
fi
if [[ -n "${BACKUP_READ_GROUP:-}" ]]; then
  for f in "$DUMP" "$DUMP.sha256" ${GLOB:+"$GLOB" "$GLOB.sha256"}; do chgrp "$BACKUP_READ_GROUP" "$f" && chmod 640 "$f"; done
fi
OK=1

echo "[backup] retention: deleting velto-*.gpg, .gpg.sha256 and velto-set-*.manifest older than $RETENTION days"
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'velto-db-*.gpg' -o -name 'velto-globals-*.gpg' -o -name 'velto-objects-*.gpg' -o -name 'velto-db-*.gpg.sha256' -o -name 'velto-globals-*.gpg.sha256' -o -name 'velto-objects-*.gpg.sha256' -o -name 'velto-set-*.manifest' \) -mtime +"$RETENTION" -print -delete
echo "[backup] OK $(du -h "$DUMP" | cut -f1) $DUMP"
[[ -z "$GLOB" ]] || echo "GLOBALS_FILE=$GLOB"
echo "BACKUP_FILE=$DUMP"  # last line: backup-run.sh parses this (path may contain spaces)
