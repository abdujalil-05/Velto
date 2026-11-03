#!/usr/bin/env bash
# Reproduce .github/workflows/ci.yml locally, in CI order, stopping at the first failure:
#   install -> prisma generate -> provision-roles -> migrate deploy -> lint -> typecheck -> test -> audit --prod -> build
#   (+ gitleaks full history / semgrep when installed; skipped with a notice otherwise)
# Uses the docker-compose Postgres (5433) / Redis (6380) but a DEDICATED database (default velto_ci_local):
# it never runs `migrate reset`, never drops anything and never touches velto_dev.
# Env: CI_LOCAL_DB (must start with velto_ci), CI_LOCAL_HOST/PORT (5433), CI_LOCAL_ADMIN_USER/PASSWORD (velto/velto),
#      CI_LOCAL_REDIS_URL (redis://localhost:6380), SKIP_SCANS=1.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"

DB="${CI_LOCAL_DB:-velto_ci_local}"; HOST="${CI_LOCAL_HOST:-localhost}"; PORT="${CI_LOCAL_PORT:-5433}"
[[ "$DB" == velto_ci* && "$DB" =~ ^[a-z0-9_]+$ ]] || { echo "refusing: CI_LOCAL_DB must match velto_ci[a-z0-9_]* (never velto_dev)" >&2; exit 1; }
case "$HOST" in localhost|127.0.0.1) ;; *) echo "refusing non-local CI_LOCAL_HOST" >&2; exit 1;; esac
AU="${CI_LOCAL_ADMIN_USER:-velto}"; AP="${CI_LOCAL_ADMIN_PASSWORD:-velto}"

export VELTO_TEST_DB_ALLOW="$DB" # test guard (scripts/assert-test-db.mjs): approves this dedicated DB on 5433
export DATABASE_ADMIN_URL="postgresql://$AU:$AP@$HOST:$PORT/$DB"
export DATABASE_URL="postgresql://velto_app:velto_app@$HOST:$PORT/$DB?schema=public"
export DATABASE_MIGRATE_URL="postgresql://velto_owner:velto_owner@$HOST:$PORT/$DB?schema=public"
export DATABASE_SYSTEM_URL="postgresql://velto_system:velto_system@$HOST:$PORT/$DB?schema=public"
export REDIS_URL="${CI_LOCAL_REDIS_URL:-redis://localhost:6380}"
# Same placeholders as ci.yml (non-secret, test-only)
export JWT_ACCESS_SECRET="ci-only-secret-not-for-real-use-min-32-chars" SEED_DEMO_PASSWORD="Velto#CI2026"
export S3_ENDPOINT="http://localhost:9000" S3_ACCESS_KEY="velto-ci" S3_SECRET_KEY="velto-ci-secret" S3_BUCKET="velto-ci"
export CORS_ORIGINS="http://localhost:3000,http://localhost:3002" CI=true

step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
trap 'echo "ci-local FAILED at step: ${CUR:-?}" >&2' ERR
run() { CUR="$1"; step "$1"; shift; "$@"; }

command -v psql >/dev/null || { echo "psql required" >&2; exit 1; }
CUR="ensure database $DB"; step "$CUR"
psql "postgresql://$AU:$AP@$HOST:$PORT/postgres" -X -Atq -v ON_ERROR_STOP=1 -c "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 \
  || psql "postgresql://$AU:$AP@$HOST:$PORT/postgres" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB\""

run "install"            pnpm install --frozen-lockfile
run "prisma generate"    pnpm --filter @velto/database run generate
# velto_env: default DB velto_ci_local has no dev suffix -> production (same as the former autodetect);
# override with CI_LOCAL_VELTO_ENV=dev when CI_LOCAL_DB ends in _dev/_ci/_test/_load.
run "provision roles"    psql "$DATABASE_ADMIN_URL" -X -v ON_ERROR_STOP=1 -v velto_env="${CI_LOCAL_VELTO_ENV:-production}" -q -f packages/database/scripts/provision-roles.sql
run "migrate deploy"     pnpm --filter @velto/database exec prisma migrate deploy
run "lint"               pnpm run lint
run "typecheck"          pnpm run typecheck
run "test"               pnpm run test
run "audit --prod (high+critical, blocking)" pnpm audit --prod --audit-level=high
run "build"              pnpm run build

if [[ "${SKIP_SCANS:-0}" != 1 ]]; then
  if command -v gitleaks >/dev/null; then run "gitleaks (full history)" gitleaks detect --source . --config .gitleaks.toml --log-opts="--all" --redact --exit-code 1
  else echo "NOTICE: gitleaks not installed - secret scan skipped (CI still runs it)"; fi
  if command -v semgrep >/dev/null; then run "semgrep" semgrep scan --config p/owasp-top-ten --config p/security-audit --config p/typescript --config p/nodejsscan --severity ERROR --error
  else echo "NOTICE: semgrep not installed - SAST skipped (CI still runs it)"; fi
fi
printf '\n\033[1;32mci-local OK\033[0m (db: %s)\n' "$DB"
