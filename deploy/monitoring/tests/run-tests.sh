#!/usr/bin/env bash
# shellcheck disable=SC2034  # RC/rc are read inside eval-ed assert expressions
# Static-stub test harness for velto-monitor.sh and pm2-status-export.sh. No network, no real services: PATH shims
# for curl, redis-cli, openssl, psql, df, pm2, mail. Usage: bash deploy/monitoring/tests/run-tests.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; MON="$HERE/../velto-monitor.sh"; EXP="$HERE/../pm2-status-export.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
SHIM="$T/shim"; S="$T/stub"; ST="$T/state"; mkdir -p "$SHIM" "$S" "$ST"
PASS=0; FAILN=0
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
assert() { if eval "$2"; then ok; else bad "$1"; fi; }  # name, test-expression

# ---- shims (behaviour controlled by files in $S) ----
cat > "$SHIM/curl" <<'SH'
#!/usr/bin/env bash
args=("$@"); url=""; w=""; o=""; stdin=""; usek=0
for ((i=0;i<${#args[@]};i++)); do case "${args[$i]}" in -w) w="${args[$((i+1))]}";; -o) o="${args[$((i+1))]}";; -K) usek=1;; http*) url="${args[$i]}";; esac; done
[[ $usek == 1 ]] && stdin="$(cat)"
echo "ARGS: $* STDIN: $stdin" >> "$STUB/curl.log"
tag=other
[[ "$stdin" == *api.telegram.org* ]] && tag=tg; [[ "$stdin" == *hook.test* ]] && tag=hook
[[ "$url" == *health* ]] && tag=health; [[ "$url" == *public.test* ]] && tag=public; [[ "$url" == *s3.test* ]] && tag=s3
code="$(cat "$STUB/$tag.code" 2>/dev/null || echo 200)"; body="$(cat "$STUB/$tag.body" 2>/dev/null || true)"
[[ "$o" == "-" || -z "$o" ]] && printf '%s' "$body"
printf '%s' "${w//\%\{http_code\}/$code}"
SH
cat > "$SHIM/redis-cli" <<'SH'
#!/usr/bin/env bash
echo "AUTH=${REDISCLI_AUTH:-} ARGS: $*" >> "$STUB/redis.log"
for a in "$@"; do last="$a"; done
case " $* " in *" PING "*) cat "$STUB/redis.ping" 2>/dev/null || echo PONG;;
  *) k="${last//[:\/]/_}"; cat "$STUB/redis.$k" 2>/dev/null || echo 0;; esac
SH
cat > "$SHIM/openssl" <<'SH'
#!/usr/bin/env bash
case "$1" in s_client) exit 0;; x509) cat >/dev/null; echo "notAfter=$(cat "$STUB/tls.end")";; esac
SH
cat > "$SHIM/psql" <<'SH'
#!/usr/bin/env bash
echo "ARGS: $*" >> "$STUB/psql.log"; [[ -e "$STUB/psql.fail" ]] && exit 2; cat "$STUB/psql.row"
SH
cat > "$SHIM/df" <<'SH'
#!/usr/bin/env bash
echo "Filesystem 1024-blocks Used Available Capacity Mounted"; echo "x 100 50 50 $(cat "$STUB/df.pct")% /"
SH
cat > "$SHIM/pm2" <<'SH'
#!/usr/bin/env bash
cat "$STUB/pm2.json"
SH
cat > "$SHIM/mail" <<'SH'
#!/usr/bin/env bash
echo "ARGS: $* BODY: $(cat)" >> "$STUB/mail.log"; [[ -e "$STUB/mail.fail" ]] && exit 1; exit 0
SH
chmod +x "$SHIM"/*

HEALTH_OK='{"status":"up","checks":{"db":"up","redis":"up","storage":"up"}}'
NOW="$(date +%s)"
fmt_end() { if date -d "+$1 days" >/dev/null 2>&1; then date -u -d "+$1 days" '+%b %e %T %Y GMT'; else date -u -v+"$1"d '+%b %e %T %Y GMT'; fi; }

reset() { # fresh stubs + env file
  rm -rf "$S" "$ST"; mkdir -p "$S" "$ST"; MODE_ARGS=--dry-run
  printf 'MemTotal: 1000000 kB\nMemAvailable: 500000 kB\n' > "$T/meminfo"
  echo 200 > "$S/health.code"; printf '%s' "$HEALTH_OK" > "$S/health.body"; echo 40 > "$S/df.pct"
  echo '{"ok":true}' > "$S/tg.body"; echo 200 > "$S/tg.code"
  printf 'ts=%s\nresult=ok\noffsite_ts=%s\noffsite_result=ok\n' "$((NOW-600))" "$((NOW-600))" > "$T/bstatus"
  cat > "$T/env" <<ENV
OPS_TG_BOT_TOKEN=111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
OPS_TG_CHAT_ID=-1001
VELTO_API_HEALTH_URL=https://h.test/health/ready
MONITOR_STATE_DIR=$ST
MONITOR_HOST_LABEL=testhost
NGINX_ACCESS_LOG=/nonexistent
MONITOR_BACKUP_STATUS_FILE=$T/bstatus
MONITOR_MEMINFO=$T/meminfo
MONITOR_DISK_PATHS=/
ENV
}
# run <extra env lines...>; output in $OUT, rc in $RC. Mode from $MODE_ARGS (default --dry-run).
run() { local e="$T/env.run"; cp "$T/env" "$e"; for l in "$@"; do echo "$l" >> "$e"; done
  OUT="$(env -i PATH="$SHIM:/usr/bin:/bin" HOME="$T" STUB="$S" bash "$MON" ${MODE_ARGS---dry-run} --env "$e" 2>&1)"; RC=$?; }
row() { printf '%s\n' "$OUT" | grep -E "^$1 +$2( |$)" >/dev/null; }  # row <check> <STATUS>
chk() { if row "$2" "$3"; then ok; else bad "$1 (wanted $2 $3) :: $(printf '%s' "$OUT" | grep -E "^$2 " | head -1)"; fi; }

# ===== health_ready / redis+storage in body =====
reset; run; chk "health ok" health_ready OK; chk "health redis ok" health_redis OK; chk "health storage ok" health_storage OK
reset; echo 503 > "$S/health.code"; run; chk "health 503" health_ready FAIL
reset; printf '%s' '<html>hi</html>' > "$S/health.body"; run; chk "health html" health_ready FAIL
reset; printf '%s' '{"status":"up","checks":{"db":"up","redis":"down","storage":"up"}}' > "$S/health.body"; run; chk "health redis down" health_redis FAIL
reset; printf '%s' '{"status":"up","checks":{"db":"up","redis":"up","storage":"down"}}' > "$S/health.body"; run; chk "health storage down" health_storage FAIL

# ===== public https =====
reset; run MONITOR_PUBLIC_URL=https://public.test/; chk "public unset-ok" public_https OK
reset; echo 502 > "$S/public.code"; run MONITOR_PUBLIC_URL=https://public.test/; chk "public 502" public_https FAIL
reset; run; chk "public skip" public_https SKIP

# ===== TLS (ok / warn <21 / crit <7) =====
reset; fmt_end 60 > "$S/tls.end"; run MONITOR_TLS_HOST=x.test; chk "tls ok" tls OK
reset; fmt_end 15 > "$S/tls.end"; run MONITOR_TLS_HOST=x.test; chk "tls warn" tls WARN
reset; fmt_end 3 > "$S/tls.end"; run MONITOR_TLS_HOST=x.test; chk "tls crit" tls FAIL

# ===== disk (ok / warn / crit) + memory =====
reset; run; chk "disk ok" 'disk:/' OK
reset; echo 85 > "$S/df.pct"; run; chk "disk warn" 'disk:/' WARN
reset; echo 95 > "$S/df.pct"; run; chk "disk crit" 'disk:/' FAIL
reset; run; chk "mem ok" memory OK
reset; printf 'MemTotal: 1000000 kB\nMemAvailable: 30000 kB\n' > "$T/meminfo"; run; chk "mem crit" memory FAIL

# ===== backup status file contract (ts/result/offsite_ts/offsite_result) =====
reset; run; chk "backup ok" backup OK; chk "offsite ok" backup_offsite OK
reset; printf 'ts=%s\nresult=ok\noffsite_ts=%s\noffsite_result=ok\n' "$((NOW-110*60))" "$((NOW-600))" > "$T/bstatus"; run; chk "backup stale >100m" backup FAIL
reset; printf 'ts=%s\nresult=ok\noffsite_ts=%s\noffsite_result=ok\n' "$((NOW-90*60))" "$((NOW-170*60))" > "$T/bstatus"; run; chk "backup 90m ok (default 100)" backup OK; chk "offsite 170m ok (default 180)" backup_offsite OK
reset; printf 'ts=%s\nresult=ok\noffsite_ts=%s\noffsite_result=ok\n' "$((NOW-60))" "$((NOW-190*60))" > "$T/bstatus"; run; chk "offsite 190m stale (default 180)" backup_offsite FAIL
reset; printf 'ts=%s\nresult=failed\noffsite_ts=%s\noffsite_result=ok\n' "$((NOW-60))" "$((NOW-60))" > "$T/bstatus"; run; chk "backup result!=ok" backup FAIL
reset; printf 'ts=%s\nresult=ok\noffsite_ts=%s\noffsite_result=ok\n' "$((NOW-60))" "$((NOW-2000*60))" > "$T/bstatus"; run; chk "offsite stale" backup_offsite FAIL
reset; printf 'ts=%s\nresult=ok\noffsite_ts=%s\noffsite_result=error\n' "$((NOW-60))" "$((NOW-60))" > "$T/bstatus"; run; chk "offsite result=error" backup_offsite FAIL
reset; printf 'ts=%s\nresult=ok\n' "$((NOW-60))" > "$T/bstatus"; run; chk "offsite fields missing" backup_offsite FAIL
reset; rm "$T/bstatus"; run; chk "status file missing" backup FAIL
reset; printf 'ts=%s\nresult=ok\noffsite_ts=%s\noffsite_result=ok\n' "$((NOW+99999))" "$((NOW-60))" > "$T/bstatus"; run; chk "backup future ts" backup FAIL
reset; run MONITOR_BACKUP_MAX_AGE_MINUTES=5; chk "backup configurable max" backup FAIL

# ===== Redis / BullMQ =====
reset; run MONITOR_REDIS_USER=velto_monitor MONITOR_REDIS_PASSWORD=sekret-redis-pw; chk "redis ok" redis OK; chk "queue ok" 'queue:import-commit' OK
assert "redis password not in argv (env only)" '! grep -q "ARGS:.*sekret-redis-pw" "$S/redis.log" && grep -q "AUTH=sekret-redis-pw" "$S/redis.log"'
reset; echo 12 > "$S/redis.bull_import-commit_failed"; run MONITOR_REDIS_PASSWORD=x; chk "queue failed >=10" 'queue:import-commit' FAIL
reset; echo 500 > "$S/redis.bull_1c-export_wait"; run MONITOR_REDIS_PASSWORD=x; chk "queue backlog" 'queue:1c-export' FAIL
reset; echo "(error) NOAUTH" > "$S/redis.ping"; run MONITOR_REDIS_PASSWORD=x; chk "redis no pong" redis FAIL
reset; echo garbage > "$S/redis.bull_company-export_failed"; run MONITOR_REDIS_PASSWORD=x; chk "queue bad reply" 'queue:company-export' FAIL
reset; run; chk "redis skip" redis SKIP

# ===== S3 anonymous =====
reset; echo 403 > "$S/s3.code"; run MONITOR_S3_PUBLIC_URL=https://s3.test/bucket; chk "s3 denied ok" s3_anon_denied OK
reset; echo 200 > "$S/s3.code"; run MONITOR_S3_PUBLIC_URL=https://s3.test/bucket; chk "s3 public crit" s3_anon_denied FAIL
reset; echo 000 > "$S/s3.code"; run MONITOR_S3_PUBLIC_URL=https://s3.test/bucket; chk "s3 unreachable" s3_anon_denied FAIL

# ===== PM2 snapshot =====
mkpm2() { printf 'ts=%s\nproc.velto-api.status=%s\nproc.velto-api.restarts=%s\n' "$1" "$2" "$3" > "$T/pm2status"; }
reset; mkpm2 "$((NOW-30))" online 2; run MONITOR_PM2_STATUS_FILE="$T/pm2status"; chk "pm2 ok" pm2 OK
reset; mkpm2 "$((NOW-30))" errored 2; run MONITOR_PM2_STATUS_FILE="$T/pm2status"; chk "pm2 not online" pm2 FAIL
reset; mkpm2 "$((NOW-3000))" online 2; run MONITOR_PM2_STATUS_FILE="$T/pm2status"; chk "pm2 stale" pm2 FAIL
reset; run MONITOR_PM2_STATUS_FILE="$T/nope"; chk "pm2 missing file" pm2 FAIL
reset; mkpm2 "$((NOW-30))" online 2; MODE_ARGS=; run MONITOR_PM2_STATUS_FILE="$T/pm2status" >/dev/null 2>&1; mkpm2 "$((NOW-30))" online 6; run MONITOR_PM2_STATUS_FILE="$T/pm2status"; chk "pm2 restart spike" pm2 FAIL

# ===== PM2 exporter (pm2 shim + node) =====
reset; echo '[{"name":"velto-api","pm2_env":{"status":"online","restart_time":4,"env":{"SECRET":"x"}}}]' > "$S/pm2.json"
if command -v node >/dev/null; then
  env PATH="$SHIM:$PATH" STUB="$S" PM2_STATUS_FILE="$T/exp.out" bash "$EXP"; rc=$?
  assert "exporter rc=0" '[[ $rc -eq 0 ]]'
  assert "exporter fields" 'grep -q "^proc.velto-api.status=online$" "$T/exp.out" && grep -q "^proc.velto-api.restarts=4$" "$T/exp.out" && grep -q "^ts=[0-9]*$" "$T/exp.out"'
  assert "exporter leaks no env" '! grep -q SECRET "$T/exp.out"'
else echo "SKIP exporter tests (node missing)"; fi

# ===== DB jobs + connections =====
reset; echo "0 0 0 0 7" > "$S/psql.row"; run MONITOR_DB_NAME=velto MONITOR_DB_USER=velto_monitor MONITOR_DB_PASSWORD=pgsecret; chk "jobs ok" jobs_stuck OK; chk "jobs_failed ok" jobs_failed OK
assert "pg password not in argv" '! grep -q pgsecret "$S/psql.log"'
reset; echo "2 0 0 9 7" > "$S/psql.row"; run MONITOR_DB_NAME=velto MONITOR_DB_USER=velto_monitor; chk "jobs stuck" jobs_stuck FAIL; chk "jobs failed" jobs_failed FAIL
reset; touch "$S/psql.fail"; run MONITOR_DB_NAME=velto MONITOR_DB_USER=velto_monitor; chk "db query fails" jobs_stuck FAIL

# ===== alert channel separation =====
reset; MODE_ARGS=--test-alert; run TELEGRAM_BOT_TOKEN=111111:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
assert "same bot id blocked (rc!=0, nothing sent)" '[[ $RC -ne 0 ]] && [[ ! -s "$S/curl.log" ]] && grep -q "same bot" <<<"$OUT"'
reset; MODE_ARGS=--test-alert; run OPS_TG_CHAT_ID=-555 TELEGRAM_CHAT_ID=-555
assert "same chat blocked" '[[ $RC -ne 0 ]] && [[ ! -s "$S/curl.log" ]]'
reset; printf 'TELEGRAM_BOT_TOKEN="111111:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"\n' > "$T/app.env"; MODE_ARGS=--test-alert; run MONITOR_APP_ENV_FILE="$T/app.env"
assert "app env file same bot blocked, token not printed" '[[ $RC -ne 0 ]] && ! grep -q CCCCCCCC <<<"$OUT"'
reset; printf 'TELEGRAM_BOT_TOKEN=111111:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE # business bot\n' > "$T/app.env"; MODE_ARGS=--test-alert; run MONITOR_APP_ENV_FILE="$T/app.env"
assert "inline comment in app env stripped: same bot still blocked, warning shown" '[[ $RC -ne 0 ]] && grep -q "inline comment" <<<"$OUT" && ! grep -q EEEEEEEE <<<"$OUT"'
reset; MODE_ARGS=--test-alert; run TELEGRAM_BOT_TOKEN=222222:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD
assert "different bot allowed" '[[ $RC -eq 0 ]] && grep -q api.telegram.org "$S/curl.log"'
reset; MODE_ARGS=; run TELEGRAM_BOT_TOKEN=111111:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB; chk "config row alert_channel FAIL" alert_channel FAIL

# ===== --test-alert marking + delivery =====
reset; MODE_ARGS=--test-alert; run
assert "test alert rc=0 and marked" '[[ $RC -eq 0 ]] && grep -q "TEST ALERT - NOT A REAL INCIDENT" "$S/curl.log"'
reset; echo '{"ok":false}' > "$S/tg.body"; MODE_ARGS=--test-alert; run
assert "test alert undelivered -> rc!=0" '[[ $RC -ne 0 ]]'
reset; MODE_ARGS=--test-alert; run OPS_TG_BOT_TOKEN= OPS_TG_CHAT_ID= MONITOR_ALERT_EMAIL=ops@example.test
assert "email channel works alone" '[[ $RC -eq 0 ]] && grep -q "TEST ALERT" "$S/mail.log"'
reset; MODE_ARGS=--test-alert; run OPS_TG_BOT_TOKEN= OPS_TG_CHAT_ID= MONITOR_ALERT_WEBHOOK_URL=https://hook.test/x?k=1
assert "webhook channel works alone (url via stdin)" '[[ $RC -eq 0 ]] && grep -q "hook.test" "$S/curl.log"'
reset; MODE_ARGS=--test-alert; run OPS_TG_BOT_TOKEN= OPS_TG_CHAT_ID=
assert "no channel -> rc!=0" '[[ $RC -ne 0 ]]'

# ===== redaction + real alert path =====
reset; BAD='tok 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd ph +998901234567 mail a.b@corp.uz https://x.uz/p?otp=1 password=hunter2 OTP: 482910 Authorization: Bearer abc123'
OUT="$(env -i PATH="$SHIM:/usr/bin:/bin" HOME="$T" STUB="$S" bash "$MON" --alert leaktest "$BAD" --env "$T/env" 2>&1)"; RC=$?
assert "alert delivered" '[[ $RC -eq 0 ]]'
assert "redaction: no secret/PII reaches curl" '! grep -Eq "123456789:ABC|998901234567|a\.b@corp|hunter2|482910|abc123|x\.uz" <(sed "s/STDIN:.*//" "$S/curl.log")'
assert "redaction: markers present" 'grep -q "redacted" "$S/curl.log" && grep -q "%3Curl%3E\|<url>" "$S/curl.log"'
# check detail with PII-like content in monitor-produced message
reset; echo 503 > "$S/health.code"; MODE_ARGS=; run
assert "run alert sent with CRIT prefix + host label, exit 1" '[[ $RC -eq 1 ]] && grep -q "CRIT" "$S/curl.log" && grep -q "testhost" "$S/curl.log"'
assert "bot token only in stdin config, not in argv" '! sed "s/STDIN:.*//" "$S/curl.log" | grep -q AAAAAAAA'
# dedup: second identical run does not resend
: > "$S/curl.log"; run
assert "dedup: no resend of identical failure" '! grep -q sendMessage "$S/curl.log"'
# recovery
echo 200 > "$S/health.code"; run
assert "recovered message sent" 'grep -q "RECOVERED" "$S/curl.log"'
# env loader is data-only: never executes the file, refuses unsafe owner/mode/malformed lines
reset; MODE_ARGS=--dry-run; run 'MONITOR_HOST_LABEL=$(touch '"$T"'/pwned)'
assert "env value with \$(...) is data, never executed" '[[ ! -e "$T/pwned" ]]'
reset; MODE_ARGS=--dry-run; run '$(touch '"$T"'/pwned2)'
assert "malicious non-KEY=VALUE line refused (rc=2), not executed" '[[ $RC -eq 2 && ! -e "$T/pwned2" ]]'
reset; MODE_ARGS=--dry-run; run 'export MONITOR_HOST_LABEL=x'
assert "export-syntax line refused" '[[ $RC -eq 2 ]]'
reset; MODE_ARGS=--dry-run; run 'MONITOR_HOST_LABEL=x # c'
assert "inline comment after unquoted value refused" '[[ $RC -eq 2 ]]'
reset; MODE_ARGS=--dry-run; run; chmod 664 "$T/env.run"
OUT="$(env -i PATH="$SHIM:/usr/bin:/bin" HOME="$T" STUB="$S" bash "$MON" --dry-run --env "$T/env.run" 2>&1)"; RC=$?
assert "group-writable env file refused" '[[ $RC -eq 2 && "$OUT" == *"writable"* ]]'
chmod 646 "$T/env.run"; OUT="$(env -i PATH="$SHIM:/usr/bin:/bin" HOME="$T" STUB="$S" bash "$MON" --dry-run --env "$T/env.run" 2>&1)"; RC=$?
assert "other-writable env file refused" '[[ $RC -eq 2 ]]'
rm -f "$T/env.run"
reset; MODE_ARGS=--dry-run; run; mkdir -p "$T/gw"; chmod 775 "$T/gw"; cp "$T/env.run" "$T/gw/env"; chmod 600 "$T/gw/env"
OUT="$(env -i PATH="$SHIM:/usr/bin:/bin" HOME="$T" STUB="$S" bash "$MON" --dry-run --env "$T/gw/env" 2>&1)"; RC=$?
assert "env file in group-writable parent dir refused" '[[ $RC -eq 2 && "$OUT" == *"ancestor"* ]]'
ln -sf "$T/env.run" "$T/env.link"
OUT="$(env -i PATH="$SHIM:/usr/bin:/bin" HOME="$T" STUB="$S" bash "$MON" --dry-run --env "$T/env.link" 2>&1)"; RC=$?
assert "symlinked env file refused" '[[ $RC -eq 2 && "$OUT" == *"symlink"* ]]'
rm -rf "$T/env.run" "$T/env.link" "$T/gw"
# warn-only: alert but exit 0
reset; echo 85 > "$S/df.pct"; MODE_ARGS=; run
assert "warn-only alerts but rc=0" '[[ $RC -eq 0 ]] && grep -q "WARN" "$S/curl.log"'

echo "passed=$PASS failed=$FAILN"; [[ $FAILN -eq 0 ]]
