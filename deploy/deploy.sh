#!/usr/bin/env bash
#
# Velto — production deploy.
#
#   ./deploy/deploy.sh          # deploy the current working tree
#   ./deploy/deploy.sh --pull   # git pull first, then deploy
#
# Why this script exists: a bare `git pull` updates the source but leaves the
# server running the OLD Prisma client and the OLD Next.js builds. That is what
# broke production on 2026-08-11 — four migrations sat unapplied and the API
# threw `Unknown field 'courier' on model 'Route'` on every /routes request,
# while apps/miniapp had no .next directory at all.
#
# Safe to re-run. Touches only the three velto-* pm2 processes; other apps on
# this host (marketco, auto-message) are never restarted.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PM2_APPS=(velto-api velto-web velto-miniapp)
BACKUP_DIR="${VELTO_BACKUP_DIR:-/var/backups/velto}"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

if [[ "${1:-}" == "--pull" ]]; then
  step "git pull"
  git pull --ff-only
fi

step "Loading env"
# Root env holds DATABASE_URL (velto_app, runtime), DATABASE_SYSTEM_URL (BYPASSRLS)
# and DATABASE_MIGRATE_URL (schema owner, used ONLY by `prisma migrate deploy`). The NEXT_PUBLIC_* vars live
# in apps/{web,miniapp}/.env.production.local and are read by `next build` itself.
[[ -f .env.production.local ]] || { echo "missing .env.production.local" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
source .env.production.local
set +a
: "${DATABASE_MIGRATE_URL:?DATABASE_MIGRATE_URL (schema-owner role) is required for prisma migrate deploy}"
[[ "$DATABASE_MIGRATE_URL" != "$DATABASE_URL" ]] || { echo "DATABASE_MIGRATE_URL must differ from DATABASE_URL (owner vs app role)" >&2; exit 1; }

step "Backing up the database (encrypted, verified)"
# Delegates to deploy/backup/backup.sh: pg_dump -Fc as velto_system -> gpg AES256 -> verified + .sha256.
# Needs BACKUP_PASSPHRASE_FILE in the deploy shell's environment: a root-only file OUTSIDE the repo
# (e.g. /etc/velto/backup.pass, chmod 600). Do NOT put it in .env.production.local (ecosystem.config.js feeds that to PM2 apps). A failed
# backup aborts the deploy BEFORE install/migrate (set -e + pipefail).
[[ -n "${BACKUP_PASSPHRASE_FILE:-}" ]] || { echo "set BACKUP_PASSPHRASE_FILE (root-only file outside the repo, e.g. /etc/velto/backup.pass): plaintext backups are no longer written" >&2; exit 1; }
unset BACKUP_PASSPHRASE
export BACKUP_DIR
BACKUP_LOG="$(mktemp)"
cleanup_backup_log() { rm -f "$BACKUP_LOG"; }
trap_prev="$(trap -p EXIT | sed -E "s/^trap -- '(.*)' EXIT$/\1/")"
trap "${trap_prev:+$trap_prev; }cleanup_backup_log" EXIT
bash "$ROOT/deploy/backup/backup.sh" | tee "$BACKUP_LOG"
BACKUP="$(grep '^BACKUP_FILE=' "$BACKUP_LOG" | tail -n1)"; BACKUP="${BACKUP#BACKUP_FILE=}"
[[ -s "$BACKUP" ]] || { echo "backup file not found after backup.sh: '$BACKUP'" >&2; exit 1; }
echo "  -> $BACKUP (+ .sha256)"

step "Installing dependencies"
pnpm install --frozen-lockfile

step "Generating Prisma client"
pnpm --filter @velto/database exec prisma generate

step "Applying migrations"
pnpm --filter @velto/database exec prisma migrate deploy
# Owner credentials must not leak into the API process via `pm2 --update-env`.
unset DATABASE_MIGRATE_URL DATABASE_ADMIN_URL

step "Building"
pnpm build

step "Restarting services"
pm2 restart "${PM2_APPS[@]}" --update-env
pm2 save --force >/dev/null

step "Smoke test"
# pm2 reports "online" the moment the process spawns, so give Next/Nest a moment
# to bind their ports before calling anything a failure.
sleep 10
FAILED=0
check() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$1" || echo 000)
  if [[ "$code" == "$2" ]]; then
    printf '  \033[32mok\033[0m   %s (%s)\n' "$1" "$code"
  else
    printf '  \033[31mFAIL\033[0m %s (got %s, want %s)\n' "$1" "$code" "$2"
    FAILED=1
  fi
}
check "http://127.0.0.1:3101/health" 200
check "http://127.0.0.1:3100/velto/uz/login" 200
check "http://127.0.0.1:3102/velto/app/uz" 200

if [[ $FAILED -ne 0 ]]; then
  echo
  echo "Smoke test failed — recent errors:" >&2
  pm2 logs "${PM2_APPS[@]}" --err --lines 20 --nostream 2>&1 | tail -30 >&2
  echo
  echo "Encrypted DB backup for rollback: $BACKUP" >&2
  echo "Restore into a SEPARATE database (never over prod):" >&2
  echo "  createdb velto_restore   # then: export PGPASSFILE=<0600 pgpass> PGHOST=<host> PGUSER=<owner> (no password in URL/argv)" >&2
  echo "  gpg --batch --pinentry-mode loopback --passphrase-file \"\$BACKUP_PASSPHRASE_FILE\" --decrypt \"$BACKUP\" | pg_restore --no-owner -d velto_restore" >&2
  echo "  Note: switching prod to the restored DB is a manual, separately approved step." >&2
  echo "  (verify first: cd \"$(dirname "$BACKUP")\" && sha256sum -c \"$(basename "$BACKUP").sha256\")" >&2
  exit 1
fi

printf '\n\033[1;32mDeploy OK\033[0m — encrypted backup: %s\n' "$BACKUP"
