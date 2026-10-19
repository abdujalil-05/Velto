#!/usr/bin/env bash
# Velto restore drill (TZ 12.2, 16.5 "Operations"): restore a dump into a SEPARATE database and prove it is sound.
# NEVER touches the source DB (read-only dump) and refuses to drop anything not named velto_restore_drill*.
# Run on a local/staging Postgres, never production.
#
# Env (defaults = local docker-compose dev sample credentials):
#   DUMP_FILE              existing velto-db-*.dump or *.dump.gpg (needs BACKUP_PASSPHRASE_FILE). If unset: fresh pg_dump -Fc of SOURCE_URL.
#   BACKUP_PASSPHRASE_FILE passphrase file for .gpg dumps
#   SOURCE_URL             velto_system URL of the source DB (table-count comparison); default velto_dev on localhost:5433
#   DRILL_HOST/DRILL_PORT  default localhost / 5433 (non-local host requires DRILL_ALLOW_REMOTE=1)
#   DRILL_ADMIN_USER/DRILL_ADMIN_PASSWORD  superuser creating the drill DB (default velto/velto)
#   DRILL_DB               default velto_restore_drill (must start with velto_restore_drill)
#   DRILL_REPORT_DIR       default <repo>/docs/ops
#   DRILL_KEEP_DB=1        keep the drill DB afterwards (default: dropped)
# Exit 0 = all checks PASS; 1 = any FAIL.
set -Euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOST="${DRILL_HOST:-localhost}"; PORT="${DRILL_PORT:-5433}"
ADMIN_USER="${DRILL_ADMIN_USER:-velto}"; ADMIN_PW="${DRILL_ADMIN_PASSWORD:-velto}"
DB="${DRILL_DB:-velto_restore_drill}"
SOURCE_URL="${SOURCE_URL:-postgresql://velto_system:velto_system@localhost:5433/velto_dev}"
REPORT_DIR="${DRILL_REPORT_DIR:-$ROOT/docs/ops}"
[[ "$DB" == velto_restore_drill* ]] || { echo "refusing: DRILL_DB must start with velto_restore_drill" >&2; exit 1; }
[[ "$DB" =~ ^[a-z0-9_]+$ ]] || { echo "invalid DRILL_DB" >&2; exit 1; }
case "$HOST" in localhost|127.0.0.1|::1) ;; *) [[ "${DRILL_ALLOW_REMOTE:-0}" == 1 ]] || { echo "refusing non-local DRILL_HOST without DRILL_ALLOW_REMOTE=1" >&2; exit 1; } ;; esac
SRC="${SOURCE_URL%%\?*}"
ADMIN_URL="postgresql://$ADMIN_USER:$ADMIN_PW@$HOST:$PORT/postgres"
DRILL_ADMIN="postgresql://$ADMIN_USER:$ADMIN_PW@$HOST:$PORT/$DB"
DRILL_SYS="postgresql://velto_system:${DRILL_SYSTEM_PASSWORD:-velto_system}@$HOST:$PORT/$DB"
DRILL_APP="postgresql://velto_app:${DRILL_APP_PASSWORD:-velto_app}@$HOST:$PORT/$DB"
DRILL_OWNER="postgresql://velto_owner:${DRILL_OWNER_PASSWORD:-velto_owner}@$HOST:$PORT/$DB?schema=public"
for c in psql pg_dump pg_restore; do command -v $c >/dev/null || { echo "$c not found" >&2; exit 1; }; done

TMP="$(mktemp -d)"; chmod 700 "$TMP"
RESULTS=(); FAILS=0
q() { psql "$1" -X -v ON_ERROR_STOP=1 -Atq -c "$2"; }
rec() { # name status detail
  RESULTS+=("| $1 | $2 | $3 |"); [[ "$2" == PASS ]] || FAILS=$((FAILS+1)); printf '[drill] %-4s %s %s\n' "$2" "$1" "$3"
}
now() { date +%s; }
drop_db() { q "$ADMIN_URL" "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null 2>&1; }
cleanup() { [[ "${DRILL_KEEP_DB:-0}" == 1 ]] || drop_db; rm -rf "$TMP"; }
trap cleanup EXIT

T0=$(now); START_ISO="$(date -u +%FT%TZ)"
# 1. dump
DUMP="${DUMP_FILE:-}"
AUDIT_SQL="SELECT count(*)||'|'||count(DISTINCT id)||'|'||COALESCE(min(\"createdAt\")::text,'-')||'|'||COALESCE(max(\"createdAt\")::text,'-') FROM \"AuditLog\""
CNT_SQL="SELECT c.relname||'='||(xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname<>'_prisma_migrations' ORDER BY 1"
STOCK_SQL="WITH m AS (SELECT \"productId\",\"warehouseId\",
     COALESCE(SUM(CASE WHEN \"type\" IN ('RECEIVE','ADJUST') THEN \"qty\" WHEN \"type\"='ISSUE' THEN -\"qty\" ELSE 0 END),0) AS oh,
     COALESCE(SUM(CASE WHEN \"type\"='RESERVE' THEN \"qty\" WHEN \"type\" IN ('RELEASE','ISSUE') THEN -\"qty\" ELSE 0 END),0) AS rs
   FROM \"StockMovement\" GROUP BY 1,2)
 SELECT count(*) FILTER (WHERE COALESCE(l.\"onHand\",0)<>COALESCE(m.oh,0) OR COALESCE(l.reserved,0)<>COALESCE(m.rs,0)) || '/' || count(*)
 FROM \"StockLevel\" l FULL JOIN m ON m.\"productId\"=l.\"productId\" AND m.\"warehouseId\"=l.\"warehouseId\""
if [[ -z "$DUMP" ]]; then
  # One REPEATABLE READ snapshot shared by pg_dump and the source counts, so a live (changing) source still compares exactly.
  DUMP="$TMP/source.dump"; DSRC="fresh pg_dump -Fc of source (exported snapshot)"
  cat > "$TMP/snap.sql" <<SQL
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
\\o $TMP/snap.id
SELECT pg_export_snapshot();
\\o $TMP/cnt.src
$CNT_SQL;
\\o $TMP/audit.src
$AUDIT_SQL;
\\o $TMP/stock.src
$STOCK_SQL;
\\o
\\! touch $TMP/snap.ready
\\! while [ ! -f $TMP/snap.done ]; do sleep 0.5; done
ROLLBACK;
SQL
  psql "$SRC" -X -Atq -v ON_ERROR_STOP=1 -f "$TMP/snap.sql" 2> "$TMP/snap.err" &
  SNAP_PID=$!
  for _ in $(seq 1 120); do [[ -f "$TMP/snap.ready" ]] && break; sleep 0.5; done
  [[ -f "$TMP/snap.ready" ]] || { rec "dump" FAIL "snapshot session failed: $(head -c 200 "$TMP/snap.err")"; kill "$SNAP_PID" 2>/dev/null; exit 1; }
  pg_dump -Fc --snapshot="$(tr -d '[:space:]' < "$TMP/snap.id")" "$SRC" -f "$DUMP"; DRC=$?
  touch "$TMP/snap.done"; wait "$SNAP_PID" 2>/dev/null
  [[ $DRC -eq 0 ]] || { rec "dump" FAIL "pg_dump failed"; exit 1; }
else
  DSRC="DUMP_FILE $(basename "$DUMP")"
  if [[ "$DUMP" == *.gpg ]]; then
    [[ -s "${BACKUP_PASSPHRASE_FILE:-}" ]] || { echo "BACKUP_PASSPHRASE_FILE required for .gpg dump" >&2; exit 1; }
    gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" --decrypt "$DUMP" > "$TMP/source.dump" || { rec "decrypt" FAIL "gpg failed"; exit 1; }
    DUMP="$TMP/source.dump"
  fi
fi
rec "dump ready" PASS "$DSRC ($(du -h "$DUMP" | cut -f1))"

# 2. restore into a separate DB
T1=$(now)
drop_db; q "$ADMIN_URL" "CREATE DATABASE \"$DB\"" >/dev/null || { rec "create db" FAIL "$DB"; exit 1; }
# --no-owner/--no-privileges: ownership and grants are re-established by provision-roles.sql (same as CI/prod bootstrap)
# Without --exit-on-error so a newer client (e.g. pg_restore 17 -> server 16) emitting `SET transaction_timeout`
# does not abort; every OTHER error still fails the drill.
pg_restore --no-owner --no-privileges -d "$DRILL_ADMIN" "$DUMP" 2> "$TMP/restore.err"
REAL_ERR="$(grep -E 'error:|ERROR:' "$TMP/restore.err" | grep -v 'transaction_timeout' | head -n 3 | tr '\n|' '  ')"
[[ -z "$REAL_ERR" ]] && rec "pg_restore" PASS "restored into $DB (version-skew SET transaction_timeout lines ignored: $(grep -c transaction_timeout "$TMP/restore.err" || true))" || { rec "pg_restore" FAIL "${REAL_ERR:0:300}"; exit 1; }
psql "$DRILL_ADMIN" -X -v ON_ERROR_STOP=1 -q -f "$ROOT/packages/database/scripts/provision-roles.sql" >/dev/null 2>"$TMP/prov.err" \
  && rec "provision-roles.sql" PASS "owner/app/system roles + grants applied" || rec "provision-roles.sql" FAIL "$(head -c 200 "$TMP/prov.err" | tr '\n|' '  ')"
T2=$(now)

# 3. prisma migrate status (owner role)
if command -v pnpm >/dev/null; then
  MS="$(cd "$ROOT" && DATABASE_URL="$DRILL_OWNER" DATABASE_MIGRATE_URL="$DRILL_OWNER" pnpm --filter @velto/database exec prisma migrate status 2>&1)"; MSRC=$?
  if [[ $MSRC -eq 0 ]] && grep -q 'Database schema is up to date' <<<"$MS"; then rec "prisma migrate status" PASS "schema up to date"
  else rec "prisma migrate status" FAIL "exit $MSRC: $(tail -n 3 <<<"$MS" | tr '\n|' '  ' | head -c 250)"; fi
else rec "prisma migrate status" FAIL "pnpm not found"; fi

# 4. RLS FORCE on every tenant table
BAD="$(q "$DRILL_SYS" "
 SELECT string_agg(c.relname, ',') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','p') AND (
   (c.relrowsecurity AND NOT c.relforcerowsecurity)
   OR (EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='companyId' AND NOT a.attisdropped) AND NOT (c.relrowsecurity AND c.relforcerowsecurity)))")"
NRLS="$(q "$DRILL_SYS" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity AND c.relforcerowsecurity")"
[[ -z "$BAD" && "${NRLS:-0}" -gt 0 ]] && rec "RLS FORCE (relforcerowsecurity)" PASS "$NRLS tables ENABLE+FORCE; all companyId tables covered" || rec "RLS FORCE (relforcerowsecurity)" FAIL "missing: ${BAD:-none}; forced=$NRLS"

# 5. row counts vs source
q "$DRILL_SYS" "$CNT_SQL" > "$TMP/cnt.drill" 2>/dev/null
NT="$(wc -l < "$TMP/cnt.drill" | tr -d ' ')"
if [[ -z "${DUMP_FILE:-}" ]]; then
  if [[ -s "$TMP/cnt.drill" ]] && diff -q "$TMP/cnt.src" "$TMP/cnt.drill" >/dev/null; then rec "table row counts vs source" PASS "$NT tables identical"
  else rec "table row counts vs source" FAIL "diff: $(diff "$TMP/cnt.src" "$TMP/cnt.drill" | grep '^[<>]' | head -n 4 | tr '\n|' '  ')"; fi
else
  [[ -s "$TMP/cnt.drill" ]] && rec "table row counts vs source" PASS "$NT tables restored (no live source comparison for DUMP_FILE; counts in report appendix)" || rec "table row counts vs source" FAIL "no counts"
fi

# 6. StockLevel == sum(StockMovement)  (formula of reconciliation.service.ts)
SM="$(q "$DRILL_SYS" "$STOCK_SQL")"
if [[ "$SM" == 0/* ]]; then rec "StockLevel = sum(StockMovement)" PASS "mismatch/total = $SM"
elif [[ "${DRILL_ALLOW_SOURCE_DRIFT:-0}" == 1 && -s "$TMP/stock.src" && "$SM" == "$(tr -d '\r\n' < "$TMP/stock.src")" ]]; then
  rec "StockLevel = sum(StockMovement)" PASS "restore faithful: mismatch/total $SM identical to SOURCE (pre-existing drift accepted by DRILL_ALLOW_SOURCE_DRIFT=1; dev/test data only)"
else rec "StockLevel = sum(StockMovement)" FAIL "mismatch/total = ${SM:-error} (source: $(tr -d '\r\n' < "$TMP/stock.src" 2>/dev/null || echo n/a))"; fi

# 7. allocation sums
AL="$(q "$DRILL_SYS" "
 SELECT (SELECT count(*) FROM \"Payment\" p JOIN (SELECT \"paymentId\", SUM(amount) s FROM \"PaymentAllocation\" GROUP BY 1) a ON a.\"paymentId\"=p.id WHERE a.s > p.amount)
   || '/' || (SELECT count(*) FROM \"Invoice\" i JOIN (SELECT pa.\"invoiceId\", SUM(pa.amount) s FROM \"PaymentAllocation\" pa JOIN \"Payment\" py ON py.id=pa.\"paymentId\" WHERE py.status IN ('POSTED','PENDING_HANDOVER') GROUP BY 1) a ON a.\"invoiceId\"=i.id WHERE a.s > i.total)
   || '/' || (SELECT count(*) FROM \"PaymentAllocation\")")"
[[ "$AL" == 0/0/* ]] && rec "allocation sums (live payments)" PASS "over-allocated payments/invoices/allocations = $AL" || rec "allocation sums (live payments)" FAIL "over-allocated payments/invoices/allocations = ${AL:-error}"

# 8. AuditLog continuity vs source
AU="$(q "$DRILL_SYS" "$AUDIT_SQL")"
IFS='|' read -r AC AD AMIN AMAX <<<"$AU"
if [[ -z "${DUMP_FILE:-}" ]]; then
  ASRC="$(tr -d '\r\n' < "$TMP/audit.src")"
  [[ "$AU" == "$ASRC" && "$AC" == "$AD" ]] && rec "AuditLog continuity" PASS "rows=$AC unique, range $AMIN .. $AMAX equals source" || rec "AuditLog continuity" FAIL "drill=$AU source=$ASRC"
else
  [[ "$AC" == "$AD" ]] && rec "AuditLog continuity" PASS "rows=$AC unique, range $AMIN .. $AMAX" || rec "AuditLog continuity" FAIL "$AU"
fi
UPD="$(psql "$DRILL_SYS" -X -Atq -c 'UPDATE "AuditLog" SET action=action WHERE id=(SELECT id FROM "AuditLog" LIMIT 1)' 2>&1 | head -n1)"
if [[ "$AC" -eq 0 ]]; then rec "AuditLog append-only trigger" PASS "no rows to test"
elif grep -qi 'error' <<<"$UPD"; then rec "AuditLog append-only trigger" PASS "UPDATE rejected by DB trigger"; else rec "AuditLog append-only trigger" FAIL "UPDATE was allowed"; fi

# 9. tenant isolation smoke as velto_app
TC="$(q "$DRILL_SYS" "SELECT \"companyId\" FROM \"Customer\" GROUP BY 1 ORDER BY count(*) DESC LIMIT 1")"
TOTAL="$(q "$DRILL_SYS" 'SELECT count(*) FROM "Customer"')"
if [[ -z "$TC" ]]; then rec "tenant isolation smoke (velto_app)" FAIL "no Customer rows to test with"
else
  BARE="$(q "$DRILL_APP" 'SELECT count(*) FROM "Customer"' 2>&1)"
  SCOPED="$(psql "$DRILL_APP" -X -Atq -v ON_ERROR_STOP=1 -c "BEGIN" -c "SELECT set_config('app.current_company_id','$TC',true)" -c 'SELECT count(*) FROM "Customer"' -c "ROLLBACK" 2>&1 | grep -E '^[0-9]+$' | tail -n1)"
  OTHER="$(psql "$DRILL_APP" -X -Atq -v ON_ERROR_STOP=1 -c "BEGIN" -c "SELECT set_config('app.current_company_id','00000000-0000-0000-0000-000000000000',true)" -c 'SELECT count(*) FROM "Customer"' -c "ROLLBACK" 2>&1 | grep -E '^[0-9]+$' | tail -n1)"
  [[ "$BARE" == 0 && "$OTHER" == 0 && "${SCOPED:-0}" -gt 0 && "$SCOPED" -le "$TOTAL" ]] \
    && rec "tenant isolation smoke (velto_app)" PASS "bare select=0, foreign tenant=0, own tenant=$SCOPED of $TOTAL" \
    || rec "tenant isolation smoke (velto_app)" FAIL "bare=$BARE foreign=$OTHER own=${SCOPED:-?} total=$TOTAL"
fi
T3=$(now)

# report
D="$(date +%F)"; mkdir -p "$REPORT_DIR"; OUT="$REPORT_DIR/restore-drill-$D.md"
[[ $FAILS -eq 0 ]] && VERDICT="PASS" || VERDICT="FAIL ($FAILS)"
{
  echo "# Restore drill $D"; echo
  echo "- Verdict: **$VERDICT**"
  echo "- Started (UTC): $START_ISO; finished: $(date -u +%FT%TZ)"
  echo "- Source of dump: $DSRC"
  echo "- Target: separate database \`$DB\` on $HOST:$PORT (dropped afterwards unless DRILL_KEEP_DB=1); source DB not modified."
  echo "- **RTO measured**: restore (create + pg_restore + provision-roles) = $((T2-T1)) s; full drill incl. dump and all checks = $((T3-T0)) s. Dataset size: $(du -h "$DUMP" | cut -f1) dump — NOT representative of production volume; re-measure on production-sized data. Target RTO <= 4 h."
  echo "- RPO: daily backup only (pilot); WAL/PITR for GA is plan-only, see docs/ops/wal-pitr-plan.md."
  echo; echo "| Check | Status | Detail |"; echo "|---|---|---|"; printf '%s\n' "${RESULTS[@]}"
  echo; echo "## Row counts (table=rows, restored DB)"; echo '```'; cat "$TMP/cnt.drill"; echo '```'
} > "$OUT"
echo "[drill] report: $OUT  verdict: $VERDICT  RTO(restore)=$((T2-T1))s total=$((T3-T0))s"
[[ $FAILS -eq 0 ]]
