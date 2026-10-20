#!/usr/bin/env bash
# Starts apps/api (built dist) against velto_load ONLY on a separate port (default 3011).
# Other settings come from the repo .env (JWT secrets etc.); DB URLs are overridden here.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HP="${LOAD_PG_HOSTPORT:-localhost:5433}"
set -a; . "$ROOT/.env"; set +a
export NODE_ENV=development READ_ONLY_MODE=false API_PORT="${LOAD_API_PORT:-3011}" BULLMQ_PREFIX=velto-load
POOL="${LOAD_POOL:+&connection_limit=$LOAD_POOL}" # unset = Prisma default (num_cpus*2+1)
export DATABASE_URL="postgresql://velto_app:velto_app@$HP/velto_load?schema=public$POOL"
export DATABASE_SYSTEM_URL="postgresql://velto_system:velto_system@$HP/velto_load?schema=public"
export DATABASE_MIGRATE_URL="postgresql://velto_owner:velto_owner@$HP/velto_load?schema=public"
cd "$ROOT/apps/api" && exec node dist/main.js
