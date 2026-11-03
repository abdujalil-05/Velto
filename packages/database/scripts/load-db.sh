#!/usr/bin/env bash
# Local load-test database (TZ §12.5) — a SEPARATE database `velto_load` on
# the docker Postgres (localhost:5433). Never touches velto_dev: every
# command targets velto_load only, and `seed` proves velto_dev row counts are
# identical before and after.
#
#   bash packages/database/scripts/load-db.sh create   # CREATE DATABASE + provision-roles.sql + prisma migrate deploy
#   bash packages/database/scripts/load-db.sh reset    # DROP DATABASE velto_load (FORCE) + create
#   bash packages/database/scripts/load-db.sh seed [seed-load args]   # snapshot dev → seed-load.ts → snapshot dev → diff
#   bash packages/database/scripts/load-db.sh verify   # verify-integrity.sql against velto_load (0 rows = clean)
#
# Env (local defaults): LOAD_PG_HOSTPORT=localhost:5433, LOAD_PG_SUPERUSER=velto:velto
# (the docker bootstrap superuser — only for CREATE/DROP DATABASE, role
# provisioning and the read-only count snapshots).
set -euo pipefail

DB=velto_load
DEV_DB=velto_dev
HOSTPORT="${LOAD_PG_HOSTPORT:-localhost:5433}"
SUPER="${LOAD_PG_SUPERUSER:-velto:velto}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"

admin_url() { echo "postgresql://${SUPER}@${HOSTPORT}/$1"; }
export DATABASE_LOAD_URL="postgresql://velto_app:velto_app@${HOSTPORT}/${DB}?schema=public"
export DATABASE_LOAD_SYSTEM_URL="postgresql://velto_system:velto_system@${HOSTPORT}/${DB}?schema=public"
LOAD_MIGRATE_URL="postgresql://velto_owner:velto_owner@${HOSTPORT}/${DB}?schema=public"

[ "$DB" = "velto_load" ] || { echo "refusing: target must be velto_load" >&2; exit 1; }
[ "${NODE_ENV:-}" != "production" ] || { echo "refusing: NODE_ENV=production" >&2; exit 1; }

create() {
  if [ "$(psql "$(admin_url postgres)" -Atc "SELECT 1 FROM pg_database WHERE datname = '$DB'")" != "1" ]; then
    psql "$(admin_url postgres)" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE $DB"
  fi
  psql "$(admin_url $DB)" -v ON_ERROR_STOP=1 -q -f "$HERE/provision-roles.sql"
  # Explicit env wins over .env: migrations run as velto_owner against velto_load only.
  (cd "$PKG" && DATABASE_URL="$DATABASE_LOAD_URL" DATABASE_MIGRATE_URL="$LOAD_MIGRATE_URL" \
    pnpm exec prisma migrate deploy | tail -n 3)
  # Grants for tables created by migrate deploy are covered by provision-roles' default privileges.
}

reset() {
  psql "$(admin_url postgres)" -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)"
  create
}

# Exact per-table row counts (superuser → RLS bypassed, read-only).
counts() {
  psql "$(admin_url "$1")" -At -v ON_ERROR_STOP=1 -c "
    SELECT c.relname || '=' || (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname"
}

# Rows that only seed-load.ts creates (tenant slug "load*", LSKU-/LC- codes).
markers() {
  psql "$(admin_url "$1")" -At -v ON_ERROR_STOP=1 -c "
    SELECT (SELECT count(*) FROM \"Tenant\" WHERE slug LIKE 'load%')
         + (SELECT count(*) FROM \"Product\" WHERE sku LIKE 'LSKU-%')
         + (SELECT count(*) FROM \"Customer\" WHERE code LIKE 'LC-%')"
}

seed() {
  local before after
  before="$(counts "$DEV_DB")"
  (cd "$PKG" && pnpm exec tsx src/seed-load.ts "$@")
  after="$(counts "$DEV_DB")"
  if [ "$(markers "$DEV_DB")" != "0" ]; then
    echo "velto_dev CONTAINS load-seed rows — isolation broken" >&2; exit 1
  fi
  if [ "$before" = "$after" ]; then
    echo "velto_dev unchanged: $(echo "$before" | wc -l | tr -d ' ') tables, identical row counts before/after; 0 load-seed marker rows"
  else
    # Other processes (API, test suites) may write velto_dev concurrently;
    # counts then differ for reasons unrelated to this seed. Not a proof — say so.
    echo "WARNING: velto_dev row counts changed during the run (concurrent writers?) — count proof NOT established; 0 load-seed marker rows in velto_dev" >&2
    diff <(echo "$before") <(echo "$after") | head -n 20 >&2 || true
    exit 3
  fi
}

verify() {
  local out
  out="$(psql "$(admin_url $DB)" -At -F' | ' -v ON_ERROR_STOP=1 -f "$HERE/verify-integrity.sql")"
  if [ -z "$out" ]; then echo "verify-integrity: 0 findings (clean)"; else echo "$out" | head -n 50; echo "findings: $(echo "$out" | wc -l | tr -d ' ')"; exit 1; fi
}

cmd="${1:-}"; shift || true
case "$cmd" in
  create) create ;;
  reset) reset ;;
  seed) seed "$@" ;;
  verify) verify ;;
  counts) counts "${1:-$DB}" ;;
  *) echo "usage: load-db.sh {create|reset|seed [args]|verify|counts [db]}" >&2; exit 2 ;;
esac
