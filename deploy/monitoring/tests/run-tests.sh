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
a=(); U=default; while [[ $# -gt 0 ]]; do case "$1" in -h|-p) shift 2;; --user) U="$2"; shift 2;; --no-auth-warning) shift;; *) a+=("$1"); shift;; esac; done
echo "${a[*]}" >> "$STUB/redis.cmds"
cmd="${a[0]}"; r="$STUB/r"
[[ -e "$STUB/redis.err.$cmd" ]] && exit 1   # connection-level error: no output, rc!=0
[[ "$cmd" == ACL && "${a[1]:-}" == WHOAMI ]] && { cat "$STUB/redis.whoami" 2>/dev/null || echo "$U"; exit 0; }
[[ "$cmd" == PING ]] && { cat "$STUB/redis.ping" 2>/dev/null || echo PONG; exit 0; }
san() { printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_'; }
f2="$r/$cmd.$(san "${a[1]:-}")"; f3="$f2.$(san "${a[2]:-}")"
if [[ "$cmd" == XRANGE && "${a[2]:-}" == \(* ]]; then   # paging: first page returns the stub, the next page is empty (like a real stream end)
  m="$r/.x.$(san "${a[1]}")"; [[ -e "$m" ]] && exit 0; mkdir -p "$r"; : > "$m"; [[ -f "$f2" ]] && cat "$f2"; exit 0
fi
if [[ -f "$f3" ]]; then cat "$f3"; elif [[ -f "$f2" ]]; then cat "$f2"
else case "$cmd" in LLEN|ZCARD|XLEN) echo 0;; EXISTS) echo 1;; esac; fi
exit 0
SH
cat > "$SHIM/openssl" <<'SH'
#!/usr/bin/env bash
case "$1" in s_client) exit 0;; x509) cat >/dev/null; echo "notAfter=$(cat "$STUB/tls.end")";; esac
SH
cat > "$SHIM/psql" <<'SH'
#!/usr/bin/env bash
echo "ARGS: $*" >> "$STUB/psql.log"; [[ -e "$STUB/psql.fail" ]] && exit 2
if [[ "$*" == *"LIMIT 200"* ]]; then cat "$STUB/psql.ids" 2>/dev/null; exit 0; fi
cat "$STUB/psql.row"
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
  printf 'ts=%s\nresult=ok\nrestore_point_ts=%s\noffsite_restore_point_ts=%s\noffsite_ts=%s\noffsite_result=ok\n' "$((NOW-600))" "$((NOW-600))" "$((NOW-600))" "$((NOW-600))" > "$T/bstatus"
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
run() { local e="$T/env.run"; cp "$T/env" "$e"; rm -f "$S"/r/.x.* 2>/dev/null; for l in "$@"; do echo "$l" >> "$e"; done
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

# ===== backup status file contract (local: ts/result; offsite: offsite_restore_point_ts/offsite_ts/offsite_result) =====
bst() { printf 'ts=%s\nresult=ok\nrestore_point_ts=%s\noffsite_restore_point_ts=%s\noffsite_ts=%s\noffsite_result=%s\n' "$1" "$1" "$2" "$3" "${4:-ok}" > "$T/bstatus"; }
reset; run; chk "backup ok" backup OK; chk "offsite rpo ok" backup_offsite_rpo OK; chk "offsite upload ok" backup_offsite_upload OK
reset; bst "$((NOW-110*60))" "$((NOW-600))" "$((NOW-60))"; run; chk "backup stale >100m" backup FAIL
reset; printf 'ts=%s\nresult=failed\n' "$((NOW-60))" > "$T/bstatus"; run; chk "backup result!=ok" backup FAIL
reset; bst "$((NOW-60))" "$((NOW-60))" "$((NOW+99999))"; run; chk "backup future ts" backup OK
reset; printf 'ts=%s\nresult=ok\n' "$((NOW+99999))" > "$T/bstatus"; run; chk "backup future ts crit" backup FAIL
reset; run MONITOR_BACKUP_MAX_AGE_MINUTES=5; chk "backup configurable max" backup FAIL
reset; bst "$((NOW-60))" "$((NOW-39*60))" "$((NOW-60))"; run; chk "offsite rpo 39m ok" backup_offsite_rpo OK
reset; bst "$((NOW-60))" "$((NOW-41*60))" "$((NOW-60))"; run; chk "offsite rpo 41m WARN" backup_offsite_rpo WARN
reset; bst "$((NOW-60))" "$((NOW-51*60))" "$((NOW-60))"; run; chk "offsite rpo 51m CRIT" backup_offsite_rpo FAIL
reset; bst "$((NOW-60))" "$((NOW-45*60))" "$((NOW-60))"; run MONITOR_OFFSITE_RPO_WARN_MINUTES=44 MONITOR_OFFSITE_RPO_CRIT_MINUTES=46; chk "offsite rpo thresholds configurable" backup_offsite_rpo WARN
reset; printf 'ts=%s\nresult=ok\noffsite_ts=%s\noffsite_result=ok\n' "$((NOW-60))" "$((NOW-60))" > "$T/bstatus"; run; chk "old status without restore point = CRIT" backup_offsite_rpo FAIL
assert "missing copy message" 'grep -q "no confirmed restore point" <<<"$OUT"'
reset; printf 'ts=%s\nresult=ok\n' "$((NOW-60))" > "$T/bstatus"; run; chk "offsite fields missing rpo" backup_offsite_rpo FAIL; chk "offsite fields missing upload" backup_offsite_upload FAIL
reset; bst "$((NOW-60))" "abc" "$((NOW-60))"; run; chk "corrupted restore point (text)" backup_offsite_rpo FAIL
reset; bst "$((NOW-60))" "-5" "$((NOW-60))"; run; chk "corrupted restore point (negative)" backup_offsite_rpo FAIL
reset; bst "$((NOW-60))" "$((NOW+99999))" "$((NOW-60))"; run; chk "restore point in the future" backup_offsite_rpo FAIL
reset; bst "$((NOW-60))" "$((NOW-60))" "x" "garbage"; run; chk "corrupted offsite_result" backup_offsite_upload FAIL; chk "corrupted offsite_ts ignored, rpo ok" backup_offsite_rpo OK
reset; bst "$((NOW-60))" "$((NOW-60))" "$((NOW-60))" failed; run; chk "upload failed CRIT" backup_offsite_upload FAIL; chk "upload failed, rpo separate OK" backup_offsite_rpo OK
reset; rm "$T/bstatus"; run; chk "status file missing backup" backup FAIL; chk "status file missing rpo" backup_offsite_rpo FAIL; chk "status file missing upload" backup_offsite_upload FAIL
assert "old MONITOR_OFFSITE_MAX_AGE_MINUTES path removed" '! grep -q OFFSITE_MAX_AGE "$MON"'

# ===== Redis / BullMQ (read-only checks; stub keys in $S/r/<CMD>.<sanitized args>) =====
P=velto-pilot; KI="${P}_import-commit"; KN="${P}_notification-telegram"
rs() { mkdir -p "$S/r"; printf '%s\n' "$2" > "$S/r/$1"; }          # rs <stub-file-name> <content>
ev() { local id="$1" name="$2" jid="${3:-jx1}"; printf '%s\nevent\n%s\njobId\n%s\n' "$id" "$name" "$jid"; }   # one stream entry
QENV=(MONITOR_REDIS_PASSWORD=sekret-redis-pw MONITOR_REDIS_USER=velto_monitor MONITOR_BULLMQ_PREFIX="$P" MONITOR_NOWORKER_PROBE_SECONDS=0 "MONITOR_QUEUES=import-commit notification-telegram")
qrun() { run "${QENV[@]}" "$@"; }
ms() { echo $(( $1 * 1000 )); }
reset; qrun MONITOR_REDIS_USER=velto_monitor; chk "redis ok" redis OK; chk "queue healthy import" 'queue:import-commit' OK; chk "queue healthy notif" 'queue:notification-telegram' OK
assert "redis password not in argv (env only)" '! grep -q "ARGS:.*sekret-redis-pw" "$S/redis.log" && grep -q "AUTH=sekret-redis-pw" "$S/redis.log"'
assert "queue keys use the configured prefix" 'grep -q "EXISTS velto-pilot:import-commit:meta" "$S/redis.log"'
reset; run MONITOR_REDIS_USER=velto_monitor MONITOR_REDIS_PASSWORD=x MONITOR_QUEUES=import-commit; chk "prefix unset = FAIL, no default" queue_prefix FAIL
assert "prefix unset: no queue key read" '! grep -q "EXISTS bull:" "$S/redis.log"'
reset; rs "EXISTS.${KI}_meta" 0; qrun; chk "prefix mismatch -> queue_meta CRIT" 'queue_meta:import-commit' FAIL; chk "other queue still checked" 'queue:notification-telegram' OK
assert "meta mismatch is never a false OK for that queue" '! row "queue:import-commit" OK'
reset; echo "(error) NOAUTH" > "$S/redis.ping"; qrun; chk "redis no pong" redis FAIL; chk "queues SKIP when redis down" queues SKIP
assert "redis down: no queue OK row" '! row "queue:import-commit" OK'
reset; rs "LLEN.${KI}_wait" 3; rs "LINDEX.${KI}_wait.-1" jobA1; rs "HGET.${KI}_jobA1.timestamp" "$(ms $((NOW-60)))"; rs "EXISTS.${KI}_stalled-check" 0; qrun
chk "waiting + no worker CRIT" 'queue_no_worker:import-commit' FAIL
reset; rs "LLEN.${KI}_wait" 3; rs "LINDEX.${KI}_wait.-1" jobA1; rs "HGET.${KI}_jobA1.timestamp" "$(ms $((NOW-60)))"; qrun
chk "waiting with live worker heartbeat = OK" 'queue:import-commit' OK
reset; rs "EXISTS.${KI}_stalled-check" 0; qrun; chk "no jobs waiting + no heartbeat = no alert" 'queue:import-commit' OK
reset; rs "LLEN.${KI}_wait" 2; rs "LINDEX.${KI}_wait.-1" jobA1; rs "HGET.${KI}_jobA1.timestamp" "$(ms $((NOW-12*60)))"; qrun; chk "wait age 12m WARN" 'queue_wait_age:import-commit' WARN
rs "HGET.${KI}_jobA1.timestamp" "$(ms $((NOW-35*60)))"; qrun; chk "wait age 35m CRIT" 'queue_wait_age:import-commit' FAIL
rs "HGET.${KI}_jobA1.timestamp" "$(ms $((NOW-40*60)))"; rs "HGET.${KI}_jobA1.delay" "$(ms $((38*60)))"; qrun; chk "promoted delayed job: age counts from timestamp+delay" 'queue:import-commit' OK
reset; rs "LLEN.${KI}_wait" 1; rs "LINDEX.${KI}_wait.-1" jobR1; rs "HGET.${KI}_jobR1.timestamp" "$(ms $((NOW-120*60)))"; rs "HGET.${KI}_jobR1.atm" 2; rs "HGET.${KI}_jobR1.processedOn" "$(ms $((NOW-4*60)))"; qrun; chk "retried job (atm>0): age from processedOn, not creation = OK" 'queue:import-commit' OK
rs "HGET.${KI}_jobR1.finishedOn" "$(ms $((NOW-40*60)))"; rs "HGET.${KI}_jobR1.processedOn" "$(ms $((NOW-45*60)))"; qrun; chk "retried job: later of processedOn/finishedOn (40m) -> CRIT" 'queue_wait_age:import-commit' FAIL
rm -f "$S/r/HGET.${KI}_jobR1.atm"; rs "HGET.${KI}_jobR1.attemptsMade" 1; rs "HGET.${KI}_jobR1.finishedOn" "$(ms $((NOW-2*60)))"; qrun; chk "attemptsMade field fallback honoured" 'queue:import-commit' OK
assert "wait-age reads only fixed job fields (never data)" '! grep -Eqi "HGET [^ ]+ (data|returnvalue|failedReason)( |$)" "$S/redis.cmds"'
reset; rs "ZCARD.${KI}_delayed" 4; rs "ZRANGE.${KI}_delayed.0" "$(printf 'jobD1\n%s' "$(( ($(ms $((NOW+1800))) ) << 12 ))")"; qrun; chk "legit delayed (future backoff) = OK, never CRIT" 'queue:import-commit' OK
rs "ZRANGE.${KI}_delayed.0" "$(printf 'jobD1\n%s' "$(( ($(ms $((NOW-30*60))) ) << 12 ))")"; qrun; chk "delayed overdue 30m = WARN only" 'queue_delayed:import-commit' WARN
assert "delayed overdue is not CRIT in any row" '! grep -E "^queue_delayed.* FAIL" <<<"$OUT"'
reset; rs "LLEN.${KI}_active" 1; rs "LRANGE.${KI}_active.-20" jobAct1; rs "HGET.${KI}_jobAct1.processedOn" "$(ms $((NOW-25*60)))"; qrun; chk "active 25m under import limit 30" 'queue:import-commit' OK
rs "HGET.${KI}_jobAct1.processedOn" "$(ms $((NOW-40*60)))"; qrun; chk "stuck active 40m WARN (limit 30)" 'queue_active_age:import-commit' WARN
rs "HGET.${KI}_jobAct1.processedOn" "$(ms $((NOW-70*60)))"; qrun; chk "stuck active 70m CRIT (> 2x30)" 'queue_active_age:import-commit' FAIL
reset; rs "LLEN.${KN}_active" 1; rs "LRANGE.${KN}_active.-20" jobAct2; rs "HGET.${KN}_jobAct2.processedOn" "$(ms $((NOW-7*60)))"; qrun; chk "notification active 7m WARN (limit 5)" 'queue_active_age:notification-telegram' WARN
rs "HGET.${KN}_jobAct2.processedOn" "$(ms $((NOW-11*60)))"; qrun; chk "notification active 11m CRIT (> 2x5)" 'queue_active_age:notification-telegram' FAIL
# failed = `failed` events in the stream since the stored id (ZCARD is capped by removeOnFail and only informational)
reset; MODE_ARGS=; rs "ZCARD.${KI}_failed" 5000; qrun >/dev/null 2>&1; qrun; chk "failed: no new failed events = OK even with a capped ZCARD" 'queue:import-commit' OK
rs "XRANGE.${KI}_events" "$(ev 1900000000001-0 failed jobF1; ev 1900000000002-0 failed jobF2)"; qrun; chk "failed events +2 WARN (ZCARD unchanged at the cap)" 'queue_failed:import-commit' WARN
rm -f "$S/r/XRANGE.${KI}_events"; qrun; chk "failed events counted once (no new events -> OK)" 'queue:import-commit' OK
rs "XRANGE.${KI}_events" "$(for n in $(seq 3 14); do ev "19000000000$(printf '%02d' $n)-0" failed "jobF$n"; done)"; qrun; chk "failed events +12 CRIT" 'queue_failed:import-commit' FAIL
assert "failed: ZCARD total is informational only (no ZCARD-based delta state)" '[[ ! -e "$ST/q.import-commit.failed" ]]'
assert "no state file left as temp (atomic temp+mv)" '[[ -z "$(ls -A "$ST" | grep "^\.")" ]]'
reset; rs "LLEN.${KI}_paused" 2; qrun; chk "paused WARN" 'queue_paused:import-commit' WARN
# stream: baseline run first (non-dry state), then new events
reset; MODE_ARGS=; qrun >/dev/null 2>&1
rs "XRANGE.${KI}_events" "$(ev 1900000000001-0 stalled jobS1)"; qrun; chk "1 stalled event WARN" 'queue_stalled:import-commit' WARN
assert "stalled WARN is not CRIT" '! grep -E "^queue_stalled.* FAIL" <<<"$OUT"'
rm -f "$S/r/XRANGE.${KI}_events"; qrun; chk "stalled counted once (no new events -> OK)" 'queue:import-commit' OK
reset; MODE_ARGS=; qrun >/dev/null 2>&1
rs "XRANGE.${KI}_events" "$(ev 1900000000001-0 stalled jobS1; ev 1900000000002-0 stalled jobS2; ev 1900000000003-0 stalled jobS3)"; qrun; chk "3 stalled events CRIT" 'queue_stalled:import-commit' FAIL
reset; MODE_ARGS=; qrun >/dev/null 2>&1
rs "XRANGE.${KI}_events" "$(ev 1900000000001-0 stalled jobS1)"; rs "HGET.${KI}_jobS1.stc" 2; qrun; chk "1 stalled event but job stc>=2 CRIT" 'queue_stalled:import-commit' FAIL
reset; MODE_ARGS=; qrun >/dev/null 2>&1
rs "XRANGE.${KI}_events" "$(ev 1900000000001-0 retries-exhausted jobX1)"; qrun; chk "retries-exhausted CRIT" 'queue_exhausted:import-commit' FAIL
reset; MODE_ARGS=; qrun >/dev/null 2>&1
rs "XRANGE.${KI}_events" "$(ev 1900000000001-0 completed jobC1; ev 1900000000002-0 added jobC2)"; qrun; chk "non-stalled events ignored" 'queue:import-commit' OK
reset; MODE_ARGS=; rs "XREVRANGE.${KI}_events" "1900000000100-0"; qrun >/dev/null 2>&1
rs "XRANGE.${KI}_events.-" "1900000000200-0"; qrun; chk "stream gap (stored id older than first entry) WARN" 'queue_events_gap:import-commit' WARN
reset; MODE_ARGS=; rs "XREVRANGE.${KI}_events" "1900000000100-0"; qrun >/dev/null 2>&1
rs "XRANGE.${KI}_events.-" "1900000000050-0"; qrun; chk "no gap when first entry <= stored id" 'queue:import-commit' OK
reset; qrun; chk "dry-run: first run is baseline, no stalled alert" 'queue:import-commit' OK
# state files persist per queue; dry-run keeps none
reset; qrun; assert "dry-run writes no state" '[[ ! -e "$ST/q.import-commit.evid" ]]'
reset; MODE_ARGS=; qrun >/dev/null 2>&1; assert "run writes per-queue state (0600)" '[[ -f "$ST/q.import-commit.evid" ]]'
# dedup + RECOVERED for a queue incident
reset; MODE_ARGS=; rs "EXISTS.${KI}_meta" 0; qrun
assert "queue incident alerted once (CRIT, host label, no prefix secrets)" '[[ $RC -eq 1 ]] && grep -q "queue_meta:import-commit" "$S/curl.log"'
: > "$S/curl.log"; qrun; assert "queue incident: identical run not re-alerted (dedup)" '! grep -q sendMessage "$S/curl.log"'
rm -f "$S/r/EXISTS.${KI}_meta"; qrun; assert "queue incident: RECOVERED sent" 'grep -q "RECOVERED" "$S/curl.log"'
# baseline: redis error must not write 0-0; empty stream writes 0-0; state written atomically
reset; MODE_ARGS=; touch "$S/redis.err.XREVRANGE"; qrun; chk "events baseline: redis error -> queue_events FAIL" 'queue_events:import-commit' FAIL
assert "events baseline: error does not write 0-0" '[[ ! -e "$ST/q.import-commit.evid" ]]'
reset; MODE_ARGS=; qrun >/dev/null 2>&1; assert "events baseline: empty stream -> 0-0" '[[ "$(cat "$ST/q.import-commit.evid")" == 0-0 ]]'
# active scan checks the OLDEST end of the list
reset; rs "LLEN.${KI}_active" 30; qrun; assert "active: LRANGE reads the oldest 20 (-20 -1)" 'grep -q "^LRANGE velto-pilot:import-commit:active -20 -1$" "$S/redis.cmds"'
# redis auth: wrong password falls back to `default` (PING ok) -> WHOAMI mismatch = FAIL, queues SKIP, password never printed
reset; echo default > "$S/redis.whoami"; qrun MONITOR_REDIS_USER=velto_monitor; chk "wrong password (fell back to default): redis FAIL" redis FAIL; chk "wrong password: queues SKIP" queues SKIP
assert "wrong password: no queue row, no password in output" '! row "queue:import-commit" OK && ! grep -q "sekret-redis-pw" <<<"$OUT"'
reset; qrun MONITOR_REDIS_USER=velto_monitor; chk "WHOAMI == configured user: redis OK" redis OK
reset; qrun MONITOR_REDIS_USER=; chk "password only (no user): redis FAIL (fail-closed)" redis FAIL; chk "empty user: queues SKIP" queues SKIP
assert "empty user: detail names the cause, no password" 'grep -E "^redis +FAIL" <<<"$OUT" | grep -q "user not configured" && ! grep -q "sekret-redis-pw" <<<"$OUT"'
reset; qrun MONITOR_REDIS_USER=default; chk "user=default: redis FAIL" redis FAIL; chk "user=default: queues SKIP" queues SKIP
assert "empty/default user: no queue OK row" '! row "queue:import-commit" OK'
reset; echo other_user > "$S/redis.whoami"; qrun MONITOR_REDIS_USER=velto_monitor; chk "WHOAMI mismatch (non-default): redis FAIL" redis FAIL

# ===== --alert / --resolve (dedup by severity|name, cooldown, severity change, RECOVERED once) =====
ARUN() { local e="$T/env.run"; cp "$T/env" "$e"; AOUT="$(env -i PATH="$SHIM:/usr/bin:/bin" HOME="$T" STUB="$S" bash "$MON" "$@" --env "$e" 2>&1)"; ARC=$?; }
nsend() { grep -c sendMessage "$S/curl.log" 2>/dev/null || true; }
reset; : > "$S/curl.log"; ARUN --alert tstinc "disk low"
assert "alert: first sent (rc0), state written" '[[ $ARC -eq 0 && "$(nsend)" == 1 && -f "$ST/alerts/tstinc" ]]'
ARUN --alert tstinc "disk low"
assert "alert: same severity within cooldown suppressed" '[[ $ARC -eq 0 && "$(nsend)" == 1 && "$AOUT" == *suppressed* ]]'
ARUN --alert tstinc "disk low" --severity warn
assert "alert: severity change re-alerts" '[[ $ARC -eq 0 && "$(nsend)" == 2 ]]'
ARUN --alert otherinc "x"
assert "alert: different name is a separate incident" '[[ "$(nsend)" == 3 ]]'
printf '%s|crit\n' "$(( $(date +%s) - 999999 ))" > "$ST/alerts/otherinc"; ARUN --alert otherinc "x"
assert "alert: after cooldown re-alerts" '[[ "$(nsend)" == 4 ]]'
ARUN --resolve tstinc
assert "resolve: RECOVERED sent once, state removed" '[[ $ARC -eq 0 && "$(nsend)" == 5 && ! -e "$ST/alerts/tstinc" ]] && grep -q "RECOVERED tstinc" "$S/curl.log"'
ARUN --resolve tstinc
assert "resolve: no open incident is a no-op" '[[ $ARC -eq 0 && "$(nsend)" == 5 ]]'
# dedup fingerprint = severity|check name; numbers in details do not re-alert, WARN->CRIT escalation does
reset; MODE_ARGS=; rs "LLEN.${KI}_wait" 1; rs "LINDEX.${KI}_wait.-1" jobA1; rs "HGET.${KI}_jobA1.timestamp" "$(ms $((NOW-40*60)))"; qrun; : > "$S/curl.log"
rs "HGET.${KI}_jobA1.timestamp" "$(ms $((NOW-50*60)))"; qrun; assert "same incident, different age number: NOT re-alerted" '! grep -q sendMessage "$S/curl.log"'
reset; MODE_ARGS=; rs "LLEN.${KI}_wait" 1; rs "LINDEX.${KI}_wait.-1" jobA1; rs "HGET.${KI}_jobA1.timestamp" "$(ms $((NOW-12*60)))"; qrun; : > "$S/curl.log"
rs "HGET.${KI}_jobA1.timestamp" "$(ms $((NOW-40*60)))"; qrun; assert "WARN -> CRIT escalation re-alerts" 'grep -q sendMessage "$S/curl.log"'
: > "$S/curl.log"; rm -f "$S/r/LLEN.${KI}_wait"; qrun; assert "RECOVERED still sent after the incident clears" 'grep -q RECOVERED "$S/curl.log"'
# output hygiene: no ids, payload, reasons, secrets; only allowed read-only commands
reset; MODE_ARGS=; qrun >/dev/null 2>&1
rs "LLEN.${KI}_wait" 1; rs "LINDEX.${KI}_wait.-1" SECRETJOBID1; rs "HGET.${KI}_SECRETJOBID1.timestamp" "$(ms $((NOW-40*60)))"; rs "HGET.${KI}_SECRETJOBID1.data" PAYLOADSECRET
rs "LLEN.${KI}_active" 1; rs "LRANGE.${KI}_active.-20" SECRETJOBID2; rs "HGET.${KI}_SECRETJOBID2.processedOn" "$(ms $((NOW-90*60)))"; rs "HGET.${KI}_SECRETJOBID2.returnvalue" PAYLOADSECRET
rs "XRANGE.${KI}_events" "$(printf '1900000000001-0\nevent\nstalled\njobId\nSECRETJOBID3\n1900000000002-0\nevent\nfailed\njobId\nSECRETJOBID4\nfailedReason\nPAYLOADSECRET\n1900000000003-0\nevent\ncompleted\njobId\nSECRETJOBID5\nreturnvalue\nPAYLOADSECRET\n')"
rs "EXISTS.${KI}_stalled-check" 0
qrun
assert "output has no job ids / payload / secrets" '! grep -Eq "SECRETJOBID|PAYLOADSECRET|sekret-redis-pw|AAAAAAAA" <<<"$OUT" && ! grep -Eq "SECRETJOBID|PAYLOADSECRET|sekret-redis-pw|AAAAAAAA" <<<"$(sed "s/STDIN:.*//" "$S/curl.log")"'
assert "only fixed job fields requested (never data/returnvalue/failedReason/opts)" '! grep -Eqi "HGET [^ ]+ (data|returnvalue|failedReason|stacktrace|opts|name)( |$)" "$S/redis.cmds" && ! grep -Eq "HGETALL|HMGET" "$S/redis.cmds"'
assert "only read-only allowlisted commands used (no write/KEYS/SCAN/CLIENT)" '! grep -Eqv "^(PING|ACL WHOAMI|EXISTS|LLEN|LINDEX|LRANGE|ZCARD|ZRANGE|HGET|XRANGE|XREVRANGE)( |$)" "$S/redis.cmds"'
assert "no job id in output of PG mismatch either" '! grep -Eq "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}" <<<"$OUT"'

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

# ===== DB: stale (backoff-aware), failed, connections, job_mismatch =====
DBE=(MONITOR_DB_NAME=velto MONITOR_DB_USER=velto_monitor)
reset; echo "0 0 0 0 0 7" > "$S/psql.row"; run "${DBE[@]}" MONITOR_DB_PASSWORD=pgsecret; chk "jobs_stale ok" jobs_stale OK; chk "jobs_failed ok" jobs_failed OK; chk "db_connections" db_connections OK; chk "mismatch OK when nothing stale" job_mismatch OK
assert "pg password not in argv" '! grep -q pgsecret "$S/psql.log"'
assert "notif PENDING stale uses next-attempt (future backoff is not stale) + SENDING uses claimedAt" 'grep -q "COALESCE(\"telegramNextAttemptAt\",\"updatedAt\")" "$S/psql.log" && grep -q "\"telegramClaimedAt\" < now()" "$S/psql.log"'
assert "import stale uses recovery backoff formula" 'grep -q "LEAST(3600, 300 \* POWER(2, LEAST(\"attemptCount\", 12)))" "$S/psql.log"'
assert "SQL touches only status/time/attempt/type/id columns" '! grep -Eqi "companyId|errorLog|fileUrl|telegramLastError|recipient|phone" "$S/psql.log"'
reset; echo "2 0 0 0 0 7" > "$S/psql.row"; run "${DBE[@]}"; chk "stale import WARN" jobs_stale WARN
reset; echo "0 1 0 0 0 7" > "$S/psql.row"; run "${DBE[@]}"; chk "stale export WARN" jobs_stale WARN
reset; echo "0 0 3 0 0 7" > "$S/psql.row"; run "${DBE[@]}"; chk "stale notif pending WARN" jobs_stale WARN
reset; echo "0 0 0 1 0 7" > "$S/psql.row"; run "${DBE[@]}"; chk "stale notif sending WARN" jobs_stale WARN
reset; echo "0 0 0 0 9 7" > "$S/psql.row"; run "${DBE[@]}"; chk "jobs failed" jobs_failed FAIL
reset; echo "0 0 0 0 garbage 7" > "$S/psql.row"; run "${DBE[@]}"; chk "unparsable DB reply" jobs_stale FAIL
reset; touch "$S/psql.fail"; run "${DBE[@]}"; chk "db query fails" jobs_stale FAIL
# job_mismatch: stale row whose BullMQ job key is missing. 1st run WARN, 2nd consecutive CRIT, healthy run resets.
UUID1=11111111-1111-1111-1111-111111111111; UUID2=22222222-2222-2222-2222-222222222222
mm_setup() { reset; MODE_ARGS=; echo "1 0 1 0 0 7" > "$S/psql.row"; printf 'i %s\nn %s\n' "$UUID1" "$UUID2" > "$S/psql.ids"; }
mm_setup; rs "EXISTS.${KI}_import-${UUID1}" 0; qrun "${DBE[@]}"; chk "mismatch 1st run WARN" job_mismatch WARN
assert "mismatch prints only counts" 'grep -q "import=1 export=0 notif=0" <<<"$OUT" && ! grep -q "$UUID1" <<<"$OUT"'
qrun "${DBE[@]}"; chk "mismatch 2nd consecutive run CRIT" job_mismatch FAIL
rm -f "$S/r/EXISTS.${KI}_import-${UUID1}"; qrun "${DBE[@]}"; chk "mismatch cleared -> OK" job_mismatch OK
rs "EXISTS.${KI}_import-${UUID1}" 0; qrun "${DBE[@]}"; chk "mismatch after reset = WARN again (not CRIT)" job_mismatch WARN
mm_setup; rs "EXISTS.${KN}_${UUID2}" 0; qrun "${DBE[@]}"; chk "notification job key is the bare row id" job_mismatch WARN
assert "mismatch EXISTS keys built from prefix:queue:jobId" 'grep -q "EXISTS velto-pilot:import-commit:import-$UUID1" "$S/redis.cmds" && grep -q "EXISTS velto-pilot:notification-telegram:$UUID2" "$S/redis.cmds"'
mm_setup; printf 'i %s\n' "../../etc/passwd" > "$S/psql.ids"; qrun "${DBE[@]}"; chk "non-uuid id ignored (no key built) but NOT a false OK: unchecked WARN" job_mismatch WARN
assert "unchecked rows are counted and reported" 'grep -Eq "[0-9]+ stale rows could not be checked" <<<"$OUT" && ! grep -q "passwd" <<<"$OUT"'
mm_setup; printf 'i %s\nx %s\n' "$UUID1" "$UUID2" > "$S/psql.ids"; qrun "${DBE[@]}"; chk "unmapped ExportJob type (x) -> WARN, not 'all stale rows have a job'" job_mismatch WARN
assert "unmapped type: no EXISTS key built for it" '! grep -q "$UUID2" "$S/redis.cmds"'
mm_setup; echo "1 0 1 0 0 7" > "$S/psql.row"; printf 'i %s\nn %s\n' "$UUID1" "$UUID2" > "$S/psql.ids"; qrun "${DBE[@]}"; chk "all rows checked + present = OK" job_mismatch OK
mm_setup; echo "300 0 0 0 0 7" > "$S/psql.row"; printf 'i %s\n' "$UUID1" > "$S/psql.ids"; qrun "${DBE[@]}"; chk "truncation (300 stale, 1 checked) -> WARN" job_mismatch WARN
mm_setup; echo "300 0 0 0 0 7" > "$S/psql.row"; printf 'i %s\n' "$UUID1" > "$S/psql.ids"; rs "EXISTS.${KI}_import-${UUID1}" 0; qrun "${DBE[@]}"; assert "mismatch found + truncation: still reported with unchecked count" 'grep -E "^job_mismatch +(WARN|FAIL).*unchecked=299" <<<"$OUT" >/dev/null'

mm_setup; echo "(error) NOAUTH" > "$S/redis.ping"; qrun "${DBE[@]}"; chk "mismatch SKIP when redis down" job_mismatch SKIP

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
