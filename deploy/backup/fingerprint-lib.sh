#!/usr/bin/env bash
# Sourced library (backup.sh writes it, restore-drill.sh re-computes and compares it): FINANCIAL FINGERPRINT of a database snapshot (R4).
# Per table one line  Name|count|sums|sha256  where
#   count = number of rows, sums = comma-separated sum() of the money/qty columns below (or '-'),
#   sha256 = hash over the CANONICAL ordered rows: rows are bucketed by the first 2 hex chars of "id", each bucket = sha256(rows::text joined by \n ORDER BY id),
#   the table hash = sha256(bucket hashes ordered by bucket). Bucketing only bounds memory (no 1 GB string_agg limit); the result is order-canonical.
# The text form of a row is made deterministic by pinning DateStyle/TimeZone/extra_float_digits/bytea_output/IntervalStyle inside the transaction.
# Tables (real Prisma model names, packages/database/prisma/schema.prisma). There are NO separate ledger / FIFO-layer tables: the ledger is Invoice + Payment +
# PaymentAllocation (+ PaymentReversal, PaymentIntentResolution), the FIFO payment->invoice allocation is PaymentAllocation; stock truth is StockMovement
# (+ GoodsReceiptLine unitCost); AuditLog is append-only. StockLevel has no "id" (composite key) and is a projection of StockMovement: checked by the drill, not hashed here.
# Logs print only the table name + MATCH/MISMATCH. The fingerprint FILE holds sums = financial data: it exists only gpg-encrypted (backup.sh pipes psql into gpg).
FP_TABLES=(
  "Invoice:total" "InvoiceLine:lineTotal,qty" "Payment:amount" "PaymentAllocation:amount" "PaymentReversal:" "PaymentIntentResolution:"
  "StockMovement:qty" "GoodsReceiptLine:qty,unitCost" "Customer:cachedBalance" "AuditLog:"
)

# fp_sql: the SQL (statements only; the caller supplies BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY and the end of the transaction).
fp_sql() {
  local spec n cols c sums
  echo "SET LOCAL DateStyle='ISO, YMD'; SET LOCAL TimeZone='UTC'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'; SET LOCAL IntervalStyle='postgres';"
  for spec in "${FP_TABLES[@]}"; do
    n="${spec%%:*}"; cols="${spec#*:}"; sums="'-'"
    if [[ -n "$cols" ]]; then
      sums=""; for c in ${cols//,/ }; do sums+="${sums:+, }COALESCE(sum(\"$c\"),0)::text"; done; sums="concat_ws(',', $sums)"
    fi
    echo "SELECT '$n|'||a.c||'|'||a.s||'|'||COALESCE(b.h,'-') FROM (SELECT count(*) c, $sums s FROM \"$n\") a, (SELECT encode(sha256(convert_to(string_agg(q.h,'' ORDER BY q.k),'UTF8')),'hex') h FROM (SELECT left(t.id::text,2) k, encode(sha256(convert_to(string_agg(t::text, E'\\n' ORDER BY t.id),'UTF8')),'hex') h FROM \"$n\" t GROUP BY 1) q) b;"
  done
}

# fp_compute <psql args...>: fingerprint of the CURRENT state of a database in one REPEATABLE READ transaction (restore side). Lines on stdout.
fp_compute() {
  { echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"; fp_sql; echo "ROLLBACK;"; } | psql -X -Atq -v ON_ERROR_STOP=1 "$@"
}

# fp_snap_open <workdir> <encrypt-command-string> <psql args...>: starts ONE background psql that exports a snapshot (FP_SNAP_ID), computes the fingerprint IN THAT
# SAME SNAPSHOT piped straight into <encrypt-command-string> (no plaintext on disk), and keeps the transaction open until fp_snap_close. The caller runs
# pg_dump --snapshot="$FP_SNAP_ID" meanwhile, so dump and fingerprint describe the same instant. Workdir: private (0700) dir without quotes in its path.
FP_SNAP_PID=""; FP_SNAP_ID=""; FP_SNAP_DIR=""
fp_snap_open() {
  local w="$1" enc="$2" i; shift 2
  [[ "$w" != *"'"* && "$enc" != *$'\n'* ]] || { echo "[fingerprint] unsafe path" >&2; return 1; }
  FP_SNAP_DIR="$w"; rm -f "$w"/snap.* "$w/fp.ready"
  {
    echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
    echo "\\o '$w/snap.id'"; echo "SELECT pg_export_snapshot();"; echo "\\o"
    echo "\\! touch '$w/snap.ready'"
    echo "\\o | $enc"; fp_sql; echo "\\o"
    echo "\\! touch '$w/fp.ready'"
    # bounded wait: ends on snap.done, when the owning backup process ($$) is gone (no orphan holding a REPEATABLE READ txn) or after FP_SNAP_MAX_SECONDS
    echo "\\! n=0; while [ ! -f '$w/snap.done' ] && kill -0 $$ 2>/dev/null && [ \$n -lt ${FP_SNAP_MAX_SECONDS:-7200} ]; do sleep 1; n=\$((n+1)); done"
    echo "ROLLBACK;"
  } > "$w/snap.sql"
  psql -X -Atq -v ON_ERROR_STOP=1 "$@" -f "$w/snap.sql" 2> "$w/snap.err" 9>&- &   # fd 9 = backup-run's flock: the holder must never inherit (and so never keep) it
  FP_SNAP_PID=$!
  for i in $(seq 1 200); do
    [[ -f "$w/snap.ready" ]] && break
    kill -0 "$FP_SNAP_PID" 2>/dev/null || break
    sleep 0.3; : "$i"
  done
  [[ -f "$w/snap.ready" && -s "$w/snap.id" ]] || { echo "[fingerprint] snapshot session failed" >&2; fp_snap_abort; return 1; }
  FP_SNAP_ID="$(tr -d '[:space:]' < "$w/snap.id")"; export FP_SNAP_ID
}
# fp_snap_close: call after pg_dump finished. 0 only if the fingerprint was computed and the session ended cleanly.
fp_snap_close() {
  local rc=1
  [[ -n "$FP_SNAP_PID" ]] || return 1
  touch "$FP_SNAP_DIR/snap.done"; wait "$FP_SNAP_PID"; rc=$?; FP_SNAP_PID=""
  [[ $rc -eq 0 && -f "$FP_SNAP_DIR/fp.ready" ]]
}
fp_snap_abort() { [[ -n "$FP_SNAP_PID" ]] || return 0; touch "$FP_SNAP_DIR/snap.done"; kill "$FP_SNAP_PID" 2>/dev/null; wait "$FP_SNAP_PID" 2>/dev/null; FP_SNAP_PID=""; return 0; }

# fp_compare <expected-file> <actual-file>: prints "<table>=MATCH|MISMATCH" per expected table (never a value); rc 0 only if every table matches and both sides
# have the same table set. A table missing on either side is MISMATCH.
fp_compare() {
  local exp="$1" act="$2" line n rc=0 a
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    n="${line%%|*}"; a="$(grep -F -x -e "$line" "$act" || true)"
    if [[ -n "$a" ]]; then printf '%s=MATCH ' "$n"; else printf '%s=MISMATCH ' "$n"; rc=1; fi
  done < "$exp"
  while IFS= read -r line; do
    n="${line%%|*}"; grep -q -e "^$n|" "$exp" || { printf '%s=MISMATCH ' "$n"; rc=1; }
  done < "$act"
  [[ -s "$exp" && -s "$act" ]] || rc=1
  echo; return $rc
}

# fp_check_shape (stdin): every FP_TABLES entry present exactly once with a well-formed line, nothing else (checked right after the backup wrote it, and by the drill).
fp_check_shape() {
  local spec n txt; txt="$(cat)"
  for spec in "${FP_TABLES[@]}"; do
    n="${spec%%:*}"
    [[ "$(grep -c -E "^$n\|[0-9]+\|[^|]+\|([0-9a-f]{64}|-)\$" <<<"$txt")" == 1 ]] || return 1
  done
  [[ "$(grep -c . <<<"$txt")" == "${#FP_TABLES[@]}" ]]
}
