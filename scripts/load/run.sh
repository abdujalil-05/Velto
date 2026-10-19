#!/usr/bin/env bash
# One load run: bash scripts/load/run.sh <label> <MODE> <VUS> <DURATION>   (needs LOAD_PASSWORD env, API on :3011)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
L="$1"; M="$2"; V="$3"; D="$4"
mkdir -p "$HERE/results"
docker run --rm -e LOAD_PASSWORD -e MODE="$M" -e VUS="$V" -e DURATION="$D" ${EXTRA_ENV:-} -v "$HERE:/work" grafana/k6:1.3.0 \
  run --quiet --no-color --out "json=/work/results/$L.json" /work/velto-load.js > "$HERE/results/$L.txt" 2>&1 || true
node "$HERE/summarize.js" "$HERE/results/$L.json" | tee "$HERE/results/$L.md"
