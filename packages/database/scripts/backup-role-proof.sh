#!/usr/bin/env bash
# SC2015: pass() always returns 0, so `test && pass || fail` is if/else here.
# SC2016: single-quoted $$...$$ are SQL dollar-quotes, not shell expansions.
# shellcheck disable=SC2015,SC2016
# F-5 proof: velto_backup (BYPASSRLS, read-only) produces a COMPLETE pg_dump of
# the real schema under FORCE ROW LEVEL SECURITY, and the restore is faithful.
#
# THROWAWAY CLUSTER ONLY. Synthetic data only (seed-load.ts + generated
# AuditLog rows). Drops/recreates the databases velto_load and
# velto_restore_proof on the target cluster and (re)sets passwords of the
# velto_* roles there to random values. Refuses to run if the cluster holds
# any other database. Idempotent: every run starts from scratch.
#
#   docker run -d --rm --name velto-f5 -p 127.0.0.1:5544:5432 \
#     -e POSTGRES_PASSWORD=<random> postgres:16
#   (pgpass line 127.0.0.1:5544:*:postgres:<random>, chmod 600)
#   VELTO_PROOF_THROWAWAY=yes PGHOST=127.0.0.1 PGPORT=5544 PGUSER=postgres \
#     PGPASSFILE=<pgpass> bash packages/database/scripts/backup-role-proof.sh
#
# Env: PGHOST (TCP host), PGPORT, PGUSER (superuser), PGPASSFILE (0600, has the
# superuser line). No password is ever placed in argv.
# pg_dump/pg_dumpall/pg_restore MUST match the server major (a v17 dump emits
# `SET transaction_timeout`, which a v16 server rejects on restore). If the
# host has other majors, set PG_TOOLS_CONTAINER=<the throwaway container>: the
# three tools then run inside it (same major as the server), streaming via
# stdin/stdout; the pgpass is copied in 0600 and removed on exit.
set -euo pipefail

[ "${VELTO_PROOF_THROWAWAY:-}" = "yes" ] || { echo "refusing: set VELTO_PROOF_THROWAWAY=yes (throwaway cluster only)" >&2; exit 2; }
: "${PGHOST:?PGHOST required}" "${PGPORT:?PGPORT required}" "${PGUSER:?PGUSER (superuser) required}" "${PGPASSFILE:?PGPASSFILE required}"
[ -r "$PGPASSFILE" ] || { echo "PGPASSFILE not readable" >&2; exit 2; }
for b in psql pnpm openssl; do command -v "$b" >/dev/null || { echo "$b not found" >&2; exit 2; }; done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(dirname "$HERE")"
SRC=velto_load            # seed-load.ts only writes to a database named velto_load
DST=velto_restore_proof
ADMIN="$PGUSER"
FAILS=0

WORK="$(mktemp -d)"
chmod 700 "$WORK"
PGPASS_IN=/tmp/velto-proof-pgpass
cleanup() {
  [ -z "${PG_TOOLS_CONTAINER:-}" ] || docker exec "$PG_TOOLS_CONTAINER" rm -f "$PGPASS_IN" 2>/dev/null || true
  rm -rf -- "${WORK:?}"
}
trap cleanup EXIT INT TERM

pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*" >&2; FAILS=$((FAILS + 1)); }
# psql as <role> on <db>; extra args follow. -X: ignore ~/.psqlrc.
q() { local role="$1" db="$2"; shift 2; psql -X -w -q -At -v ON_ERROR_STOP=1 -U "$role" -d "$db" "$@"; }
# pg_dump / pg_dumpall / pg_restore: files only via stdin/stdout so the same
# calls work on the host and inside PG_TOOLS_CONTAINER.
pgt() {
  if [ -n "${PG_TOOLS_CONTAINER:-}" ]; then
    docker exec -i -e PGPASSFILE="$PGPASS_IN" -e PGHOST=127.0.0.1 -e PGPORT=5432 "$PG_TOOLS_CONTAINER" "$@"
  else
    command -v "$1" >/dev/null || { echo "$1 not found" >&2; return 2; }
    "$@"
  fi
}

# --- guard: only a throwaway cluster ----------------------------------------
others="$(q "$ADMIN" postgres -c "SELECT string_agg(datname, ',') FROM pg_database
  WHERE datname NOT IN ('postgres','template0','template1','$SRC','$DST')")"
[ -z "$others" ] || { echo "refusing: cluster has other databases ($others) — not a throwaway cluster" >&2; exit 2; }
[ "$(q "$ADMIN" postgres -c "SELECT rolsuper FROM pg_roles WHERE rolname = current_user")" = "t" ] \
  || { echo "refusing: PGUSER must be a superuser of the throwaway cluster" >&2; exit 2; }

# --- private pgpass: caller's superuser line + random role passwords ---------
umask 077
: > "$WORK/pgpass"
ROLES="velto_owner velto_app velto_system velto_backup velto_proof_norls"
for r in $ROLES; do
  openssl rand -hex 24 > "$WORK/pw.$r"
  printf '*:*:*:%s:%s\n' "$r" "$(cat "$WORK/pw.$r")" >> "$WORK/pgpass"
done
pw() { cat "$WORK/pw.$1"; }
admin_pw="$(sed -n "s/^[^:]*:[^:]*:[^:]*:${ADMIN}:\(.*\)\$/\1/p" "$PGPASSFILE" | head -n 1)"
[ -n "$admin_pw" ] || { echo "no line for user $ADMIN in PGPASSFILE" >&2; exit 2; }
printf '*:*:*:%s:%s\n' "$ADMIN" "$admin_pw" >> "$WORK/pgpass"
unset admin_pw
export PGPASSFILE="$WORK/pgpass"
if [ -n "${PG_TOOLS_CONTAINER:-}" ]; then
  docker exec -i "$PG_TOOLS_CONTAINER" sh -c "umask 077; cat > $PGPASS_IN" < "$WORK/pgpass"
fi
srv_major="$(q "$ADMIN" postgres -c "SELECT current_setting('server_version_num')::int / 10000")"
tool_major="$(pgt pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
[ "$srv_major" = "$tool_major" ] || { echo "pg_dump major $tool_major != server $srv_major (set PG_TOOLS_CONTAINER)" >&2; exit 2; }
echo "server + pg_dump major: $srv_major"

# --- 1. fresh source DB: roles, migrations -----------------------------------
q "$ADMIN" postgres -c "DROP DATABASE IF EXISTS $DST WITH (FORCE)" -c "DROP DATABASE IF EXISTS $SRC WITH (FORCE)" -c "CREATE DATABASE $SRC"
q "$ADMIN" "$SRC" -v velto_env=dev -f "$HERE/provision-roles.sql" >/dev/null
q "$ADMIN" "$SRC" -f "$HERE/provision-backup-role.sql" >/dev/null
# NOBYPASSRLS reader used only to show why BYPASSRLS is needed.
q "$ADMIN" "$SRC" -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'velto_proof_norls') THEN
  CREATE ROLE velto_proof_norls LOGIN NOBYPASSRLS; END IF; END \$\$" -c "GRANT pg_read_all_data TO velto_proof_norls"
# Passwords via stdin, never argv.
for r in $ROLES; do printf "ALTER ROLE %s PASSWORD '%s';\n" "$r" "$(pw "$r")"; done | q "$ADMIN" postgres >/dev/null

url() { printf 'postgresql://%s:%s@%s:%s/%s?schema=public' "$1" "$(pw "$1")" "$PGHOST" "$PGPORT" "$SRC"; }
(cd "$PKG" && DATABASE_URL="$(url velto_app)" DATABASE_MIGRATE_URL="$(url velto_owner)" pnpm exec prisma migrate deploy >/dev/null)
missing="$(q "$ADMIN" "$SRC" -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S') AND NOT has_table_privilege('velto_backup', c.oid, 'SELECT')")"
[ "$missing" = "0" ] && pass "default privileges: velto_backup can SELECT every table/sequence created by migrations" || fail "velto_backup lacks SELECT on $missing objects"

# --- 2. synthetic data: 3 companies + AuditLog --------------------------------
for slug in proof-a proof-b proof-c; do
  (cd "$PKG" && NODE_ENV=development LOAD_PASSWORD="$(openssl rand -hex 12)" \
    DATABASE_LOAD_URL="$(url velto_app)" DATABASE_LOAD_SYSTEM_URL="$(url velto_system)" \
    pnpm exec tsx src/seed-load.ts --slug="$slug" --agents=3 --skus=40 --outlets=20 --warehouses=2 --orders=150 --chunk=150 >/dev/null)
done
q velto_system "$SRC" -c 'INSERT INTO "AuditLog"(id,"companyId","userId",action,entity,"entityId","newValue",ip,"createdAt")
  SELECT gen_random_uuid(), c.id, (SELECT u.id FROM "User" u WHERE u."companyId" = c.id ORDER BY u.id LIMIT 1),
         $$proof.backup$$, $$Invoice$$, i.id, jsonb_build_object($$n$$, i.number), $$127.0.0.1$$, now()
  FROM (SELECT id, row_number() OVER (ORDER BY id) rn FROM "Company") c
  JOIN LATERAL (SELECT id, number FROM "Invoice" WHERE "companyId" = c.id ORDER BY id LIMIT 20 * c.rn) i ON true' >/dev/null
q "$ADMIN" "$SRC" -F ' ' -c 'SELECT $$companies=$$ || count(*) FROM "Company"' \
  -c 'SELECT $$Invoice=$$||(SELECT count(*) FROM "Invoice"), $$Payment=$$||(SELECT count(*) FROM "Payment"),
       $$PaymentAllocation=$$||(SELECT count(*) FROM "PaymentAllocation"), $$StockMovement=$$||(SELECT count(*) FROM "StockMovement"),
       $$AuditLog=$$||(SELECT count(*) FROM "AuditLog")'

# --- 3. why BYPASSRLS: NOBYPASSRLS reader -------------------------------------
if err="$(pgt pg_dump -w -U velto_proof_norls -d "$SRC" -Fc 2>&1 >/dev/null)"; then
  fail "NOBYPASSRLS pg_dump unexpectedly succeeded"
else
  pass "NOBYPASSRLS (pg_read_all_data) pg_dump fails: $(grep -m1 -o 'ERROR:.*' <<<"$err")"
fi
pgt pg_dump -w -U velto_proof_norls -d "$SRC" -Fc --enable-row-security > "$WORK/norls_ers.dump"
ers_rows="$(pgt pg_restore --data-only -t AuditLog -t Invoice -t Payment -f - < "$WORK/norls_ers.dump" | awk '/^COPY /{on=1;next} /^\\\.$/{on=0;next} on{n++} END{print n+0}')"
[ "$ers_rows" = "0" ] && pass "NOBYPASSRLS --enable-row-security exits 0 but dumps 0 AuditLog/Invoice/Payment rows (silently incomplete)" \
  || fail "--enable-row-security dumped $ers_rows rows"

# --- 4. velto_backup: read-only, negative DML ---------------------------------
dml_priv="$(q "$ADMIN" "$SRC" -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
    AND has_table_privilege('velto_backup', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')")"
[ "$dml_priv" = "0" ] && pass "velto_backup has no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on any table" || fail "velto_backup has write privileges on $dml_priv tables"
ntab="$(q "$ADMIN" "$SRC" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
# Lift the read-only default so the PRIVILEGE check (not read-only) is what rejects.
q "$ADMIN" "$SRC" -c "SELECT format('UPDATE public.%1\$I SET %2\$I = %2\$I WHERE false;
DELETE FROM public.%1\$I WHERE false;
INSERT INTO public.%1\$I SELECT * FROM public.%1\$I WHERE false;
TRUNCATE public.%1\$I;', t.tablename, a.attname)
  FROM pg_tables t JOIN LATERAL (SELECT attname FROM pg_attribute WHERE attrelid = format('public.%I', t.tablename)::regclass
    AND attnum > 0 AND NOT attisdropped ORDER BY attnum LIMIT 1) a ON true WHERE t.schemaname = 'public'" > "$WORK/dml.sql"
denied="$( { echo "SET default_transaction_read_only = off;"; cat "$WORK/dml.sql"; } \
  | psql -X -w -q -U velto_backup -d "$SRC" 2>&1 | grep -c 'permission denied for table' || true)"
[ "$denied" = "$((ntab * 4))" ] && pass "velto_backup DML attempts denied: $denied/$((ntab * 4)) (UPDATE/DELETE/INSERT/TRUNCATE x $ntab tables)" \
  || fail "velto_backup DML denied only $denied/$((ntab * 4))"
ro="$(psql -X -w -q -U velto_backup -d "$SRC" -c 'UPDATE "Invoice" SET total = total WHERE false' 2>&1 || true)"
grep -q 'read-only transaction' <<<"$ro" && pass "velto_backup default session is read-only: $(grep -m1 -o 'ERROR:.*' <<<"$ro")" || fail "default_transaction_read_only not effective: $ro"

# --- 5. dump as velto_backup + globals ----------------------------------------
pgt pg_dump -w -U velto_backup -d "$SRC" -Fc > "$WORK/src.dump"
pass "pg_dump -Fc as velto_backup: $(pgt pg_restore -l < "$WORK/src.dump" | grep -c 'TABLE DATA') TABLE DATA entries"
if pgt pg_dumpall -w -U velto_backup -l "$SRC" --globals-only > "$WORK/g_full.sql" 2>"$WORK/g_err"; then
  fail "pg_dumpall --globals-only (with passwords) unexpectedly worked for non-superuser"
else
  pass "pg_dumpall --globals-only as velto_backup fails: $(grep -m1 -o 'ERROR:.*' "$WORK/g_err")"
fi
pgt pg_dumpall -w -U velto_backup -l "$SRC" --globals-only --no-role-passwords > "$WORK/globals.sql"
pass "pg_dumpall --globals-only --no-role-passwords as velto_backup: $(grep -c '^CREATE ROLE' "$WORK/globals.sql") CREATE ROLE, $(grep -ciE "PASSWORD '|SCRAM-SHA|md5[0-9a-f]{32}" "$WORK/globals.sql" || true) password lines"

# --- 6. restore into an isolated DB (roles already exist in this cluster) -----
q "$ADMIN" postgres -c "CREATE DATABASE $DST"
q "$ADMIN" "$DST" -v velto_env=dev -f "$HERE/provision-roles.sql" >/dev/null
pgt pg_restore -w -U "$ADMIN" -d "$DST" --exit-on-error --single-transaction < "$WORK/src.dump"
pass "pg_restore into $DST (exit-on-error, single transaction)"

# --- 7. verification ----------------------------------------------------------
same() { # label, sql  -> run on SRC and DST as superuser (sees all rows), compare
  local a b; a="$(q "$ADMIN" "$SRC" -c "$2")"; b="$(q "$ADMIN" "$DST" -c "$2")"
  if [ "$a" = "$b" ]; then pass "$1 equal${3:+: $(head -c 200 <<<"$a" | tr '\n' ' ')}"; else fail "$1 differ"; diff <(echo "$a") <(echo "$b") | head -20 >&2 || true; fi
}
same "per-table row counts (all tables)" "SELECT c.relname || '=' || (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY 1"
q "$ADMIN" "$SRC" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'" | sed 's/^/      tables compared: /'
pc_sql="SELECT string_agg(format('SELECT %L AS t, \"companyId\"::text AS c, count(*) AS n FROM public.%I GROUP BY 2', table_name, table_name), ' UNION ALL ') || ' ORDER BY 1, 2'
  FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'companyId'"
pc_query="$(q "$ADMIN" "$SRC" -c "$pc_sql")"
same "per-company counts (every companyId table)" "$pc_query"
for t in Invoice Payment PaymentAllocation StockMovement AuditLog; do
  same "md5 $t" "SELECT count(*) || ' ' || md5(string_agg(x::text, E'\n' ORDER BY x.id)) FROM public.\"$t\" x" show
done
same "RLS ENABLED+FORCED table list" "SELECT string_agg(relname || ':' || relrowsecurity || relforcerowsecurity, ',' ORDER BY relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND relkind = 'r'"
q "$ADMIN" "$DST" -c "SELECT 'RLS on restored DB: ' || count(*) FILTER (WHERE relrowsecurity AND relforcerowsecurity) || '/' || count(*) || ' forced; not forced: ' || coalesce(string_agg(relname, ',') FILTER (WHERE NOT relforcerowsecurity), '-')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND relkind = 'r'" | sed 's/^/      /'
same "policies (count + definitions)" "SELECT count(*) || ' ' || md5(string_agg(tablename || policyname || coalesce(qual,'') || coalesce(with_check,'') || array_to_string(roles, ','), '|' ORDER BY tablename, policyname)) FROM pg_policies WHERE schemaname = 'public'" show
same "triggers" "SELECT count(*) || ' ' || md5(string_agg(tgrelid::regclass::text || '.' || tgname, ',' ORDER BY tgrelid::regclass::text, tgname)) FROM pg_trigger WHERE NOT tgisinternal" show

aid="$(q "$ADMIN" "$DST" -c 'SELECT id FROM "AuditLog" LIMIT 1')"
for op in "UPDATE \"AuditLog\" SET action = 'x' WHERE id = '$aid'" "DELETE FROM \"AuditLog\" WHERE id = '$aid'"; do
  out="$(psql -X -w -q -U velto_system -d "$DST" -c "$op" 2>&1 || true)"
  grep -q 'append-only' <<<"$out" && pass "restored AuditLog trigger blocks (velto_system): $(grep -m1 -o 'ERROR:.*' <<<"$out")" || fail "AuditLog mutation not blocked: $out"
done

read -r A B <<<"$(q "$ADMIN" "$DST" -F ' ' -c 'SELECT (array_agg(id ORDER BY id))[1], (array_agg(id ORDER BY id))[2] FROM "Company"')"
# velto_app inside company A's context must see exactly A's rows (superuser ground
# truth), and never a row of company B (explicit filter on companyId tables).
for t in Invoice Payment PaymentAllocation StockMovement AuditLog Customer; do
  if [ "$t" = PaymentAllocation ]; then
    own="EXISTS (SELECT 1 FROM \"Payment\" p WHERE p.id = x.\"paymentId\" AND p.\"companyId\" = '%s')"
  else
    own="x.\"companyId\" = '%s'"
  fi
  # shellcheck disable=SC2059
  { condA="$(printf "$own" "$A")"; condB="$(printf "$own" "$B")"; }
  seen="$(q velto_app "$DST" -c "BEGIN" -c "SELECT set_config('app.current_company_id', '$A', true)" \
    -c "SELECT count(*) FROM public.\"$t\"" -c "COMMIT" | sed -n 2p)"
  leak="$(q velto_app "$DST" -c "BEGIN" -c "SELECT set_config('app.current_company_id', '$A', true)" \
    -c "SELECT count(*) FROM public.\"$t\" x WHERE $condB" -c "COMMIT" | sed -n 2p)"
  read -r expA expB total <<<"$(q "$ADMIN" "$DST" -F ' ' -c "SELECT count(*) FILTER (WHERE $condA), count(*) FILTER (WHERE $condB), count(*) FROM public.\"$t\" x")"
  if [ "$seen" = "$expA" ] && [ "$expA" != "0" ] && [ "$expB" != "0" ] && [ "$total" -gt "$expA" ] && [ "$leak" = "0" ]; then
    pass "isolation $t: velto_app in company A sees $seen of $total rows (= A's $expA; B has $expB, none visible)"
  else
    fail "isolation $t: seen=$seen expA=$expA expB=$expB total=$total"
  fi
done
none="$(q velto_app "$DST" -c 'SELECT count(*) FROM "Invoice"')"
[ "$none" = "0" ] && pass "velto_app without tenant context sees 0 Invoice rows (fail closed)" || fail "no-context read returned $none"

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED" >&2; exit 1; fi
