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
BACKUP_DIR="${VELTO_BACKUP_DIR:-/root}"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

if [[ "${1:-}" == "--pull" ]]; then
  step "git pull"
  git pull --ff-only
fi

step "Loading env"
# Root env holds DATABASE_URL / DATABASE_SYSTEM_URL. The NEXT_PUBLIC_* vars live
# in apps/{web,miniapp}/.env.production.local and are read by `next build` itself.
[[ -f .env.production.local ]] || { echo "missing .env.production.local" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
source .env.production.local
set +a

step "Backing up the database"
# pg_dump must run as velto_system: the app role is subject to FORCE ROW LEVEL
# SECURITY and cannot read AuditLog. Strip the ?schema=... query pg_dump rejects.
BACKUP="$BACKUP_DIR/velto-backup-$(date +%Y%m%d-%H%M%S).sql"
pg_dump "${DATABASE_SYSTEM_URL%%\?*}" -f "$BACKUP"
echo "  -> $BACKUP ($(du -h "$BACKUP" | cut -f1))"

step "Installing dependencies"
pnpm install --frozen-lockfile

step "Generating Prisma client"
pnpm --filter @velto/database exec prisma generate

step "Applying migrations"
pnpm --filter @velto/database exec prisma migrate deploy

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
  echo "Database backup for rollback: $BACKUP" >&2
  exit 1
fi

printf '\n\033[1;32mDeploy OK\033[0m — backup: %s\n' "$BACKUP"
