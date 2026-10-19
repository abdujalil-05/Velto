#!/usr/bin/env bash
# Restarts the load API (fresh process => cold caches/pool) and waits for /health/live.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lsof -ti ":${LOAD_API_PORT:-3011}" | xargs kill 2>/dev/null || true; sleep 2
(nohup bash "$HERE/start-api.sh" > "${LOAD_API_LOG:-/dev/null}" 2>&1 &)
until curl -sf "localhost:${LOAD_API_PORT:-3011}/health/live" >/dev/null; do sleep 1; done
