#!/bin/sh
# docker-entrypoint-initdb.d hook (docker-compose.yml, first init only).
# initdb runs bare .sql files without psql variables, but provision-roles.sql
# requires an explicit velto_env, so this wrapper passes it. Local dev only:
# POSTGRES_DB is velto_dev (the script itself refuses dev on any other name).
set -eu
psql -v ON_ERROR_STOP=1 -v velto_env=dev \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -f /velto-scripts/provision-roles.sql
