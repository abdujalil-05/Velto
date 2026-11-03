#!/usr/bin/env bash
# Synthetic end-to-end: throwaway postgres:17 container -> backup-run.sh (DB only, as the velto_backup-style read-only BYPASSRLS role)
# -> root-style status attestation -> gate check -> restore into a fresh DB -> row-count comparison. Prints timings and sizes.
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
BACKUP_DIR="$T/bk" BACKUP_STATUS_DIR="$T/st" BACKUP_PASSPHRASE_FILE="$T/pass" OBJECTS_BACKUP_ENABLED=0 \
  DATABASE_BACKUP_URL="postgresql://velto_backup:$BPW@127.0.0.1:$PORT/velto" VELTO_MONITOR_BIN=/nonexistent BACKUP_ALERT_CMD='' \
  bash "$T/copy/backup/backup-run.sh" >"$T/run.log" 2>&1; rc=$?; 
t3=$(now); echo "backup-run.sh rc=$rc in $(dur "$t2" "$t3") s (pg_dump -Fc | gpg AES256 + streaming verify + globals + sha256 + status)"
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
echo "globals: $(gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$T/pass" --decrypt "$(ls "$T"/bk/velto-globals-*.sql.gpg)" | grep -c 'CREATE ROLE') CREATE ROLE line(s), passwords included: $(gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$T/pass" --decrypt "$(ls "$T"/bk/velto-globals-*.sql.gpg)" | grep -c 'PASSWORD')"
