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
#
# Runs as the RELEASE user (velto-deploy in the split-user layout, deploy/system/). It never sees the backup passphrase or backup/offsite keys:
# before install/migrate it requires a fresh, root-attested, verified backup (deploy/backup/verify-backup-status.sh) and aborts otherwise.
# It NEVER restores anything automatically.
#   VELTO_BACKUP_MAX_AGE_MIN (60) | VELTO_DEPLOY_TRIGGER_BACKUP (1: `sudo -n systemctl start velto-backup.service` first; 0: only check)
#   VELTO_REQUIRE_OBJECTS (1) | VELTO_REQUIRE_OFFSITE (0) | VELTO_BACKUP_STATUS_FILE | VELTO_BACKUP_DIR   (see verify-backup-status.sh)
#   VELTO_MIGRATE_ENV_FILE (/etc/velto/migrate.env): if present -> split mode, only DATABASE_MIGRATE_URL is read from it; the runtime env is NOT read.
#   VELTO_PM2_RUN_AS (e.g. velto): run pm2 as that user via the narrow sudoers rule; unset = legacy (pm2 of the current user).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PM2_APPS=(velto-api velto-web velto-miniapp)
PM2_RUN_AS="${VELTO_PM2_RUN_AS:-}"
MIGRATE_ENV_FILE="${VELTO_MIGRATE_ENV_FILE:-/etc/velto/migrate.env}"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31mDEPLOY ABORTED: %s\033[0m\n' "$1" >&2; exit 1; }

if [[ "${1:-}" == "--pull" ]]; then
  step "git pull"
  git pull --ff-only
fi

step "Loading env"
# ONE parsing rule for deploy.sh and ecosystem.config.js: deploy/env-file.js (no inline comments, no shell expansion).
if [[ -f "$MIGRATE_ENV_FILE" ]]; then
  # Split-user layout: this user reads only the migrate credentials here. NOTE: velto-deploy owns the checkout (ecosystem.config.js runs as velto), so it is trusted with
  # the runtime secrets too (app.env); it is NOT trusted with backup secrets. See deploy/README.md "Residual risks".
  ENV_OUT="$(node "$ROOT/deploy/env-file.js" export "$MIGRATE_ENV_FILE" DATABASE_MIGRATE_URL)" || die "cannot read $MIGRATE_ENV_FILE"
  eval "$ENV_OUT"
  : "${DATABASE_MIGRATE_URL:?DATABASE_MIGRATE_URL missing in $MIGRATE_ENV_FILE}"
  # schema.prisma declares url=env("DATABASE_URL") (must resolve) and directUrl=DATABASE_MIGRATE_URL (used by migrate). Point url at the owner URL for the CLI only.
  export DATABASE_URL="$DATABASE_MIGRATE_URL"
  [[ "$DATABASE_MIGRATE_URL" != *"//velto_app:"* && "$DATABASE_MIGRATE_URL" != *"//velto_system:"* ]] || die "DATABASE_MIGRATE_URL must be the schema-owner role, not velto_app/velto_system"
else
  # Legacy single-user layout: root env holds everything; NEXT_PUBLIC_* live in apps/{web,miniapp}/.env.production.local (read by `next build` itself).
  [[ -f .env.production.local ]] || die "missing .env.production.local (or $MIGRATE_ENV_FILE)"
  ENV_OUT="$(node "$ROOT/deploy/env-file.js" export .env.production.local)" || die "cannot parse .env.production.local"
  eval "$ENV_OUT"
  : "${DATABASE_MIGRATE_URL:?DATABASE_MIGRATE_URL (schema-owner role) is required for prisma migrate deploy}"
  [[ "$DATABASE_MIGRATE_URL" != "${DATABASE_URL:-}" ]] || die "DATABASE_MIGRATE_URL must differ from DATABASE_URL (owner vs app role)"
fi

step "Backup gate (fresh, root-attested, verified; no passphrase here)"
# Anything wrong here stops the deploy BEFORE install/migrate. No automatic restore, no bypass flag.
GATE_ARGS=(); [[ "${VELTO_DEPLOY_TRIGGER_BACKUP:-1}" == 0 ]] || GATE_ARGS=(--trigger)
GATE_OUT="$(bash "$ROOT/deploy/backup/verify-backup-status.sh" ${GATE_ARGS[@]+"${GATE_ARGS[@]}"})" || die "no valid backup attestation - nothing was installed, migrated or restarted (see the [backup-gate] lines above). Fix the backup service, then re-run."
echo "$GATE_OUT" | grep '^\[backup-gate\]'
BACKUP="$(grep '^VBS_DB_ARCHIVE=' <<<"$GATE_OUT" | cut -d= -f2-)"
[[ -n "$BACKUP" ]] || die "gate returned no archive name"

step "Installing dependencies"
pnpm install --frozen-lockfile

step "Generating Prisma client"
pnpm --filter @velto/database exec prisma generate

step "Applying migrations"
pnpm --filter @velto/database exec prisma migrate deploy
# Owner credentials must not leak into the API process via `pm2 --update-env`.
unset DATABASE_MIGRATE_URL DATABASE_ADMIN_URL
[[ ! -f "$MIGRATE_ENV_FILE" ]] || unset DATABASE_URL

step "Building"
pnpm build

step "Restarting services"
if [[ -n "$PM2_RUN_AS" ]]; then
  # The runtime process is owned by another unprivileged user: ONE narrow sudoers rule per command (deploy/system/velto-deploy.sudoers), exact arguments.
  sudo -n -u "$PM2_RUN_AS" /usr/bin/pm2 startOrReload "$ROOT/deploy/ecosystem.config.js" --update-env
  sudo -n -u "$PM2_RUN_AS" /usr/bin/pm2 save --force >/dev/null
else
  pm2 restart "${PM2_APPS[@]}" --update-env
  pm2 save --force >/dev/null
fi

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
  echo "Smoke test failed. Nothing was restored automatically." >&2
  if [[ -n "$PM2_RUN_AS" ]]; then echo "Errors: sudo -u $PM2_RUN_AS pm2 logs --err --lines 30 --nostream  (as an admin)" >&2
  else pm2 logs "${PM2_APPS[@]}" --err --lines 20 --nostream 2>&1 | tail -30 >&2; fi
  echo
  echo "Verified pre-deploy backup (root-owned, encrypted): $BACKUP in ${VELTO_BACKUP_DIR:-/var/backups/velto}" >&2
  echo "Rollback is a separate, approved, root-run action - this user has no passphrase. Restore only into a SEPARATE database (never over prod):" >&2
  echo "  see docs/release/BACKUP-RESTORE-RUNBOOK.md (restore order: globals -> role passwords -> provision-roles.sql -> pg_restore)." >&2
  echo "  Code rollback (no DB change): git checkout <previous tag> && ./deploy/deploy.sh   (migrations are forward-only: DB rollback needs the restore above)." >&2
  exit 1
fi

printf '\n\033[1;32mDeploy OK\033[0m - pre-deploy backup attested: %s\n' "$BACKUP"
