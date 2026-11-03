#!/usr/bin/env bash
# shellcheck disable=SC2016  # single-quoted bash -c bodies / sed patterns intentionally defer expansion to the child shell
# Integration harness for deploy/monitoring/velto-monitor.sh against REAL Redis 7 + real bullmq (apps/api) + real Postgres.
# Synthetic data only. Needs: docker dev stack (redis :6380, postgres :5433), node, redis-cli, psql, pnpm.
# Usage: bash deploy/monitoring/tests/integration-bullmq.test.sh        (SKIP_PG=1 skips the Postgres part)
# Safety: every Redis key lives under the throwaway prefix velto-montest-<pid> (deleted by prefix at exit, never FLUSHDB/FLUSHALL);
# the Redis ACL user velto_montest_<pid> is created from the README line and removed at exit; Postgres uses the throwaway DB velto_test
# (created here, refused if it already exists, dropped at exit) and throwaway roles. NOTE: Redis DB 0 is used: the monitor has no
# MONITOR_REDIS_DB and the README ACL has no +select, so it can only ever read DB 0 (unique prefix isolates this run instead).
# Alerts are NEVER sent anywhere real: no OPS token is set (env -i), the webhook channel points to a local 127.0.0.1 sink, and a curl shim
# logs every call so the harness can prove nothing went to telegram.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MON="$HERE/../velto-monitor.sh"; HELPER="$HERE/integration-bullmq-helper.cjs"; README="$HERE/../README.md"; ROLESQL="$HERE/../monitor-role.sql"
RPORT="${HARNESS_REDIS_PORT:-6380}"
PGPORT_="${HARNESS_PG_PORT:-5433}"; PGADMIN="${HARNESS_PG_ADMIN_USER:-velto}"; PGADMINPW="${HARNESS_PG_ADMIN_PASSWORD:-velto}"
PFX="velto-montest-$$"; ACLU="velto_montest_$$"; PGR="velto_montest_$$"; PGFN="velto_montest_${$}_fn"; DB=velto_test
RPW="rp$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"; PGPW="pp$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
W="$(mktemp -d)"; SHIM="$W/shim"; mkdir -p "$SHIM" "$W/tmp"; : > "$W/alerts.log"; : > "$W/curl.log"; : > "$W/all-output.log"
printf 'ts=%s\nresult=ok\noffsite_restore_point_ts=%s\noffsite_result=ok\noffsite_ts=%s\n' "$(date +%s)" "$(date +%s)" "$(date +%s)" > "$W/backup.status"
printf 'MemTotal: 1000000 kB\nMemAvailable: 900000 kB\n' > "$W/meminfo"
START=$SECONDS; PASS=0; FAILN=0; PIDS=(); DB_CREATED=0; ROLES_CREATED=0; ACL_CREATED=0; MN=0; MOUT=; MRC=0; WPID=
SKIP_PG="${SKIP_PG:-0}"

pass() { PASS=$((PASS+1)); }
fail() { FAILN=$((FAILN+1)); echo "FAIL: $1"
  if [[ -n "${HARNESS_VERBOSE:-}" && -f "$MOUT" ]]; then sed 's/^/   | /' "$MOUT" "$MOUT.err" | head -30; fi; }
t() { local d="$1"; shift; if "$@"; then pass; else fail "$d"; fi; }          # t "description" cmd args...
tn() { local d="$1"; shift; if "$@"; then fail "$d"; else pass; fi; }          # negative assertion
radm() { redis-cli -h 127.0.0.1 -p "$RPORT" "$@" 2>&1 | tr -d '\r'; }          # admin (default user): harness-only
hlp() { H_REDIS_PORT="$RPORT" node "$HELPER" "$@"; }
padm() { PGPASSWORD="$PGADMINPW" psql -h 127.0.0.1 -p "$PGPORT_" -U "$PGADMIN" -X -At -v ON_ERROR_STOP=1 "$@"; }
wait_for() { local d="$1" n="$2"; shift 2; local i; for ((i=0;i<n*5;i++)); do "$@" >/dev/null 2>&1 && return 0; sleep 0.2; done; fail "timeout waiting for: $d"; return 1; }

cleanup() {
  local p
  for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null; wait "$p" 2>/dev/null; done
  H_REDIS_PORT="$RPORT" node "$HELPER" cleanup "$PFX" >/dev/null 2>&1
  if [[ $ACL_CREATED == 1 ]]; then redis-cli -h 127.0.0.1 -p "$RPORT" ACL DELUSER "$ACLU" >/dev/null 2>&1; fi
  if [[ $DB_CREATED == 1 ]]; then
    padm -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1
  fi
  if [[ $ROLES_CREATED == 1 ]]; then padm -d postgres -c "DROP ROLE IF EXISTS \"$PGR\"" -c "DROP ROLE IF EXISTS \"$PGFN\"" >/dev/null 2>&1; fi
  if [[ -n "${HARNESS_KEEP:-}" ]]; then echo "kept $W"; else rm -rf "$W"; fi
}
trap cleanup EXIT
trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 141' PIPE; trap 'exit 129' HUP

# ---- prerequisites: say so clearly instead of failing obscurely ----
[[ "$(redis-cli -h 127.0.0.1 -p "$RPORT" PING 2>/dev/null)" == PONG ]] || { echo "PREREQ: Redis not reachable on :$RPORT (docker-compose up -d redis)"; exit 3; }
if [[ "$SKIP_PG" != 1 ]]; then
  padm -d postgres -c 'SELECT 1' >/dev/null 2>&1 || { echo "PREREQ: Postgres admin not reachable on :$PGPORT_ (SKIP_PG=1 to skip DB part)"; exit 3; }
fi

# ---- curl shim (proves no network call to telegram) + local webhook/health sink ----
REAL_CURL="$(command -v curl)"
cat > "$SHIM/curl" <<'SH'
#!/usr/bin/env bash
cfg=""
for x in "$@"; do [[ "$x" == -K ]] && cfg="$(cat)"; done
printf 'ARGS: %s CFG: %s\n' "$*" "$cfg" >> "$CURL_LOG"
if [[ -n "$cfg" ]]; then printf '%s\n' "$cfg" | exec "$REAL_CURL" "$@"; else exec "$REAL_CURL" "$@"; fi
SH
chmod +x "$SHIM/curl"
node "$HELPER" sink "$W/alerts.log" "$W/sink.port" & PIDS+=("$!")
wait_for "sink up" 10 test -s "$W/sink.port" || exit 3
SINK="http://127.0.0.1:$(cat "$W/sink.port")"

# monitor runner: mon <scenario> [VAR=value ...]. State dir per scenario (kept between runs of the same scenario). Never --dry-run:
# events/failed deltas and dedup/RECOVERED need the state; alerts go to the local sink only.
mon() {
  local scn="$1"; shift; MN=$((MN+1)); MOUT="$W/$scn.$MN.out"
  env -i PATH="$SHIM:$PATH" HOME="$W" TMPDIR="$W/tmp" CURL_LOG="$W/curl.log" REAL_CURL="$REAL_CURL" \
    MONITOR_HOST_LABEL=montest MONITOR_STATE_DIR="$W/state.$scn" \
    MONITOR_REDIS_HOST=127.0.0.1 MONITOR_REDIS_PORT="$RPORT" MONITOR_REDIS_USER="$ACLU" MONITOR_REDIS_PASSWORD="$RPW" \
    MONITOR_BULLMQ_PREFIX="$PFX" MONITOR_NOWORKER_PROBE_SECONDS=1 \
    VELTO_API_HEALTH_URL="$SINK/health" MONITOR_ALERT_WEBHOOK_URL="$SINK/alert" MONITOR_TLS_HOST= \
    NGINX_ACCESS_LOG="$W/none.log" MONITOR_BACKUP_STATUS_FILE="$W/backup.status" MONITOR_DISK_PATHS=/ \
    MONITOR_DISK_WARN_PERCENT=101 MONITOR_DISK_CRIT_PERCENT=101 MONITOR_MEMINFO="$W/meminfo" \
    "$@" bash "$MON" --env "$W/none.env" > "$MOUT" 2> "$MOUT.err"
  MRC=$?
  { echo "== $scn #$MN rc=$MRC"; cat "$MOUT" "$MOUT.err"; } >> "$W/all-output.log"
}
has() { tr -s ' ' < "$MOUT" | grep -Eq "$1"; }                         # monitor stdout line regex
errhas() { grep -Eq "$1" "$MOUT.err"; }
rc_is() { [[ "$MRC" == "$1" ]]; }
alerts() { grep -c '^@@@ POST' "$W/alerts.log" 2>/dev/null || true; }
last_alert() { awk '/^@@@/ {b=""; next} {b=b $0 "\n"} END {printf "%s", b}' "$W/alerts.log"; }
start_worker() { local q="$1" mode="$2" tag="$3"; shift 3
  env H_REDIS_PORT="$RPORT" "$@" node "$HELPER" worker "$q" "$PFX" "$mode" > "$W/w.$tag.log" 2>&1 &
  WPID=$!; PIDS+=("$WPID"); wait_for "worker $tag ready" 15 grep -q ready "$W/w.$tag.log"; }
stop_worker() { kill -TERM "$1" 2>/dev/null; wait "$1" 2>/dev/null; }
kill9() { kill -9 "$1" 2>/dev/null; wait "$1" 2>/dev/null; }
K() { echo "$PFX:$1"; }
q_done() { [[ "$(radm LLEN "$(K "$1"):wait")" == 0 && "$(radm LLEN "$(K "$1"):active")" == 0 && "$(radm ZCARD "$(K "$1"):completed")" == "$2" ]]; }
hget_eq() { [[ "$(radm HGET "$1" "$2")" == "$3" ]]; }
key_eq() { [[ "$(radm "$1" "$2")" == "$3" ]]; }
has_marker() { grep -rqE 'SECRET_PAYLOAD_MARKER|CANARYID_|boom ' "$@" 2>/dev/null; }

# =============================================================================================
# 2. Redis ACL user created EXACTLY from the README line; write commands must be denied
# =============================================================================================
aclcmd="$(grep -m1 '^`ACL SETUSER' "$README" | sed -E 's/^`([^`]*)`.*/\1/')"
t "README ACL line found" test -n "$aclcmd"
aclcmd="${aclcmd//velto_monitor/$ACLU}"; aclcmd="${aclcmd//velto-pilot/$PFX}"; aclcmd="${aclcmd//<password>/$RPW}"
t "ACL line substituted (user/prefix/password)" bash -c '[[ "$1" == *" -@all "* && "$1" == *"%R~$2:*"* && "$1" == *">${3}"* ]]' _ "$aclcmd" "$PFX" "'$RPW'"
t "ACL SETUSER OK" test "$(printf '%s\n' "$aclcmd" | radm)" == OK
ACL_CREATED=1
acl() { REDISCLI_AUTH="$RPW" redis-cli -h 127.0.0.1 -p "$RPORT" --user "$ACLU" --no-auth-warning "$@" 2>&1 | tr -d '\r'; }
t "ACL user PING" test "$(acl PING)" == PONG
for c in "SET $PFX:acl-probe 1" "DEL $PFX:acl-probe" "HSET $PFX:acl-probe f v" "EXPIRE $PFX:acl-probe 5" "KEYS *" "SCAN 0" "CLIENT LIST" "INFO" "FLUSHDB" "GET $PFX:acl-probe" "XADD $PFX:acl-probe * a b"; do
  read -ra argv <<<"$c"   # no glob expansion of KEYS *
  t "ACL denies: ${c%% *}" bash -c 'grep -q NOPERM <<<"$1"' _ "$(acl "${argv[@]}")"
done
t "ACL denies read outside prefix (HGET)" bash -c 'grep -q NOPERM <<<"$1"' _ "$(acl HGET other-prefix:q:meta version)"
t "ACL denied SET/DEL left no key" test "$(radm EXISTS "$PFX:acl-probe")" == 0

# =============================================================================================
# 3a. healthy: real worker, jobs complete -> OK, no alert; events_gap (stream trimmed past last seen id)
# =============================================================================================
hlp meta healthy "$PFX"; start_worker healthy ok h1; HW="$WPID"
for i in 1 2 3; do hlp add healthy "$PFX" "CANARYID_healthy_$i"; done
wait_for "healthy jobs done" 15 q_done healthy 3
a0="$(alerts)"; mon healthy MONITOR_QUEUES=healthy
t "healthy rc 0" rc_is 0; t "healthy: redis OK" has '^redis +OK'; t "healthy: queue OK" has '^queue:healthy +OK wait=0 active=0'
tn "healthy: no FAIL/WARN line" has ' (FAIL|WARN) '
t "healthy: no alert sent" test "$(alerts)" == "$a0"
mon healthy MONITOR_QUEUES=healthy; t "healthy 2nd run (events baseline stored) still OK" has '^queue:healthy +OK'
hlp add healthy "$PFX" CANARYID_healthy_4; hlp add healthy "$PFX" CANARYID_healthy_5; wait_for "healthy 5 done" 15 q_done healthy 5
lastid="$(radm XREVRANGE "$(K healthy):events" + - COUNT 1 | head -n1)"
radm XTRIM "$(K healthy):events" MINID "$lastid" >/dev/null
mon healthy MONITOR_QUEUES=healthy; t "events stream trimmed -> queue_events_gap WARN" has '^queue_events_gap:healthy +WARN'
stop_worker "$HW"

# =============================================================================================
# 3b. waiting + no worker (worker closed, stalled-check expired) -> CRIT queue_no_worker; dedup; RECOVERED
# =============================================================================================
hlp meta nw "$PFX"; start_worker nw ok n1 STALL_MS=500; NW="$WPID"
hlp add nw "$PFX" CANARYID_nw_1; wait_for "nw job1 done" 15 q_done nw 1
stop_worker "$NW"; wait_for "stalled-check expired" 10 key_eq EXISTS "$(K nw):stalled-check" 0
hlp add nw "$PFX" CANARYID_nw_2
a0="$(alerts)"; mon nw MONITOR_QUEUES=nw
t "no_worker: CRIT queue_no_worker" has '^queue_no_worker:nw +FAIL'; t "no_worker: rc 1" rc_is 1
t "no_worker: exactly one alert sent" test "$(alerts)" == "$((a0+1))"; t "no_worker alert text names the check" bash -c 'grep -q "CRIT queue_no_worker:nw" <<<"$1"' _ "$(last_alert)"
mon nw MONITOR_QUEUES=nw; t "no_worker 2nd run still CRIT" has '^queue_no_worker:nw +FAIL'
t "dedup: 2nd run sends NO repeat alert" test "$(alerts)" == "$((a0+1))"
start_worker nw ok n2; NW2="$WPID"; wait_for "nw job2 done" 15 q_done nw 2
mon nw MONITOR_QUEUES=nw
t "resolved: rc 0, queue OK" rc_is 0; t "resolved: queue:nw OK" has '^queue:nw +OK'
t "resolved: RECOVERED sent once" test "$(alerts)" == "$((a0+2))"; t "RECOVERED text" bash -c 'grep -q "RECOVERED: all checks OK" <<<"$1"' _ "$(last_alert)"
mon nw MONITOR_QUEUES=nw; t "no repeat RECOVERED" test "$(alerts)" == "$((a0+2))"
stop_worker "$NW2"

# =============================================================================================
# 3c. worker alive with backlog (1 active hang, 1 waiting): no_worker must NOT fire; wait_age WARN/CRIT on rewound timestamp
# =============================================================================================
hlp meta backlog "$PFX"; start_worker backlog hang b1; BW="$WPID"
hlp add backlog "$PFX" CANARYID_bl_1; wait_for "bl active" 10 key_eq LLEN "$(K backlog):active" 1
hlp add backlog "$PFX" CANARYID_bl_2; wait_for "bl waiting" 10 key_eq LLEN "$(K backlog):wait" 1
mon backlog MONITOR_QUEUES=backlog; t "backlog+live worker: queue OK" has '^queue:backlog +OK wait=1 active=1'; tn "backlog+live worker: no no_worker" has 'queue_no_worker'
hlp age backlog "$PFX" CANARYID_bl_2 timestamp 15; mon backlog MONITOR_QUEUES=backlog
t "wait_age 15m -> WARN" has '^queue_wait_age:backlog +WARN'; tn "wait_age WARN still no no_worker" has 'queue_no_worker'
hlp age backlog "$PFX" CANARYID_bl_2 timestamp 40; mon backlog MONITOR_QUEUES=backlog; t "wait_age 40m -> CRIT" has '^queue_wait_age:backlog +FAIL'
kill9 "$BW"

# =============================================================================================
# 3d. legit delayed/backoff (attempts + exponential backoff after a fail) -> no CRIT; overdue delayed -> WARN only
# =============================================================================================
hlp meta backoff "$PFX"; mon backoff MONITOR_QUEUES=backoff
start_worker backoff fail bo1; BO="$WPID"
hlp add backoff "$PFX" CANARYID_bo_1 '{"attempts":3,"backoff":{"type":"exponential","delay":60000}}'
wait_for "backoff job delayed" 15 key_eq ZCARD "$(K backoff):delayed" 1; stop_worker "$BO"
mon backoff MONITOR_QUEUES=backoff
t "backoff: rc 0 (no CRIT)" rc_is 0; t "backoff: queue OK delayed=1" has '^queue:backoff +OK wait=0 active=0 delayed=1'; tn "backoff: no FAIL" has ' FAIL '
hlp delayed-age backoff "$PFX" CANARYID_bo_1 20; mon backoff MONITOR_QUEUES=backoff
t "overdue delayed -> WARN" has '^queue_delayed:backoff +WARN'; t "overdue delayed is never CRIT (rc 0)" rc_is 0

# =============================================================================================
# 3e. active job beyond per-queue limit
# =============================================================================================
hlp meta activeage "$PFX"; start_worker activeage hang a1; AW="$WPID"
hlp add activeage "$PFX" CANARYID_aa_1; wait_for "aa active" 10 key_eq LLEN "$(K activeage):active" 1
mon activeage MONITOR_QUEUES=activeage MONITOR_QUEUE_ACTIVE_LIMITS="activeage=1"; t "fresh active job within limit -> OK" has '^queue:activeage +OK'
hlp age activeage "$PFX" CANARYID_aa_1 processedOn 2.5; mon activeage MONITOR_QUEUES=activeage MONITOR_QUEUE_ACTIVE_LIMITS="activeage=1"
t "active 2m > limit 1m -> WARN" has '^queue_active_age:activeage +WARN'; t "active WARN rc 0" rc_is 0
mon activeage MONITOR_QUEUES=activeage MONITOR_QUEUE_ACTIVE_LIMITS="other=1"; t "per-queue limit: other queue's limit does not apply (default 30m) -> OK" has '^queue:activeage +OK'
hlp age activeage "$PFX" CANARYID_aa_1 processedOn 3.5; mon activeage MONITOR_QUEUES=activeage MONITOR_QUEUE_ACTIVE_LIMITS="activeage=1"
t "active 3m > 2x limit -> CRIT" has '^queue_active_age:activeage +FAIL'; t "active CRIT rc 1" rc_is 1
kill9 "$AW"

# =============================================================================================
# 3f. REAL stalled event: worker process SIGKILLed mid-job (short lock/stalledInterval); repeated stall -> stc rule
# =============================================================================================
hlp meta stall "$PFX"; mon stall MONITOR_QUEUES=stall   # baseline
start_worker stall hang s1 STALL_MS=1500 MAX_STALLED=5; SA="$WPID"
hlp add stall "$PFX" CANARYID_st_1; wait_for "stall job active" 10 key_eq LLEN "$(K stall):active" 1
kill9 "$SA"
start_worker stall hang s2 STALL_MS=1500 MAX_STALLED=5; SB="$WPID"
wait_for "1st stalled event" 20 bash -c "redis-cli -h 127.0.0.1 -p $RPORT XRANGE '$(K stall):events' - + | grep -qx stalled"
mon stall MONITOR_QUEUES=stall
t "1 real stall -> queue_stalled WARN +1" has '^queue_stalled:stall +WARN stalled events \+1'; t "1 stall: stc=1 so not CRIT (rc 0)" rc_is 0
kill9 "$SB"
start_worker stall ok s3 STALL_MS=1500 MAX_STALLED=5; SC="$WPID"
wait_for "stc reaches 2" 20 hget_eq "$(K stall):CANARYID_st_1" stc 2
mon stall MONITOR_QUEUES=stall
t "repeated stall (stc>=2) -> queue_stalled CRIT" has '^queue_stalled:stall +FAIL .*jobs with stc>=2: 1'; t "repeated stall rc 1" rc_is 1
stop_worker "$SC"

# =============================================================================================
# 3g. attempts exhausted -> queue_exhausted CRIT (+ failed delta)
# =============================================================================================
hlp meta exh "$PFX"; mon exh MONITOR_QUEUES=exh   # baseline (events id + failed count)
start_worker exh fail e1; EW="$WPID"
hlp add exh "$PFX" CANARYID_ex_1 '{"attempts":2,"backoff":{"type":"fixed","delay":200}}'
wait_for "exh failed" 15 key_eq ZCARD "$(K exh):failed" 1
mon exh MONITOR_QUEUES=exh
t "exhausted -> queue_exhausted CRIT" has '^queue_exhausted:exh +FAIL retries-exhausted events \+1'; t "failed events WARN" has '^queue_failed:exh +WARN failed events \+1'; t "exhausted rc 1" rc_is 1
a0="$(alerts)"; mon exh MONITOR_QUEUES=exh; t "exhausted: no new events -> no repeat CRIT" test "$(has 'queue_exhausted' && echo y || echo n)" == n
stop_worker "$EW"

# =============================================================================================
# 3h. paused queue, prefix mismatch, Redis down / auth failure
# =============================================================================================
hlp meta paused "$PFX"; hlp pause paused "$PFX"; hlp add paused "$PFX" CANARYID_pa_1
mon paused MONITOR_QUEUES=paused; t "paused queue -> WARN queue_paused" has '^queue_paused:paused +WARN'
mon prefix MONITOR_QUEUES=neverexisted; t "prefix mismatch / no meta -> CRIT queue_meta" has '^queue_meta:neverexisted +FAIL'; t "queue_meta rc 1" rc_is 1
mon prefix2 MONITOR_QUEUES=healthy MONITOR_BULLMQ_PREFIX="$PFX-wrong"
t "other prefix (outside ACL key pattern) -> never OK" has '^queue_meta:healthy +FAIL'; tn "other prefix: no queue OK line" has '^queue:healthy +OK'
mon down MONITOR_QUEUES=healthy MONITOR_REDIS_PORT=1
t "Redis unreachable -> redis FAIL" has '^redis +FAIL'; t "Redis down: queue checks reported SKIP, not OK" has '^queues +SKIP'; tn "Redis down: no false OK" has '^(redis|queue:[a-z]+) +OK'; t "Redis down rc 1" rc_is 1
# The monitor really ran as the ACL user: Redis recorded its denied probe of the other prefix in ACL LOG (username is unique to this run).
t "monitor authenticated as the ACL user (ACL LOG has its denied key probe)" bash -c 'redis-cli -h 127.0.0.1 -p "$1" ACL LOG 50 | grep -qx "$2"' _ "$RPORT" "$ACLU"

# =============================================================================================
# 3i. failed delta from `failed` EVENTS, not the capped ZCARD (removeOnFail count=1 keeps the zset at 1 while 3 jobs failed)
# =============================================================================================
hlp meta cap "$PFX"; mon cap MONITOR_QUEUES=cap   # baseline
start_worker cap fail c1; CW="$WPID"
for i in 1 2 3; do hlp add cap "$PFX" "CANARYID_cap_$i" '{"attempts":1,"removeOnFail":{"count":1}}'; done
wait_for "cap 3 failed events" 20 bash -c "[[ \$(redis-cli -h 127.0.0.1 -p $RPORT XRANGE '$(K cap):events' - + | grep -cx failed) == 3 ]]"
t "cap: ZCARD failed stays capped at 1 (the blind spot)" key_eq ZCARD "$(K cap):failed" 1
mon cap MONITOR_QUEUES=cap; t "cap: failed EVENTS +3 -> queue_failed WARN despite capped ZCARD" has '^queue_failed:cap +WARN failed events \+3'
mon cap MONITOR_QUEUES=cap; tn "cap: failed events counted once" has 'queue_failed'
stop_worker "$CW"

# =============================================================================================
# 3j. legit retried job back in wait after backoff (attemptsMade>0): old timestamp must not look like a stuck job
# =============================================================================================
hlp meta retry "$PFX"; start_worker retry fail r1; RW="$WPID"
hlp add retry "$PFX" CANARYID_rt_1 '{"attempts":2,"backoff":{"type":"fixed","delay":3600000}}'
wait_for "retry job delayed" 15 key_eq ZCARD "$(K retry):delayed" 1; stop_worker "$RW"
hlp promote retry "$PFX" CANARYID_rt_1; wait_for "retry job in wait" 10 key_eq LLEN "$(K retry):wait" 1
t "retry: real job hash carries attempts counter > 0" bash -c '[[ "$(redis-cli -h 127.0.0.1 -p "$1" HGET "$2" atm)" =~ ^[1-9][0-9]*$ ]]' _ "$RPORT" "$(K retry):CANARYID_rt_1"
hlp age retry "$PFX" CANARYID_rt_1 timestamp 120
mon retry MONITOR_QUEUES=retry; tn "retry: creation 120m ago but last attempt just now -> no queue_wait_age" has 'queue_wait_age'
hlp age retry "$PFX" CANARYID_rt_1 processedOn 40; hlp age retry "$PFX" CANARYID_rt_1 finishedOn 40
mon retry MONITOR_QUEUES=retry; t "retry: last attempt 40m ago -> queue_wait_age CRIT" has '^queue_wait_age:retry +FAIL'

# =============================================================================================
# 3k. wrong password: redis-cli falls back to the unauthenticated `default` user and PING works -> must be FAIL (ACL WHOAMI)
# =============================================================================================
t "default user answers PING without auth (precondition)" test "$(radm PING)" == PONG
mon badpw MONITOR_QUEUES=healthy MONITOR_REDIS_PASSWORD="wrong-$RPW"
t "wrong password -> redis FAIL" has '^redis +FAIL'; t "wrong password -> queues SKIP" has '^queues +SKIP'; tn "wrong password: no queue/redis OK row" has '^(redis|queue:[a-z]+) +OK'; t "wrong password rc 1" rc_is 1
tn "wrong password never printed" grep -qF "wrong-$RPW" "$MOUT" "$MOUT.err"
# empty user + wrong password: must be FAIL (fail-closed), never "redis OK" as the fallback default user
mon baduser MONITOR_QUEUES=healthy MONITOR_REDIS_USER= MONITOR_REDIS_PASSWORD="wrong-$RPW"
t "empty user + wrong password -> redis FAIL" has '^redis +FAIL'; tn "empty user + wrong password: no redis OK" has '^redis +OK'; t "empty user: rc 1" rc_is 1
tn "empty user: wrong password never printed" grep -qF "wrong-$RPW" "$MOUT" "$MOUT.err"

# =============================================================================================
# 4. Postgres: throwaway DB velto_test, migrations, monitor-role.sql into a throwaway role, synthetic rows
# =============================================================================================
if [[ "$SKIP_PG" != 1 ]]; then
  if [[ "$(padm -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$DB'")" == 1 ]]; then echo "PREREQ: database $DB already exists - refusing (never touch a DB this run did not create)"; exit 3; fi
  padm -d postgres -c "CREATE DATABASE $DB" >/dev/null; DB_CREATED=1
  PGU="postgresql://$PGADMIN:$PGADMINPW@127.0.0.1:$PGPORT_/$DB?schema=public"
  t "prisma migrate deploy on throwaway $DB" bash -c "cd '$REPO' && DATABASE_URL='$PGU' DATABASE_MIGRATE_URL='$PGU' pnpm --filter @velto/database exec prisma migrate deploy >'$W/migrate.log' 2>&1"
  sed -E "s/velto_monitor_fn/$PGFN/g; s/(ROLE|TO) velto_monitor( |;|\$)/\\1 $PGR\\2/g; s/ON DATABASE velto /ON DATABASE $DB /" "$ROLESQL" > "$W/role.sql"
  tn "role sql: no un-substituted role name left" grep -Eq '^[^-]*(ROLE|TO) velto_monitor( |;)' "$W/role.sql"
  ROLES_CREATED=1
  t "monitor-role.sql applies" padm -d "$DB" -q -f "$W/role.sql"
  padm -d postgres -c "ALTER ROLE \"$PGR\" PASSWORD '$PGPW'" >/dev/null
  U='aaaaaaaa-0000-4000-8000-0000000000'   # synthetic uuid prefix (asserted absent from all monitor output)
  padm -d "$DB" -q <<SQL
INSERT INTO "Tenant"(id,name,slug,"updatedAt") VALUES ('${U}01','SynthTenant','synth-montest',now());
INSERT INTO "Company"(id,"tenantId",name,"updatedAt") VALUES ('${U}02','${U}01','SynthCo',now());
INSERT INTO "User"(id,"companyId","firstName","lastName",phone,"updatedAt") VALUES ('${U}03','${U}02','Syn','Thetic','+000000000',now());
-- ImportJob: I1 stale, I2 inside recovery window (12m < 5m backoff + 10m grace), I3 in backoff (attempt 3 = 40m + 10m), I4 fresh; FAILED x1
INSERT INTO "ImportJob"(id,"companyId",type,status,"fileUrl","errorLog","attemptCount","updatedAt") VALUES
 ('${U}11','${U}02','customers','PROCESSING','https://x/SECRET_PAYLOAD_MARKER','{"e":"SECRET_PAYLOAD_MARKER"}',0, now()-interval '30 minutes'),
 ('${U}12','${U}02','customers','PROCESSING','f',NULL,0, now()-interval '12 minutes'),
 ('${U}13','${U}02','customers','PROCESSING','f',NULL,3, now()-interval '30 minutes'),
 ('${U}14','${U}02','customers','PROCESSING','f',NULL,0, now()-interval '1 minute'),
 ('${U}15','${U}02','customers','FAILED','f',NULL,0, now()-interval '5 minutes');
-- ExportJob: E1 '1c' QUEUED stale WITH bull job, E2 company PROCESSING stale WITHOUT job, E3 fresh, E4 FAILED_REVIEW recent
INSERT INTO "ExportJob"(id,"companyId",type,format,"periodFrom","periodTo",status,"errorLog","updatedAt") VALUES
 ('${U}21','${U}02','1c','XML','2026-01-01','2026-01-02','QUEUED','{"e":"SECRET_PAYLOAD_MARKER"}', now()-interval '40 minutes'),
 ('${U}22','${U}02','company','CSV',now(),now(),'QUEUED','{"e":"SECRET_PAYLOAD_MARKER"}', now()-interval '40 minutes'),
 ('${U}23','${U}02','1c','XML','2026-02-01','2026-02-02','QUEUED',NULL, now()-interval '5 minutes'),
 ('${U}24','${U}02','1c','XML','2026-03-01','2026-03-02','QUEUED',NULL, now()-interval '5 minutes');
UPDATE "ExportJob" SET status='PROCESSING', "updatedAt"=now()-interval '40 minutes' WHERE id='${U}22';
UPDATE "ExportJob" SET status='PROCESSING', "updatedAt"=now()-interval '5 minutes' WHERE id='${U}24';
UPDATE "ExportJob" SET status='FAILED', "updatedAt"=now()-interval '5 minutes' WHERE id='${U}24';
-- Notification: N1 PENDING future backoff (old updatedAt, NOT stale), N2 PENDING overdue no job, N3 PENDING NULL next + old updatedAt WITH job, N4 SENDING stale no job, N5 SENDING fresh, N6 PENDING fresh
INSERT INTO "Notification"(id,"companyId","recipientId",type,title,message,"updatedAt","telegramStatus","telegramNextAttemptAt","telegramClaimedAt","telegramLastError") VALUES
 ('${U}31','${U}02','${U}03','t','{}','{"m":"SECRET_PAYLOAD_MARKER"}', now()-interval '2 hours','PENDING', now()+interval '30 minutes',NULL,'SECRET_PAYLOAD_MARKER'),
 ('${U}32','${U}02','${U}03','t','{}','{}', now()-interval '2 hours','PENDING', now()-interval '60 minutes',NULL,NULL),
 ('${U}33','${U}02','${U}03','t','{}','{}', now()-interval '60 minutes','PENDING', NULL,NULL,NULL),
 ('${U}34','${U}02','${U}03','t','{}','{}', now()-interval '2 hours','SENDING', NULL, now()-interval '30 minutes',NULL),
 ('${U}35','${U}02','${U}03','t','{}','{}', now(),'SENDING', NULL, now()-interval '1 minute',NULL),
 ('${U}36','${U}02','${U}03','t','{}','{}', now(),'PENDING', now(),NULL,NULL);
SQL
  # BullMQ jobs that DO exist for E1 (1c-export) and N3 (notification-telegram), delayed 1h so no wait/no_worker noise
  hlp meta 1c-export "$PFX"; hlp add 1c-export "$PFX" "export-${U}21" '{"delay":3600000}'
  hlp add notification-telegram "$PFX" "${U}33" '{"delay":3600000}'
  PGENV=(MONITOR_DB_HOST=127.0.0.1 MONITOR_DB_PORT="$PGPORT_" MONITOR_DB_NAME="$DB" MONITOR_DB_USER="$PGR" MONITOR_DB_PASSWORD="$PGPW" MONITOR_QUEUES=1c-export)
  mon pg "${PGENV[@]}"
  t "jobs_stale counts (backoff-aware)" has '^jobs_stale +WARN import=1 export=2 notif_pending=2 notif_sending=1'
  t "job_mismatch 1st run WARN (only rows w/o BullMQ job)" has '^job_mismatch +WARN .*import=1 export=1 notif=2 \(1st run\)'
  t "jobs_failed OK (2 < 5)" has '^jobs_failed +OK 2 in 60m'; t "db_connections numeric" has '^db_connections +OK [0-9]+'
  mon pg "${PGENV[@]}"; t "job_mismatch 2 in a row -> CRIT" has '^job_mismatch +FAIL .*\(run 2 in a row\)'; t "mismatch rc 1" rc_is 1
  mon pg "${PGENV[@]}" MONITOR_JOB_FAILED_MAX=2; t "jobs_failed threshold -> FAIL" has '^jobs_failed +FAIL 2 in 60m'
  t "pg: monitor checks needed no write (ran as read-only role)" has '^db_connections'
  # role privileges: granted columns only; no payload/PII; no writes even with read-only default switched off
  mrole() { PGPASSWORD="$PGPW" psql -h 127.0.0.1 -p "$PGPORT_" -U "$PGR" -d "$DB" -X -At "$@" 2>&1; }
  t "role: counts on granted columns work" test "$(mrole -c 'SELECT count(*) FROM "ImportJob"')" == 5
  t "role: conn_count works" bash -c '[[ "$1" =~ ^[0-9]+$ ]]' _ "$(mrole -c 'SELECT velto_monitor.conn_count()')"
  for sq in 'SELECT "fileUrl" FROM "ImportJob"' 'SELECT "errorLog" FROM "ImportJob"' 'SELECT "companyId" FROM "ImportJob"' 'SELECT * FROM "ImportJob"' \
    'SELECT "fileName" FROM "ExportJob"' 'SELECT "storageKey" FROM "ExportJob"' 'SELECT * FROM "ExportJob"' 'SELECT message FROM "Notification"' \
    'SELECT title FROM "Notification"' 'SELECT "recipientId" FROM "Notification"' 'SELECT "telegramLastError" FROM "Notification"' \
    'SELECT * FROM "User"' 'SELECT phone FROM "User"' 'SELECT * FROM "Company"' 'SELECT * FROM "AuditLog"'; do
    t "role denied: $sq" bash -c 'grep -q "permission denied" <<<"$1"' _ "$(mrole -c "$sq")"
  done
  for sq in 'INSERT INTO "ImportJob"(id) VALUES (gen_random_uuid())' 'UPDATE "ImportJob" SET status='"'X'" 'DELETE FROM "ImportJob"' \
    'UPDATE "ExportJob" SET status='"'QUEUED'" 'DELETE FROM "ExportJob"' 'UPDATE "Notification" SET "telegramStatus"='"'SENT'" 'DELETE FROM "Notification"' \
    'TRUNCATE "ImportJob"' 'UPDATE "User" SET phone='"'x'"; do
    t "role write denied (read-only default ON): $sq" bash -c 'grep -qE "read-only transaction|permission denied" <<<"$1"' _ "$(mrole -c "$sq")"
    t "role write denied by PRIVILEGES (read-only switched OFF): $sq" bash -c 'grep -q "permission denied" <<<"$1"' _ "$(mrole -c 'SET default_transaction_read_only=off' -c "$sq")"
  done
  cnt_sql="SELECT concat_ws('/', (SELECT count(*) FROM \"ImportJob\"), (SELECT count(*) FROM \"ExportJob\"), (SELECT count(*) FROM \"Notification\"))"
  t "role cannot write: row counts unchanged" test "$(padm -d "$DB" -c "$cnt_sql")" == 5/4/6
  # incident resolved: stale rows removed -> OK, mismatch counter reset
  padm -d "$DB" -q -c "DELETE FROM \"ImportJob\" WHERE id='${U}11'" -c "UPDATE \"ExportJob\" SET \"updatedAt\"=now() WHERE id IN ('${U}21','${U}22')" -c "DELETE FROM \"Notification\" WHERE id IN ('${U}32','${U}33','${U}34')"
  mon pg "${PGENV[@]}"; t "resolved: jobs_stale OK" has '^jobs_stale +OK import=0 export=0 notif_pending=0 notif_sending=0'; t "resolved: job_mismatch OK" has '^job_mismatch +OK'
fi

# =============================================================================================
# 5. leakage + channel assertions over EVERYTHING the monitor printed/sent/persisted
# =============================================================================================
tn "no payload marker / job id / failedReason in any monitor output, alert or state" has_marker "$W/all-output.log" "$W/alerts.log" "$W/curl.log" "$W"/state.*
tn "no DB row uuid in output/alerts/state" grep -rqE 'aaaaaaaa-0000-4000-8000' "$W/all-output.log" "$W/alerts.log" "$W/curl.log" "$W"/state.*
tn "no Redis/PG password in output/alerts/state/curl log" grep -rqF -e "$RPW" -e "$PGPW" "$W/all-output.log" "$W/alerts.log" "$W/curl.log" "$W"/state.*
t "alerts reached the local sink" test "$(alerts)" -ge 3
tn "NO network call to telegram (curl shim log)" grep -qi telegram "$W/curl.log"
t "every curl send went to the local sink only" bash -c '! grep -E "^ARGS:.*CFG: url" "$1" | grep -v "127.0.0.1" | grep -q .' _ "$W/curl.log"

echo "integration-bullmq: pass=$PASS fail=$FAILN time=$((SECONDS-START))s"
[[ $FAILN -eq 0 ]]
