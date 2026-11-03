#!/usr/bin/env bash
# Synthetic end-to-end: throwaway postgres:17 container -> backup-run.sh (DB only, as the velto_backup-style read-only BYPASSRLS role)
# -> root-style status attestation -> gate check -> restore into a fresh DB -> row-count comparison. Prints timings and sizes.
# R4: also creates real-shaped financial tables (Invoice, Payment, StockMovement, AuditLog, ...), runs a WRITER during the backup, and proves the encrypted fingerprint equals the
# RESTORED database (same snapshot as the dump) while the live source has moved on. Measures D = backup.sh alone (dump + encrypt + fingerprint + verify) and the fingerprint alone.
# Usage: SIZE_MB=1500 bash deploy/backup/tests/db-e2e-measure.sh      (default 200). Needs docker, pg_dump/psql/pg_restore 17, gpg.
# Honest limits: runs inside Docker Desktop's VM on a laptop, synthetic md5 text (compresses ~2x), no RLS-heavy schema, no network to offsite.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMG="${PG_TEST_IMAGE:-postgres:17}"; SIZE_MB="${SIZE_MB:-200}"
command -v docker >/dev/null && command -v psql >/dev/null || { echo "SKIP: docker/psql missing"; exit 0; }
T="$(mktemp -d)"; NAME="velto-test-pg-$$"; PORT=$((22000 + RANDOM % 2000)); SPW="$(LC_ALL=C tr -dc A-Za-z0-9 < /dev/urandom | head -c 20)"; BPW="$(LC_ALL=C tr -dc A-Za-z0-9 < /dev/urandom | head -c 20)"
trap 'docker rm -f "$NAME" >/dev/null 2>&1; rm -rf "${T:?}"' EXIT
now() { python3 -c 'import time;print(time.time())'; }
dur() { python3 -c "print(round($2-$1,1))"; }
export PGPASSWORD="$SPW"; SU=(psql -X -q -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1)
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:5432" -e POSTGRES_PASSWORD="$SPW" "$IMG" -c fsync=off -c synchronous_commit=off >/dev/null || exit 1
for _ in $(seq 1 60); do "${SU[@]}" -d postgres -c 'select 1' >/dev/null 2>&1 && break; sleep 1; done
"${SU[@]}" -d postgres -c 'create database velto' -c "create role velto_backup login bypassrls password '$BPW' connection limit 2" -c "alter role velto_backup set default_transaction_read_only=on"
ROWS=$(( SIZE_MB * 1024 * 1024 / 330 ))
t0=$(now)
"${SU[@]}" -d velto <<SQL
create table "Item"(id bigserial primary key, "companyId" uuid not null, payload text not null);
alter table "Item" enable row level security; alter table "Item" force row level security;
create policy tenant on "Item" using ("companyId"::text = current_setting('app.current_company_id', true));
insert into "Item"("companyId", payload)
  select (case when g % 2 = 0 then '11111111-1111-4111-8111-111111111111' else '22222222-2222-4222-8222-222222222222' end)::uuid,
         md5(g::text) || md5((g*7)::text) || md5((g*13)::text) || md5((g*31)::text) || md5((g*61)::text) || md5((g*97)::text) || md5((g*131)::text) || md5((g*181)::text)
  from generate_series(1, $ROWS) g;
create index on "Item"("companyId");
grant usage on schema public to velto_backup; grant select on all tables in schema public to velto_backup; grant select on all sequences in schema public to velto_backup;
SQL
"${SU[@]}" -d velto <<SQL
create table "Customer"(id uuid primary key default gen_random_uuid(), "companyId" uuid not null default '11111111-1111-4111-8111-111111111111', name text not null, "cachedBalance" numeric(18,2) not null default 0);
create table "Invoice"(id uuid primary key default gen_random_uuid(), "companyId" uuid not null default '11111111-1111-4111-8111-111111111111', number text not null, total numeric(18,2) not null, status text not null default 'OPEN', "createdAt" timestamp(3) not null default now());
create table "InvoiceLine"(id uuid primary key default gen_random_uuid(), "invoiceId" uuid not null, qty numeric(18,3) not null, "unitPrice" numeric(18,2) not null, "lineTotal" numeric(18,2) not null);
create table "Payment"(id uuid primary key default gen_random_uuid(), "companyId" uuid not null default '11111111-1111-4111-8111-111111111111', number text not null, amount numeric(18,2) not null, status text not null default 'POSTED', "createdAt" timestamp(3) not null default now());
create table "PaymentAllocation"(id uuid primary key default gen_random_uuid(), "paymentId" uuid not null, "invoiceId" uuid not null, amount numeric(18,2) not null);
create table "PaymentReversal"(id uuid primary key default gen_random_uuid(), reason text not null);
create table "PaymentIntentResolution"(id uuid primary key default gen_random_uuid(), note text);
create table "StockMovement"(id uuid primary key default gen_random_uuid(), type text not null, qty numeric(18,3) not null, "createdAt" timestamp(3) not null default now());
create table "GoodsReceiptLine"(id uuid primary key default gen_random_uuid(), qty numeric(18,3) not null, "unitCost" numeric(18,2));
create table "AuditLog"(id uuid primary key default gen_random_uuid(), action text not null, "newValue" jsonb, "createdAt" timestamp(3) not null default now());
insert into "Customer"(name,"cachedBalance") select 'c'||g, g%1000 from generate_series(1,5000) g;
insert into "Invoice"(number,total) select 'INV-'||g, (g%9000)+0.5 from generate_series(1,50000) g;
insert into "InvoiceLine"("invoiceId",qty,"unitPrice","lineTotal") select id, 3, 10.25, 30.75 from "Invoice", generate_series(1,3);
insert into "Payment"(number,amount) select 'PAY-'||g, (g%5000)+0.25 from generate_series(1,50000) g;
insert into "PaymentAllocation"("paymentId","invoiceId",amount) select p.id, i.id, 1.5 from (select id from "Payment" limit 50000) p, lateral (select id from "Invoice" limit 1) i;
insert into "PaymentReversal"(reason) select 'r'||g from generate_series(1,500) g;
insert into "PaymentIntentResolution"(note) select 'n'||g from generate_series(1,500) g;
insert into "StockMovement"(type,qty) select (array['RECEIVE','ISSUE','ADJUST'])[1+g%3], (g%700)+0.125 from generate_series(1,300000) g;
insert into "GoodsReceiptLine"(qty,"unitCost") select g%90+1, g%40+0.5 from generate_series(1,20000) g;
insert into "AuditLog"(action,"newValue") select 'order.create', jsonb_build_object('n', g, 'x', md5(g::text)) from generate_series(1,300000) g;
grant select on all tables in schema public to velto_backup;
SQL
t1=$(now); DBSIZE="$("${SU[@]}" -d velto -tA -c "select pg_size_pretty(pg_database_size('velto'))")"
echo "dataset: $ROWS rows, DB size $DBSIZE (generated in $(dur "$t0" "$t1") s)"
printf '%s' "$(LC_ALL=C tr -dc A-Za-z0-9 < /dev/urandom | head -c 40)" > "$T/pass"; chmod 600 "$T/pass"
mkdir -p "$T/bk" "$T/st"; chmod 750 "$T/bk"; chmod 755 "$T/st"
t2=$(now)
# backup-run.sh refuses to run unless its own dir/scripts are owned by the literal uid 0 (BK_ROOT_UID=0). This non-root harness runs a TEST-ONLY COPY
# (owned by the current user) with that one literal rewritten to the current uid; the production script is untouched and has no env/flag override.
mkdir -p "$T/copy/backup"; cp "$HERE"/*.sh "$T/copy/backup/"; cp "$HERE/../env-file.js" "$T/copy/" 2>/dev/null || true
sed -i.bak "s/^BK_ROOT_UID=0\$/BK_ROOT_UID=$(id -u)/" "$T/copy/backup/backup-run.sh" && rm -f "$T/copy/backup/backup-run.sh.bak"
chmod 755 "$T/copy" "$T/copy/backup"; chmod 755 "$T"/copy/backup/*.sh
( while :; do "${SU[@]}" -d velto -c "insert into \"Payment\"(number,amount) values ('LIVE-'||clock_timestamp(), 777.77)" >/dev/null 2>&1; sleep 0.05; done ) & WRPID=$!   # live writer DURING the backup
BACKUP_ALLOW_NO_FLOCK=1 BACKUP_DIR="$T/bk" BACKUP_STATUS_DIR="$T/st" BACKUP_PASSPHRASE_FILE="$T/pass" OBJECTS_BACKUP_ENABLED=0 \
  DATABASE_BACKUP_URL="postgresql://velto_backup:$BPW@127.0.0.1:$PORT/velto" VELTO_MONITOR_BIN=/nonexistent BACKUP_ALERT_CMD='' \
  bash "$T/copy/backup/backup-run.sh" >"$T/run.log" 2>&1; rc=$?; 
t3=$(now); kill "$WRPID" 2>/dev/null; wait "$WRPID" 2>/dev/null; echo "backup-run.sh rc=$rc in $(dur "$t2" "$t3") s (pg_dump -Fc | gpg AES256 + streaming verify + globals + sha256 + status)"
[[ $rc -eq 0 ]] || { head -n 12 "$T/run.log"; exit 1; }
DUMP="$(ls "$T"/bk/velto-db-*.dump.gpg)"; echo "archive: $(du -h "$DUMP" | cut -f1) ($(wc -c < "$DUMP" | tr -d ' ') bytes) for DB $DBSIZE"
echo "status keys: $(cut -d= -f1 "$T/st/status" | tr '\n' ' ')"
# shellcheck source=../backup-status-lib.sh
. "$HERE/backup-status-lib.sh"
t4=$(now); vbs_check "$T/st/status" "$T/bk" 60 "$(id -u)" 0 && echo "gate: OK (sha256 of the ciphertext re-hashed in $(dur "$t4" "$(now)") s)" || echo "gate: FAIL"
echo "== restore into a fresh DB"
"${SU[@]}" -d postgres -c 'create database velto_restore'
t5=$(now)
gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$T/pass" --decrypt "$DUMP" | pg_restore --no-owner -h 127.0.0.1 -p "$PORT" -U postgres -d velto_restore --exit-on-error; rrc=$?
t6=$(now); echo "restore rc=$rrc in $(dur "$t5" "$t6") s (gpg decrypt + pg_restore, 1 job, fsync=off)"
a="$("${SU[@]}" -d velto -tA -c "set row_security=off; select count(*), md5(string_agg(md5(payload), '' order by id)) from \"Item\"" 2>&1 | tail -n1)"
b="$("${SU[@]}" -d velto_restore -tA -c "set row_security=off; select count(*), md5(string_agg(md5(payload), '' order by id)) from \"Item\"" 2>&1 | tail -n1)"
[[ "$a" == "$b" && -n "$a" ]] && echo "restored == source: $a" || echo "MISMATCH: src=$a restored=$b"
echo "== R4 financial fingerprint: encrypted FP in the set == restored DB (same snapshot as the dump), live source has moved on"
# shellcheck source=../fingerprint-lib.sh
. "$HERE/fingerprint-lib.sh"
FPG="$(ls "$T"/bk/velto-fp-*.txt.gpg)"; gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$T/pass" --decrypt "$FPG" > "$T/fp.exp"
fp_check_shape < "$T/fp.exp" && echo "fp file: ${#FP_TABLES[@]} tables, well formed; $(wc -c < "$FPG" | tr -d ' ') bytes encrypted; plaintext on disk: $(find "$T/bk" "$T/st" -name 'velto-fp-*' ! -name '*.gpg' ! -name '*.sha256' | wc -l | tr -d ' ') file(s)"
fp_compute -h 127.0.0.1 -p "$PORT" -U postgres -d velto_restore > "$T/fp.rest"; echo "restored DB vs encrypted FP: $(fp_compare "$T/fp.exp" "$T/fp.rest" && echo ALL-MATCH || echo DIFF)"
fp_compute -h 127.0.0.1 -p "$PORT" -U postgres -d velto > "$T/fp.src"; echo "live source vs encrypted FP (expected DIFF: writer inserted $("${SU[@]}" -d velto -tA -c "select count(*) from \"Payment\" where number like 'LIVE-%'") Payment rows during the run): $(fp_compare "$T/fp.exp" "$T/fp.src" >/dev/null && echo ALL-MATCH || fp_compare "$T/fp.exp" "$T/fp.src" | tr -s ' ' | cut -c1-200)"
tF0=$(now); fp_compute -h 127.0.0.1 -p "$PORT" -U postgres -d velto_restore > /dev/null; tF1=$(now); echo "fingerprint alone (10 tables, $(grep -c . "$T/fp.exp") lines, all rows hashed): $(dur "$tF0" "$tF1") s"
mkdir -p "$T/bk2"; chmod 750 "$T/bk2"; tD0=$(now)
BACKUP_DIR="$T/bk2" BACKUP_PASSPHRASE_FILE="$T/pass" DATABASE_BACKUP_URL="postgresql://velto_backup:$BPW@127.0.0.1:$PORT/velto" bash "$HERE/backup.sh" >"$T/d.log" 2>&1; drc=$?; tD1=$(now)
echo "D = backup.sh alone (snapshot + pg_dump + gpg AES256 + fingerprint + streaming verify + globals + sha256): rc=$drc $(dur "$tD0" "$tD1") s for DB $DBSIZE"
echo "orphan snapshot holders after the run (idle in transaction, velto_backup): $("${SU[@]}" -d postgres -tA -c "select count(*) from pg_stat_activity where usename='velto_backup' and state like 'idle in transaction%'")"
echo "globals: $(gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$T/pass" --decrypt "$(ls "$T"/bk/velto-globals-*.sql.gpg)" | grep -c 'CREATE ROLE') CREATE ROLE line(s), passwords included: $(gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$T/pass" --decrypt "$(ls "$T"/bk/velto-globals-*.sql.gpg)" | grep -c 'PASSWORD')"
