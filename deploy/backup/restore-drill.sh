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
#   DRILL_APP_ROLE/DRILL_OWNER_ROLE/DRILL_SYSTEM_ROLE  role names (default velto_app/velto_owner/velto_system; some hosts use others, see deploy/README.md)
#   DRILL_KEEP_DB=1        keep the drill DB afterwards (default: dropped)
#   DRILL_COMPARE_SOURCE=1 with DUMP_FILE: also compare row counts/AuditLog with live SOURCE_URL (valid ONLY if the source is quiescent since the backup)
#   DRILL_SET_MANIFEST     path of a velto-set-<TS>.manifest: the drill restores THAT set (DB + objects) after verifying manifest structure, OBJECTS=ok and the
#                          exact size + sha256 of every archive next to it. Mutually exclusive with DUMP_FILE.
#   DRILL_BACKUP_DIR       directory of sets (e.g. a downloaded offsite copy): the NEWEST set whose manifest exists and whose checksums all match is used.
#   DRILL_MAX_RESTORE_POINT_AGE_MINUTES  REQUIRED in set-mode: max age of the SIGNED RESTORE_POINT_TS (stale/replayed older set = FAIL); or DRILL_EXPECT_RUN_ID=<signed RUN_ID> for a deliberate historical restore.
#   BACKUP_VERIFY_KEYRING  exported PUBLIC signing key(s), kept OUTSIDE the backup (set-mode requires it); BACKUP_TRUSTED_SIGN_FPRS = pinned PRIMARY-key fingerprints (space/comma separated, >1 for rotation).
#                          Set-mode order: manifest signature -> size+sha256 of EVERY listed file -> no extra file -> restore -> financial fingerprint recomputed and compared with the encrypted FP in the set.
# Verdict: PASS only for a verified restore set whose objects archive is intact AND every object key referenced by the restored DB (ExportJob.storageKey, ImportJob.fileUrl,
# Product.imageUrl) is in the archive (ExportJob.fileHash must also equal the archived sha256). A DB-only drill (DUMP_FILE / fresh dump, no set) is PARTIAL, never PASS.
# Exit 0 = PASS; 1 = any FAIL; 2 = PARTIAL (all executed checks passed but DB-only: not a proven restore point); 3 = NOT_VERIFIED (set verified but it carries NO financial fingerprint: never PASS).
set -Euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOST="${DRILL_HOST:-localhost}"; PORT="${DRILL_PORT:-5433}"
ADMIN_USER="${DRILL_ADMIN_USER:-velto}"; ADMIN_PW="${DRILL_ADMIN_PASSWORD:-velto}"
DB="${DRILL_DB:-velto_restore_drill}"
SOURCE_URL="${SOURCE_URL:-postgresql://velto_system:velto_system@localhost:5433/velto_dev}"
REPORT_DIR="${DRILL_REPORT_DIR:-$ROOT/docs/ops}"
APP_ROLE="${DRILL_APP_ROLE:-velto_app}"; OWNER_ROLE="${DRILL_OWNER_ROLE:-velto_owner}"; SYSTEM_ROLE="${DRILL_SYSTEM_ROLE:-velto_system}"
for r in "$APP_ROLE" "$OWNER_ROLE" "$SYSTEM_ROLE"; do [[ "$r" =~ ^[a-z0-9_]+$ ]] || { echo "invalid role name" >&2; exit 1; }; done
[[ "$DB" == velto_restore_drill* ]] || { echo "refusing: DRILL_DB must start with velto_restore_drill" >&2; exit 1; }
[[ "$DB" =~ ^[a-z0-9_]+$ ]] || { echo "invalid DRILL_DB" >&2; exit 1; }
case "$HOST" in localhost|127.0.0.1|::1) ;; *) [[ "${DRILL_ALLOW_REMOTE:-0}" == 1 ]] || { echo "refusing non-local DRILL_HOST without DRILL_ALLOW_REMOTE=1" >&2; exit 1; } ;; esac
# Passwords never go in argv: every connection is a password-less conninfo string; secrets live in a 0600 PGPASSFILE (pg-conn.sh).
# shellcheck source=pg-conn.sh
. "$(dirname "${BASH_SOURCE[0]}")/pg-conn.sh"
# shellcheck source=backup-status-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/backup-status-lib.sh"
# shellcheck source=fingerprint-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/fingerprint-lib.sh"
trap pgc_cleanup EXIT; pgc_init
pgc_parse "$SOURCE_URL" || { echo "SOURCE_URL is not parseable" >&2; exit 1; }; SRC="$(pgc_conninfo)"
pgc_add "$HOST" "$PORT" postgres "$ADMIN_USER" "$ADMIN_PW"; ADMIN_URL="$(pgc_conninfo)"
pgc_add "$HOST" "$PORT" "$DB" "$ADMIN_USER" "$ADMIN_PW"; DRILL_ADMIN="$(pgc_conninfo)"
pgc_add "$HOST" "$PORT" "$DB" "$SYSTEM_ROLE" "${DRILL_SYSTEM_PASSWORD:-velto_system}"; DRILL_SYS="$(pgc_conninfo)"
pgc_add "$HOST" "$PORT" "$DB" "$APP_ROLE" "${DRILL_APP_PASSWORD:-velto_app}"; DRILL_APP="$(pgc_conninfo)"
# prisma needs a URL: passed via the child's environment only (not argv)
DRILL_OWNER="postgresql://${OWNER_ROLE}:${DRILL_OWNER_PASSWORD:-velto_owner}@$HOST:$PORT/$DB?schema=public"
for c in psql pg_dump pg_restore; do command -v $c >/dev/null || { echo "$c not found" >&2; exit 1; }; done

TMP="$(mktemp -d)"; chmod 700 "$TMP"
RESULTS=(); FAILS=0
q() { psql "$1" -X -v ON_ERROR_STOP=1 -Atq -c "$2"; }
rec() { # name status detail
  RESULTS+=("| $1 | $2 | $3 |"); [[ "$2" == PASS || "$2" == SKIP ]] || FAILS=$((FAILS+1)); printf '[drill] %-4s %s %s\n' "$2" "$1" "$3"
}
now() { date +%s; }
drop_db() { q "$ADMIN_URL" "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null 2>&1; }
cleanup() { [[ "${DRILL_KEEP_DB:-0}" == 1 ]] || drop_db; rm -rf "$TMP"; pgc_cleanup; }
trap cleanup EXIT

# 0. restore set selection: only a set with a manifest whose checksums match counts (bsm_verify: OBJECTS=ok, exact sizes + sha256 of DB/objects/globals)
SET_OK=0; OBJ_ARCH=""; SETM=""; FP_ARCH=""; FP_STATE=n/a
if [[ -n "${DRILL_SET_MANIFEST:-}" || -n "${DRILL_BACKUP_DIR:-}" ]]; then
  [[ -z "${DUMP_FILE:-}" ]] || { echo "DUMP_FILE and DRILL_SET_MANIFEST/DRILL_BACKUP_DIR are mutually exclusive" >&2; exit 1; }
  if [[ -n "${DRILL_SET_MANIFEST:-}" ]]; then
    bsm_verify_signed "$DRILL_SET_MANIFEST" "$(dirname "$DRILL_SET_MANIFEST")" || { rec "restore set" FAIL "$BSM_REASON"; exit 1; }
    SETM="$DRILL_SET_MANIFEST"
  else
    bsm_select "$DRILL_BACKUP_DIR" || { rec "restore set" FAIL "no valid set in DRILL_BACKUP_DIR ($BSM_REJECTED manifest(s) rejected; archives without a manifest are never used)"; exit 1; }
    SETM="$BSM_SELECTED"; bsm_verify_signed "$SETM" "$DRILL_BACKUP_DIR" || exit 1   # reload BSM_TEXT of the selected set
  fi
  # replay guard on SIGNED data: a stale (older, validly signed) set is a FAIL unless the operator names the historical RUN_ID explicitly
  bsm_fresh_check "${DRILL_MAX_RESTORE_POINT_AGE_MINUTES:-}" "${DRILL_EXPECT_RUN_ID:-}" || { rec "restore set freshness" FAIL "$BSM_REASON"; exit 1; }
  # TOCTOU: work only on a PRIVATE copy (0700 temp dir) and verify the COPY again (signature, sha256 of every file, binding); the original is never read after this point
  PRIV="$TMP/set"; mkdir -m 700 "$PRIV" && cp "$SETM" "$SETM.sig" "$PRIV/" || { rec "restore set copy" FAIL "cannot copy the manifest"; exit 1; }
  for _n in $(grep -E '^[A-Z]+_ARCHIVE=' "$PRIV/$(basename "$SETM")" | cut -d= -f2-); do cp "$(dirname "$SETM")/$_n" "$PRIV/" || { rec "restore set copy" FAIL "cannot copy $_n"; exit 1; }; done
  SETM="$PRIV/$(basename "$SETM")"
  bsm_verify_signed "$SETM" "$PRIV" || { rec "restore set (private copy)" FAIL "$BSM_REASON"; exit 1; }
  bsm_fresh_check "${DRILL_MAX_RESTORE_POINT_AGE_MINUTES:-}" "${DRILL_EXPECT_RUN_ID:-}" || { rec "restore set freshness (private copy)" FAIL "$BSM_REASON"; exit 1; }
  SETD="$PRIV"; DUMP_FILE="$SETD/$(bsm_get DB_ARCHIVE)"; OBJ_ARCH="$SETD/$(bsm_get OBJ_ARCHIVE)"
  OBJ_MSHA="$(bsm_get OBJ_MANIFEST_SHA256)"; OBJ_COUNT="$(bsm_get OBJ_COUNT)"; SET_OK=1
  [[ -z "$(bsm_get FP_ARCHIVE)" ]] || FP_ARCH="$SETD/$(bsm_get FP_ARCHIVE)"
  rec "restore set manifest" PASS "$(basename "$SETM"): signature valid (pinned key), every listed file matches manifest size + sha256, no extra files, objects backup ok"
fi

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
SUMS_SQL="SELECT (SELECT count(*)||':'||COALESCE(sum(total),0) FROM \"Invoice\")||'|'||(SELECT count(*)||':'||COALESCE(sum(amount),0) FROM \"Payment\")||'|'||(SELECT count(*)||':'||COALESCE(sum(amount),0) FROM \"PaymentAllocation\")||'|'||(SELECT COALESCE(sum(\"cachedBalance\"),0) FROM \"Customer\")"
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
\\o $TMP/sums.src
$SUMS_SQL;
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
  DSRC="$([[ $SET_OK == 1 ]] && echo "restore set" || echo DUMP_FILE) $(basename "$DUMP")"
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
psql "$DRILL_ADMIN" -X -v ON_ERROR_STOP=1 -v velto_env=production -q -f "$ROOT/packages/database/scripts/provision-roles.sql" >/dev/null 2>"$TMP/prov.err" \
  && rec "provision-roles.sql" PASS "owner/app/system roles + grants applied" || rec "provision-roles.sql" FAIL "$(head -c 200 "$TMP/prov.err" | tr '\n|' '  ')"
T2=$(now)

# 3. prisma migrate status (owner role)
if command -v pnpm >/dev/null; then
  MS="$(cd "$ROOT" && DATABASE_URL="$DRILL_OWNER" DATABASE_MIGRATE_URL="$DRILL_OWNER" pnpm --filter @velto/database exec prisma migrate status 2>&1)"; MSRC=$?
  if [[ $MSRC -eq 0 ]] && grep -q 'Database schema is up to date' <<<"$MS"; then rec "prisma migrate status" PASS "schema up to date"
  else rec "prisma migrate status" FAIL "exit $MSRC: $(tail -n 3 <<<"$MS" | tr '\n|' '  ' | head -c 250)"; fi
else rec "prisma migrate status" FAIL "pnpm not found"; fi

# 3b. _prisma_migrations == repo migration directories (all applied, none failed, no extras)
REPO_MIG="$(for d in "$ROOT"/packages/database/prisma/migrations/*/; do b="${d%/}"; b="${b##*/}"; [[ "$b" =~ ^[0-9]{14}_ ]] && echo "$b"; done | sort)"
DB_MIG="$(q "$DRILL_SYS" "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1")"
NFAIL="$(q "$DRILL_SYS" "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")"
if [[ "$REPO_MIG" == "$DB_MIG" && "$NFAIL" == 0 ]]; then rec "_prisma_migrations == repo" PASS "$(wc -l <<<"$REPO_MIG" | tr -d ' ') migrations identical, 0 failed/rolled back"
else rec "_prisma_migrations == repo" FAIL "diff: $(diff <(echo "$REPO_MIG") <(echo "$DB_MIG") | grep '^[<>]' | head -n 3 | tr '\n|' '  '); failed=$NFAIL"; fi

# 3c. Invoice.total == sum(InvoiceLine.lineTotal)
IT="$(q "$DRILL_SYS" "SELECT count(*) FILTER (WHERE COALESCE(l.s,0)<>i.total) || '/' || count(*) FROM \"Invoice\" i LEFT JOIN (SELECT \"invoiceId\", SUM(\"lineTotal\") s FROM \"InvoiceLine\" GROUP BY 1) l ON l.\"invoiceId\"=i.id")"
[[ "$IT" == 0/* ]] && rec "invoice total = sum(lines)" PASS "mismatch/total = $IT" || rec "invoice total = sum(lines)" FAIL "mismatch/total = ${IT:-error}"

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
  if [[ "${DRILL_COMPARE_SOURCE:-0}" == 1 ]]; then
    q "$SRC" "$CNT_SQL" > "$TMP/cnt.src" 2>/dev/null
    if [[ -s "$TMP/cnt.drill" && -s "$TMP/cnt.src" ]] && diff -q "$TMP/cnt.src" "$TMP/cnt.drill" >/dev/null; then rec "table row counts vs source" PASS "$NT tables identical to live (quiescent) source"
    else rec "table row counts vs source" FAIL "diff: $(diff "$TMP/cnt.src" "$TMP/cnt.drill" 2>&1 | grep '^[<>]' | head -n 4 | tr '\n|' '  ')"; fi
  else
    [[ -s "$TMP/cnt.drill" ]] && rec "table row counts vs source" PASS "$NT tables restored (no live source comparison for DUMP_FILE; counts in report appendix)" || rec "table row counts vs source" FAIL "no counts"
  fi
fi

# 6. StockLevel == sum(StockMovement)  (formula of reconciliation.service.ts)
SM="$(q "$DRILL_SYS" "$STOCK_SQL")"
if [[ "$SM" == 0/* ]]; then rec "StockLevel = sum(StockMovement)" PASS "mismatch/total = $SM"
elif [[ "${DRILL_ALLOW_SOURCE_DRIFT:-0}" == 1 && -s "$TMP/stock.src" && "$SM" == "$(tr -d '\r\n' < "$TMP/stock.src")" ]]; then
  rec "StockLevel = sum(StockMovement)" PASS "restore faithful: mismatch/total $SM identical to SOURCE (pre-existing drift accepted by DRILL_ALLOW_SOURCE_DRIFT=1; dev/test data only)"
elif [[ -n "${DUMP_FILE:-}" && "${DRILL_ALLOW_SOURCE_DRIFT:-0}" == 1 ]]; then
  # DUMP_FILE mode has no source snapshot: the check above is an internal invariant of the restored DB only.
  rec "StockLevel = sum(StockMovement)" SKIP "mismatch/total = $SM; DUMP_FILE has no source to prove drift is pre-existing (DRILL_ALLOW_SOURCE_DRIFT=1, dev/test data only)"
elif [[ -n "${DUMP_FILE:-}" ]]; then rec "StockLevel = sum(StockMovement)" FAIL "internal invariant violated in restored DB: mismatch/total = ${SM:-error} (no source snapshot in DUMP_FILE mode; dev data only: DRILL_ALLOW_SOURCE_DRIFT=1 -> SKIP)"
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
  if [[ "${DRILL_COMPARE_SOURCE:-0}" == 1 ]]; then
    ASRC="$(q "$SRC" "$AUDIT_SQL")"
    [[ "$AU" == "$ASRC" && "$AC" == "$AD" ]] && rec "AuditLog continuity" PASS "rows=$AC unique, range $AMIN .. $AMAX equals live source" || rec "AuditLog continuity" FAIL "drill=$AU source=$ASRC"
  else
    [[ "$AC" == "$AD" ]] && rec "AuditLog continuity" PASS "rows=$AC unique, range $AMIN .. $AMAX" || rec "AuditLog continuity" FAIL "$AU"
  fi
fi
UPD="$(psql "$DRILL_SYS" -X -Atq -c 'UPDATE "AuditLog" SET action=action WHERE id=(SELECT id FROM "AuditLog" LIMIT 1)' 2>&1 | head -n1)"
if [[ "$AC" -eq 0 ]]; then rec "AuditLog append-only trigger" PASS "no rows to test"
elif grep -qi 'error' <<<"$UPD"; then rec "AuditLog append-only trigger" PASS "UPDATE rejected by DB trigger"; else rec "AuditLog append-only trigger" FAIL "UPDATE was allowed"; fi

# 8b. financial fingerprint: Invoice count+sum(total) | Payment count+sum(amount) | PaymentAllocation count+sum | sum(Customer.cachedBalance)
SU="$(q "$DRILL_SYS" "$SUMS_SQL")"
if [[ -z "${DUMP_FILE:-}" ]]; then SSRC="$(tr -d '\r\n' < "$TMP/sums.src")"
elif [[ "${DRILL_COMPARE_SOURCE:-0}" == 1 ]]; then SSRC="$(q "$SRC" "$SUMS_SQL")"; else SSRC=""; fi
# Report is git-tracked by default: NO sums/counts of money are written, only per-metric MATCH/MISMATCH/SKIP.
FIN_NAMES=(invoices payments allocations cachedBalance)
if [[ -z "$SU" ]]; then rec "financial sums" FAIL "query failed"
elif [[ -z "$SSRC" ]]; then rec "financial sums" SKIP "no quiescent source to compare (values intentionally not recorded)"
else
  IFS='|' read -r -a FA <<<"$SU"; IFS='|' read -r -a FB <<<"$SSRC"; FD=(); FBAD=0
  for i in 0 1 2 3; do
    if [[ -n "${FA[$i]:-}" && "${FA[$i]:-}" == "${FB[$i]:-}" ]]; then FD+=("${FIN_NAMES[$i]}=MATCH"); else FD+=("${FIN_NAMES[$i]}=MISMATCH"); FBAD=1; fi
  done
  if [[ $FBAD -eq 0 ]]; then rec "financial sums" PASS "${FD[*]} (vs source)"; else rec "financial sums" FAIL "${FD[*]} (vs source)"; fi
fi

# 8b2. financial fingerprint (R4): the set carries an encrypted per-table fingerprint taken in the SAME snapshot as the dump; recompute it on the restored DB.
# Only table names + MATCH/MISMATCH are printed or reported (no sums, no hashes). A set without a fingerprint is NOT_VERIFIED (exit 3), never PASS.
if [[ $SET_OK == 1 ]]; then
  if [[ -z "$FP_ARCH" ]]; then FP_STATE=NOT_VERIFIED; rec "financial fingerprint" SKIP "NOT_VERIFIED: the set has no fingerprint archive (pre-R4 backup) - verdict can not be PASS"
  elif [[ ! -s "${BACKUP_PASSPHRASE_FILE:-}" ]]; then FP_STATE=FAIL; rec "financial fingerprint" FAIL "BACKUP_PASSPHRASE_FILE required to decrypt the fingerprint"
  elif ! gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" --decrypt "$FP_ARCH" > "$TMP/fp.expected" 2>/dev/null || ! fp_check_shape < "$TMP/fp.expected"; then
    FP_STATE=FAIL; rec "financial fingerprint" FAIL "fingerprint archive cannot be decrypted or is malformed"
  elif ! fp_compute "$DRILL_SYS" > "$TMP/fp.actual" 2>"$TMP/fp.err"; then
    FP_STATE=FAIL; rec "financial fingerprint" FAIL "recompute failed on the restored DB"
  else
    FPD="$(fp_compare "$TMP/fp.expected" "$TMP/fp.actual")" && { FP_STATE=PASS; rec "financial fingerprint" PASS "$FPD(count + sums + sha256 of canonical rows, same snapshot as the dump)"; } \
      || { FP_STATE=FAIL; rec "financial fingerprint" FAIL "$FPD"; }
  fi
fi

# 8c. roles: app/owner must be NOSUPERUSER NOBYPASSRLS (a BYPASSRLS app role would silently defeat RLS); system must be BYPASSRLS-only
RL="$(q "$DRILL_SYS" "SELECT string_agg(r.l||':'||rolsuper||':'||rolbypassrls, ',' ORDER BY r.l) FROM pg_roles JOIN (VALUES ('$APP_ROLE','app'),('$OWNER_ROLE','owner'),('$SYSTEM_ROLE','system')) r(n,l) ON rolname=r.n")"
[[ "$RL" == "app:false:false,owner:false:false,system:false:true" ]] && rec "roles NOBYPASSRLS (app/owner)" PASS "$RL (role:super:bypassrls)" || rec "roles NOBYPASSRLS (app/owner)" FAIL "${RL:-roles missing} (expected app/owner false:false, system false:true)"

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

# 10. objects: archive integrity + DB <-> objects consistency (only for a verified restore set)
OBJ_OK=0
if [[ $SET_OK == 1 ]]; then
  for c in gpg tar; do command -v $c >/dev/null || { echo "$c not found" >&2; exit 1; }; done
  if bsm_objects_extract "$OBJ_ARCH" "$BACKUP_PASSPHRASE_FILE" "$OBJ_MSHA" "$OBJ_COUNT" "$TMP"; then
    rec "objects archive" PASS "$BSM_OBJ_NUM object(s): embedded manifest + every object sha256/size verified"; OBJ_OK=1
  else rec "objects archive" FAIL "$BSM_REASON"; fi
  if [[ $OBJ_OK == 1 ]]; then
    RX='(?:^|/)((?:products|imports|opening|exports)/.+)$'
    psql "$DRILL_SYS" -X -v ON_ERROR_STOP=1 -Atq -F $'\t' -c "SELECT k, h FROM (
        SELECT \"storageKey\" AS k, COALESCE(\"fileHash\",'') AS h FROM \"ExportJob\" WHERE \"storageKey\" IS NOT NULL
        UNION ALL SELECT substring(\"fileUrl\" from '$RX'), '' FROM \"ImportJob\"
        UNION ALL SELECT substring(\"imageUrl\" from '$RX'), '' FROM \"Product\" WHERE \"imageUrl\" IS NOT NULL) t
      WHERE k IS NOT NULL ORDER BY 1" > "$TMP/db.keys" 2>"$TMP/keys.err" || OBJ_OK=0
    if [[ $OBJ_OK == 1 ]]; then
      if bsm_keys_check "$TMP/db.keys" "$TMP/obj/MANIFEST.tsv"; then rec "DB-referenced objects in archive" PASS "$BSM_DBKEYS key(s) referenced by the DB: missing=0, fileHash mismatch=0 (keys not under the 5 prefixes, e.g. external image URLs, are out of scope)"
      else OBJ_OK=0; rec "DB-referenced objects in archive" FAIL "$BSM_DBKEYS key(s) referenced by the DB: missing=$BSM_MISSING, fileHash mismatch (overwritten key / other version)=$BSM_STALE"; fi
    else rec "DB-referenced objects in archive" FAIL "key query failed: $(head -c 200 "$TMP/keys.err" | tr '\n|' '  ')"; fi
  fi
else
  rec "restore set (DB + objects)" SKIP "DB-only drill: no verified restore-set manifest (set DRILL_SET_MANIFEST or DRILL_BACKUP_DIR) -> verdict PARTIAL, objects NOT proven"
fi
T3=$(now)

# report
D="$(date +%F)"; mkdir -p "$REPORT_DIR"; OUT="$REPORT_DIR/restore-drill-$D.md"
VERDICT="$(bs_verdict "$FAILS" "$SET_OK" "$OBJ_OK")"; RC=$?
if [[ $RC -eq 0 && $SET_OK == 1 && "$FP_STATE" != PASS ]]; then VERDICT=NOT_VERIFIED; RC=3; fi
case "$VERDICT" in NOT_VERIFIED) VERDICT="NOT_VERIFIED (no financial fingerprint in the set: not a proven restore point)";; FAIL) VERDICT="FAIL ($FAILS)";; PARTIAL) VERDICT="PARTIAL (DB only: objects not verified, not a proven restore point)";; esac
{
  echo "# Restore drill $D"; echo
  echo "- Verdict: **$VERDICT**"
  echo "- Started (UTC): $START_ISO; finished: $(date -u +%FT%TZ)"
  echo "- Source of dump: $DSRC"
  echo "- Target: separate database \`$DB\` on $HOST:$PORT (dropped afterwards unless DRILL_KEEP_DB=1); source DB not modified."
  echo "- **RTO measured**: restore (create + pg_restore + provision-roles) = $((T2-T1)) s; full drill incl. dump and all checks = $((T3-T0)) s. Dataset size: $(du -h "$DUMP" | cut -f1) dump — NOT representative of production volume; re-measure on production-sized data. Target RTO <= 4 h."
  echo "- RPO/RTO: NOT_TESTED by this drill (scheduled cadence is every 20 min; volumes here are not production-like). See docs/release/RPO-RTO-ASSESSMENT.md; WAL/PITR is plan-only (docs/ops/wal-pitr-plan.md)."
  echo; echo "| Check | Status | Detail |"; echo "|---|---|---|"; printf '%s\n' "${RESULTS[@]}"
  echo; echo "## Row counts (table=rows, restored DB)"; echo '```'; cat "$TMP/cnt.drill"; echo '```'
} > "$OUT"
echo "[drill] report: $OUT  verdict: $VERDICT  RTO(restore)=$((T2-T1))s total=$((T3-T0))s"
exit "$RC"
