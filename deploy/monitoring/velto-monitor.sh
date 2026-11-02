#!/usr/bin/env bash
# Velto pilot monitor. Checks -> Telegram ops bot. Existing tools only (curl, openssl, df, awk, psql).
# Usage: velto-monitor.sh [--test-alert] [--dry-run] [--env FILE] | --alert <name> <short text> [--severity warn|crit] | --resolve <name>
#   --alert       send one ad-hoc alert (used by deploy/backup/backup-run.sh); exit 1 = NOT DELIVERED.
#                 Deduped per <name> (incident id): same name+severity is suppressed for MONITOR_ALERT_COOLDOWN_SECONDS (default 3600);
#                 a severity change or elapsed cooldown re-alerts; other names are independent.
#   --resolve     close incident <name>: sends RECOVERED once if it was open, no-op otherwise
#   --test-alert  send one test message (proves delivery) and exit
#   --dry-run     run checks, print results, send nothing, keep no state
# Messages contain ONLY check names + numeric values. Never logs/URLs-with-tokens/phones/amounts/PII.
set -uo pipefail

ENV_FILE=/etc/velto/monitor.env; MODE=run; ALERT_NAME=; ALERT_TEXT=; ALERT_SEV=crit
while [[ $# -gt 0 ]]; do
  case "$1" in
    --test-alert) MODE=test ;;
    --dry-run) MODE=dry ;;
    --alert) MODE=alert; ALERT_NAME="${2:?--alert needs <name> <text>}"; ALERT_TEXT="${3:?--alert needs <name> <text>}"; shift 2 ;;
    --severity) ALERT_SEV="${2:?--severity needs warn|crit}"; shift ;;
    --resolve) MODE=resolve; ALERT_NAME="${2:?--resolve needs <name>}"; shift ;;
    --env) ENV_FILE="${2:?--env needs a file}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac; shift
done
if [[ -r "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi

: "${MONITOR_HOST_LABEL:=velto-pilot}" "${MONITOR_TLS_HOST:=}"
: "${MONITOR_TLS_WARN_DAYS:=14}" "${NGINX_ACCESS_LOG:=/var/log/nginx/access.log}"
: "${MONITOR_5XX_WINDOW_LINES:=2000}" "${MONITOR_5XX_MIN_COUNT:=5}" "${MONITOR_5XX_MIN_PERCENT:=5}"
: "${BACKUP_DIR:=/var/backups/velto}" "${MONITOR_BACKUP_MAX_AGE_HOURS:=26}"
: "${MONITOR_DISK_PATHS:=/}" "${MONITOR_DISK_WARN_PERCENT:=80}"
: "${MONITOR_JOB_STUCK_MINUTES:=30}" "${MONITOR_NOTIF_STUCK_MINUTES:=30}"
: "${MONITOR_JOB_FAILED_WINDOW_MINUTES:=60}" "${MONITOR_JOB_FAILED_MAX:=5}"
: "${MONITOR_STATE_DIR:=/var/lib/velto-monitor}" "${MONITOR_REPEAT_MINUTES:=360}"
: "${MONITOR_ALERT_COOLDOWN_SECONDS:=3600}" "${MONITOR_5XX_PATH_PREFIX:=/velto/api/}"
# VELTO_API_HEALTH_URL: REQUIRED, no default (full URL of the API health route reaching the BACKEND, e.g. https://host/velto/api/health/ready).
# Every numeric knob is validated BEFORE it reaches SQL or (( )) (arithmetic expansion would evaluate e.g. a[$(id)]). An invalid value is
# replaced by its safe default AND reported loudly (stderr + a FAIL "config" check in run mode) - never a silent pass.
BADNUM=""
for kv in MONITOR_ALERT_COOLDOWN_SECONDS=3600 MONITOR_TLS_WARN_DAYS=14 MONITOR_5XX_WINDOW_LINES=2000 MONITOR_5XX_MIN_COUNT=5 \
  MONITOR_5XX_MIN_PERCENT=5 MONITOR_BACKUP_MAX_AGE_HOURS=26 MONITOR_DISK_WARN_PERCENT=80 MONITOR_JOB_STUCK_MINUTES=30 \
  MONITOR_NOTIF_STUCK_MINUTES=30 MONITOR_JOB_FAILED_WINDOW_MINUTES=60 MONITOR_JOB_FAILED_MAX=5 MONITOR_REPEAT_MINUTES=360 MONITOR_DB_PORT=5432; do
  nv="${kv%%=*}"; dv="${kv#*=}"; cur="${!nv:-$dv}"
  if [[ "$cur" =~ ^[0-9]{1,9}$ ]]; then printf -v "$nv" '%s' "$((10#$cur))"   # 10# = decimal even for "08"
  else BADNUM+="$nv "; printf -v "$nv" '%s' "$dv"; echo "invalid numeric env $nv (must match ^[0-9]+$, max 9 digits) - using default $dv" >&2; fi
done
[[ "$ALERT_SEV" == warn || "$ALERT_SEV" == crit ]] || { echo "bad --severity" >&2; exit 2; }

send() { # $1 = text. Token only goes to api.telegram.org via stdin config (not argv/ps).
  if [[ "$MODE" == dry ]]; then echo "[dry-run] would send: $1"; return 0; fi
  if [[ -z "${OPS_TG_BOT_TOKEN:-}" || -z "${OPS_TG_CHAT_ID:-}" ]]; then echo "OPS_TG_BOT_TOKEN/OPS_TG_CHAT_ID not set - ALERT NOT DELIVERED" >&2; return 1; fi
  local out
  out="$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$OPS_TG_BOT_TOKEN" |
    curl -sS -m 15 -K - --data-urlencode "chat_id=$OPS_TG_CHAT_ID" --data-urlencode "text=$1" -o - -w ' HTTP_%{http_code}' 2>&1)" || true
  [[ "$out" == *'"ok":true'* ]] && return 0
  echo "telegram send failed:${out##* }" >&2; return 1
}

if [[ "$MODE" == test ]]; then
  send "[$MONITOR_HOST_LABEL] TEST ALERT $(date -u +%FT%TZ). If you read this, delivery works. Reply to the engineer."
  rc=$?; [[ $rc -eq 0 ]] && echo "test alert sent (confirm it was RECEIVED by a human)"; exit $rc
fi

# Per-incident dedup state: $MONITOR_STATE_DIR/alerts/<name> = "<epoch>|<severity>" (dir 0700, files 0600).
alert_state_dir() { umask 077; mkdir -p "$MONITOR_STATE_DIR/alerts" && chmod 700 "$MONITOR_STATE_DIR" "$MONITOR_STATE_DIR/alerts"; }
sane_name() { printf '%s' "$1" | tr -cd 'A-Za-z0-9._-' | cut -c1-40; }

if [[ "$MODE" == alert ]]; then # caller passes check name + short text only (no PII/secrets); control chars stripped, 300 chars max
  txt="$(printf '%s' "$ALERT_TEXT" | tr -d '\000-\037' | cut -c1-300)"; nm="$(sane_name "$ALERT_NAME")"
  [[ -n "$nm" && "$nm" != . && "$nm" != .. ]] || { echo "bad alert name" >&2; exit 2; }
  STATE_DIR_OK=1; alert_state_dir || { STATE_DIR_OK=0; echo "ERROR: state dir $MONITOR_STATE_DIR unusable - sending without dedup" >&2; }
  sf="$MONITOR_STATE_DIR/alerts/$nm"; now="$(date +%s)"; prev=""; [[ -f "$sf" ]] && prev="$(cat "$sf" 2>/dev/null)"
  prev_ts="${prev%%|*}"; prev_sev="${prev#*|}"
  if [[ -n "$prev" && "$prev_ts" =~ ^[0-9]+$ && "$prev_sev" == "$ALERT_SEV" ]] && (( now - prev_ts < MONITOR_ALERT_COOLDOWN_SECONDS )); then
    echo "alert suppressed (dedup, incident $nm, cooldown ${MONITOR_ALERT_COOLDOWN_SECONDS}s)"; exit 0
  fi
  send "[$MONITOR_HOST_LABEL] ALERT($ALERT_SEV) $nm: $txt"; rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "alert sent"
    # The alert is already out; a dedup-state failure is reported as exit 3 (callers must NOT treat it as "not delivered").
    if ! { printf '%s|%s\n' "$now" "$ALERT_SEV" > "$sf.tmp" && mv -f "$sf.tmp" "$sf"; }; then
      echo "ERROR: alert sent but dedup state NOT written ($MONITOR_STATE_DIR/alerts): check owner/permissions (see README first-start order)" >&2; exit 3
    fi
    [[ "$STATE_DIR_OK" == 1 ]] || exit 3
  else echo "ALERT NOT DELIVERED ($nm)" >&2; fi
  exit $rc
fi

if [[ "$MODE" == resolve ]]; then
  nm="$(sane_name "$ALERT_NAME")"; sf="$MONITOR_STATE_DIR/alerts/$nm"
  [[ -n "$nm" && -f "$sf" ]] || exit 0
  send "[$MONITOR_HOST_LABEL] RECOVERED $nm" && { rm -f "$sf" || { echo "ERROR: recovery sent but state file $sf not removed" >&2; exit 3; }; echo "recovery sent"; exit 0; }
  echo "RECOVERY NOT DELIVERED ($nm)" >&2; exit 1
fi

declare -a NAMES=() STATUS=() DETAIL=()
add() { NAMES+=("$1"); STATUS+=("$2"); DETAIL+=("$3"); } # status: OK|FAIL|SKIP

# 0. config sanity (numeric env validated above)
if [[ -n "$BADNUM" ]]; then add config FAIL "invalid numeric env: ${BADNUM% }"; fi

# 1. health/ready (PG + Redis + S3, apps/api/src/health/health.controller.ts). PASS only if HTTP 200 AND the body is the API contract
#    {"status":"up","checks":{...}} - nginx 502/404/HTML pages (even HTTP 200) FAIL. URL is required: no default that could pass by accident.
if [[ -z "${VELTO_API_HEALTH_URL:-}" ]]; then add health_ready FAIL "VELTO_API_HEALTH_URL unset"
else
  hb="$(curl -sS -m 10 -w $'\n%{http_code}' "$VELTO_API_HEALTH_URL" 2>/dev/null || true)"; code="${hb##*$'\n'}"; body="${hb%$'\n'*}"
  if [[ "$code" == 200 && "$body" =~ ^[[:space:]]*\{.*\"status\"[[:space:]]*:[[:space:]]*\"up\".*\"checks\"[[:space:]]*:[[:space:]]*\{.*\"db\"[[:space:]]*:[[:space:]]*\"up\".*\} ]]; then add health_ready OK "http 200 status=up"
  elif [[ "$code" == 200 ]]; then add health_ready FAIL "http 200 but body is not API health contract"
  else add health_ready FAIL "http ${code:-000}"; fi
fi

# 2. TLS expiry
if [[ -n "$MONITOR_TLS_HOST" ]] && command -v openssl >/dev/null; then
  end="$(echo | openssl s_client -servername "$MONITOR_TLS_HOST" -connect "$MONITOR_TLS_HOST:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [[ -z "$end" ]]; then add tls FAIL "cannot read cert"
  else
    if end_s="$(date -d "$end" +%s 2>/dev/null)"; then :; else end_s="$(date -j -f '%b %e %T %Y %Z' "$end" +%s 2>/dev/null || echo 0)"; fi
    days=$(( (end_s - $(date +%s)) / 86400 ))
    (( days >= MONITOR_TLS_WARN_DAYS )) && add tls OK "${days}d left" || add tls FAIL "${days}d left (< $MONITOR_TLS_WARN_DAYS)"
  fi
else add tls SKIP "MONITOR_TLS_HOST unset"; fi

# 3. API 5xx rate from nginx access log (combined format; status = field 9). Counts only.
if [[ -r "$NGINX_ACCESS_LOG" ]]; then
  read -r total bad < <(tail -n "$MONITOR_5XX_WINDOW_LINES" "$NGINX_ACCESS_LOG" | awk -v pfx="$MONITOR_5XX_PATH_PREFIX" 'index($7, pfx) == 1 {t++; if ($9 ~ /^5/) b++} END {print t+0, b+0}')
  pct=0; (( total > 0 )) && pct=$(( bad * 100 / total ))
  if (( bad >= MONITOR_5XX_MIN_COUNT && pct >= MONITOR_5XX_MIN_PERCENT )); then add api_5xx FAIL "$bad/$total (${pct}%)"; else add api_5xx OK "$bad/$total (${pct}%)"; fi
else add api_5xx SKIP "log unreadable"; fi

# 4. backup freshness (backup.sh writes velto-db-*.dump.gpg + .sha256 only after verification)
if [[ -d "$BACKUP_DIR" ]]; then
  newest="$(ls -t "$BACKUP_DIR"/velto-db-*.dump.gpg 2>/dev/null | head -n1)"
  if [[ -z "$newest" ]]; then add backup FAIL "no backup file"
  elif [[ ! -s "$newest.sha256" ]]; then add backup FAIL "newest has no .sha256"
  else
    mt="$(stat -c %Y "$newest" 2>/dev/null || stat -f %m "$newest")"; age_h=$(( ( $(date +%s) - mt ) / 3600 ))
    (( age_h <= MONITOR_BACKUP_MAX_AGE_HOURS )) && add backup OK "age ${age_h}h" || add backup FAIL "age ${age_h}h (> $MONITOR_BACKUP_MAX_AGE_HOURS)"
  fi
else add backup FAIL "BACKUP_DIR missing/unreadable"; fi

# 5. disk
for p in $MONITOR_DISK_PATHS; do
  u="$(df -P "$p" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')"
  [[ -z "$u" ]] && { add "disk:$p" SKIP "n/a"; continue; }
  (( u < MONITOR_DISK_WARN_PERCENT )) && add "disk:$p" OK "${u}%" || add "disk:$p" FAIL "${u}% (>= $MONITOR_DISK_WARN_PERCENT)"
done

# 6. stuck/failed jobs + DB connections (read-only role, counts only; see monitor-role.sql)
# Connection params come from separate vars; the password goes ONLY into a 0600 PGPASSFILE in a 0700 mktemp dir (never argv/ps/logs).
if [[ -n "${MONITOR_DB_NAME:-}" && -n "${MONITOR_DB_USER:-}" ]] && command -v psql >/dev/null; then
  PGTMP="$(umask 077; mktemp -d)" && chmod 700 "$PGTMP"
  trap '[[ -n "${PGTMP:-}" ]] && rm -rf "$PGTMP"' EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
  pw_esc() { local s="$1"; s="${s//\\/\\\\}"; printf '%s' "${s//:/\\:}"; }  # pgpass escaping: \ and : (same as backup/pg-conn.sh)
  if [[ "${MONITOR_DB_HOST:-}${MONITOR_DB_PORT:-}${MONITOR_DB_NAME}${MONITOR_DB_USER}${MONITOR_DB_PASSWORD:-}" == *[$'\r\n']* ]]; then
    echo "ERROR: CR/LF in MONITOR_DB_* config - DB checks disabled" >&2; PGBAD=1
  else
    ( umask 077; printf '%s:%s:%s:%s:%s\n' "$(pw_esc "${MONITOR_DB_HOST:-127.0.0.1}")" "$(pw_esc "${MONITOR_DB_PORT:-5432}")" "$(pw_esc "$MONITOR_DB_NAME")" "$(pw_esc "$MONITOR_DB_USER")" "$(pw_esc "${MONITOR_DB_PASSWORD:-}")" > "$PGTMP/pgpass" ); chmod 600 "$PGTMP/pgpass"
  fi
  q="SELECT
 (SELECT count(*) FROM \"ImportJob\" WHERE status IN ('PENDING','PROCESSING') AND COALESCE(\"updatedAt\",\"createdAt\") < now() - interval '$MONITOR_JOB_STUCK_MINUTES minutes'),
 (SELECT count(*) FROM \"ExportJob\" WHERE status IN ('QUEUED','PROCESSING') AND \"updatedAt\" < now() - interval '$MONITOR_JOB_STUCK_MINUTES minutes'),
 (SELECT count(*) FROM \"Notification\" WHERE \"telegramStatus\" IN ('PENDING','SENDING') AND \"updatedAt\" < now() - interval '$MONITOR_NOTIF_STUCK_MINUTES minutes'),
 (SELECT count(*) FROM \"ImportJob\" WHERE status='FAILED' AND COALESCE(\"updatedAt\",\"createdAt\") > now() - interval '$MONITOR_JOB_FAILED_WINDOW_MINUTES minutes')
 +(SELECT count(*) FROM \"ExportJob\" WHERE status IN ('FAILED','FAILED_REVIEW') AND \"updatedAt\" > now() - interval '$MONITOR_JOB_FAILED_WINDOW_MINUTES minutes'),
 velto_monitor.conn_count()"
  if [[ -z "${PGBAD:-}" ]] && row="$(PGPASSFILE="$PGTMP/pgpass" PGCONNECT_TIMEOUT=5 psql -h "${MONITOR_DB_HOST:-127.0.0.1}" -p "${MONITOR_DB_PORT:-5432}" -U "$MONITOR_DB_USER" -d "$MONITOR_DB_NAME" -w -X -At -F ' ' -v ON_ERROR_STOP=1 -c "$q" 2>/dev/null)" && [[ -n "$row" ]]; then
    read -r si se sn fl conns <<<"$row"
    (( si + se + sn == 0 )) && add jobs_stuck OK "import=$si export=$se notif=$sn" || add jobs_stuck FAIL "import=$si export=$se notif=$sn (> stuck minutes)"
    (( fl < MONITOR_JOB_FAILED_MAX )) && add jobs_failed OK "$fl in ${MONITOR_JOB_FAILED_WINDOW_MINUTES}m" || add jobs_failed FAIL "$fl in ${MONITOR_JOB_FAILED_WINDOW_MINUTES}m"
    add db_connections OK "$conns"
  else add jobs_stuck FAIL "monitor DB query failed"; fi
else add jobs_stuck SKIP "MONITOR_DB_NAME/MONITOR_DB_USER unset"; fi

# report + alert with dedup (state change or repeat every MONITOR_REPEAT_MINUTES)
fails=""; for i in "${!NAMES[@]}"; do
  printf '%-16s %-4s %s\n' "${NAMES[$i]}" "${STATUS[$i]}" "${DETAIL[$i]}"
  [[ "${STATUS[$i]}" == FAIL ]] && fails+="${NAMES[$i]}: ${DETAIL[$i]}"$'\n'
done
if [[ "$MODE" == dry ]]; then [[ -n "$fails" ]] && send "[$MONITOR_HOST_LABEL] ALERT"$'\n'"$fails"; exit 0; fi
STATE_ERR=0
state_fail() { echo "ERROR: $1" >&2; STATE_ERR=1; }
mkdir -p "$MONITOR_STATE_DIR" && chmod 700 "$MONITOR_STATE_DIR" || state_fail "state dir $MONITOR_STATE_DIR unusable (mkdir/chmod failed; see README first-start order) - alerts will not be deduplicated"
sf="$MONITOR_STATE_DIR/last"; prev=""; [[ -f "$sf" ]] && { prev="$(cat "$sf")" || state_fail "cannot read $sf"; }
now="$(date +%s)"; prev_ts="${prev%%|*}"; prev_fp="${prev#*|}"; [[ "$prev_ts" =~ ^[0-9]{1,12}$ ]] || prev_ts=0; fp="$(printf '%s' "$fails" | cksum | cut -d' ' -f1)"
if [[ -n "$fails" ]]; then
  if [[ "$fp" != "$prev_fp" ]] || (( now - ${prev_ts:-0} >= MONITOR_REPEAT_MINUTES * 60 )); then
    # the alert stays sent even if the state write fails (then exit status is non-zero anyway)
    send "[$MONITOR_HOST_LABEL] ALERT"$'\n'"$fails" && { echo "$now|$fp" > "$sf" || state_fail "cannot write $sf (alert already sent, will repeat every run)"; }
  fi
  exit 1
elif [[ -n "$prev_fp" && "$prev_fp" != "$(printf '' | cksum | cut -d' ' -f1)" ]]; then
  send "[$MONITOR_HOST_LABEL] RECOVERED: all checks OK" && { : > "$sf" || state_fail "cannot write $sf (recovery already sent)"; }
fi
exit "$STATE_ERR"
