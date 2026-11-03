#!/usr/bin/env bash
# Run tests against an isolated, ephemeral Postgres(5435)/Redis(6381) stack (compose project velto-test).
# Usage: scripts/test-isolated.sh [--keep] [-- <turbo test args>]   e.g. -- --filter=@velto/database
# Never touches the dev stack (5433/6380). Refuses to run if pointed at 5433.
set -euo pipefail
cd "$(dirname "$0")/.."

PG_PORT=5435
REDIS_PORT=6381
KEEP=0
if [ "${1:-}" = "--keep" ]; then KEEP=1; shift; fi
if [ "${1:-}" = "--" ]; then shift; fi

if [ "$PG_PORT" = "5433" ] || [[ "${DATABASE_URL:-}${DATABASE_MIGRATE_URL:-}${DATABASE_SYSTEM_URL:-}" == *":5433"* ]]; then
  echo "refusing: port 5433 is the dev database" >&2; exit 1
fi

COMPOSE=(docker compose -p velto-test -f docker-compose.test.yml)
cleanup() { [ "$KEEP" = 1 ] || "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

"${COMPOSE[@]}" up -d --wait

# Superuser provisioning via the container (no host psql needed).
"${COMPOSE[@]}" exec -T postgres psql -U velto -d velto_test -v ON_ERROR_STOP=1 -v velto_env=dev -q -f - \
  < packages/database/scripts/provision-roles.sql >/dev/null

export NODE_ENV=test
export DATABASE_URL="postgresql://velto_app:velto_app@localhost:${PG_PORT}/velto_test?schema=public"
export DATABASE_MIGRATE_URL="postgresql://velto_owner:velto_owner@localhost:${PG_PORT}/velto_test?schema=public"
export DATABASE_SYSTEM_URL="postgresql://velto_system:velto_system@localhost:${PG_PORT}/velto_test?schema=public"
export REDIS_URL="redis://localhost:${REDIS_PORT}"
export JWT_ACCESS_SECRET="test-only-secret-not-for-real-use-min-32-chars"
export MFA_ENCRYPTION_KEY="$(openssl rand -base64 32)"
export SEED_DEMO_PASSWORD="Velto#Test2026"
export S3_ENDPOINT="http://localhost:9000" S3_ACCESS_KEY="velto-test" S3_SECRET_KEY="velto-test-secret" S3_BUCKET="velto-test"
export CORS_ORIGINS="http://localhost:3000,http://localhost:3002"
export BULLMQ_PREFIX="bull-test"

pnpm --filter @velto/database run generate
pnpm --filter @velto/database exec prisma migrate deploy
pnpm --filter @velto/database run build

# Workspaces run one at a time; per-workspace vitest settings are unchanged.
pnpm exec turbo run test --concurrency=1 "$@"
