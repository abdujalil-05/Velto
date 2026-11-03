#!/usr/bin/env bash
# Velto pilot monitor. Checks -> Telegram ops bot. Existing tools only (curl, openssl, df, awk, psql).
# Statuses: OK | WARN (alerted, exit 0) | FAIL (alerted, exit 1) | SKIP (target not configured).
# Usage: velto-monitor.sh [--test-alert] [--dry-run] [--env FILE] | --alert <name> <short text> [--severity warn|crit] | --resolve <name>
#   --alert       send one ad-hoc alert (used by deploy/backup/backup-run.sh); exit 1 = NOT DELIVERED.
#                 Deduped per <name> (incident id): same name+severity is suppressed for MONITOR_ALERT_COOLDOWN_SECONDS (default 3600);
#                 a severity change or elapsed cooldown re-alerts; other names are independent.
#   --resolve     close incident <name>: sends RECOVERED once if it was open, no-op otherwise
#   --test-alert  send one test message (proves delivery) and exit
#   --dry-run     run checks, print results, send nothing, keep no state
# Messages contain ONLY check names + numeric values. Never logs/URLs-with-tokens/phones/amounts/PII.
set -uo pipefail

ENV_FILE=/etc/velto/monitor.env; MODE="run"; ALERT_NAME=; ALERT_TEXT=; ALERT_SEV=crit
while [[ $# -gt 0 ]]; do
  case "$1" in
    --test-alert) MODE="test" ;;
    --dry-run) MODE="dry" ;;
    --alert) MODE="alert"; ALERT_NAME="${2:?--alert needs <name> <text>}"; ALERT_TEXT="${3:?--alert needs <name> <text>}"; shift 2 ;;
    --severity) ALERT_SEV="${2:?--severity needs warn|crit}"; shift ;;
    --resolve) MODE="resolve"; ALERT_NAME="${2:?--resolve needs <name>}"; shift ;;
    --env) ENV_FILE="${2:?--env needs a file}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac; shift
done
# Data-only KEY=VALUE loader (same rules as deploy/env-file.js; never sourced/eval'd). Missing/unreadable file = defaults.
# Refuses (exit 2) a symlink/non-regular file, a file not owned by root or the current uid, group/other-writable, an untrusted ancestor
# directory (mirrors bk_anc_ok in backup-run.sh), or any malformed line. The file is opened ONCE; owner/mode are checked on and the
# content is read from that same fd, so a swap after the check has no effect.
env_stat() { stat -L -c "$1" "$3" 2>/dev/null || stat -L -f "$2" "$3" 2>/dev/null; }
env_anc_ok() { # dir: owned by root or current uid; not group/other-writable, except a ROOT-owned sticky dir
  local st o m; st="$(env_stat '%u %a' '%u %Lp' "$1")" || return 1; o="${st% *}"; m="${st#* }"
  [[ "$m" =~ ^[0-7]{3,4}$ ]] || return 1
  [[ "$o" == 0 || "$o" == "$(id -u)" ]] || return 1
  (( (8#$m & 8#022) == 0 )) || { [[ "$o" == 0 ]] && (( (8#$m & 8#1000) != 0 )); }
}
load_env_file() {
  local f="$1" st own mode ln=0 line key raw d fd=8
  [[ -L "$f" ]] && { echo "env file $f: is a symlink - refusing" >&2; exit 2; }
  d="$(cd "$(dirname "$f")" 2>/dev/null && pwd -P)" || { echo "env file $f: cannot resolve directory" >&2; exit 2; }
  while :; do
    env_anc_ok "$d" || { echo "env file $f: ancestor $d is not owned by root/$(id -u) or is group/other-writable - refusing" >&2; exit 2; }
    [[ "$d" == / ]] && break; d="$(dirname "$d")"
  done
  exec 8<"$f" || { echo "env file $f: cannot open" >&2; exit 2; }
  [[ -f "/dev/fd/$fd" ]] || { echo "env file $f: not a regular file - refusing" >&2; exit 2; }
  # Linux: stat the opened fd. BSD/macOS (dev only: /dev/fd there is not the file) falls back to the path.
  st="$(stat -L -c '%u %a' "/dev/fd/$fd" 2>/dev/null || stat -L -f '%u %Lp' "$f" 2>/dev/null)" || { echo "env file: cannot stat $f" >&2; exit 2; }
  own="${st% *}"; mode="${st#* }"
  [[ "$own" == 0 || "$own" == "$(id -u)" ]] || { echo "env file $f: owner uid $own is neither root nor $(id -u) - refusing" >&2; exit 2; }
  (( (8#$mode & 8#022) == 0 )) || { echo "env file $f: group/other-writable (mode $mode) - refusing" >&2; exit 2; }
  while IFS= read -r line <&"$fd" || [[ -n "$line" ]]; do
    ln=$((ln+1)); line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
    if [[ ! "$line" =~ ^[[:space:]]*([A-Za-z0-9_]+)[[:space:]]*=[[:space:]]*(.*[^[:space:]])?[[:space:]]*$ ]]; then
      echo "env file $f:$ln: not a KEY=VALUE line - refusing" >&2; exit 2
    fi
    key="${BASH_REMATCH[1]}"; raw="${BASH_REMATCH[2]}"
    if [[ "$raw" =~ ^([\'\"])(.*)\1$ ]]; then raw="${BASH_REMATCH[2]}"
    elif [[ "$raw" =~ [[:space:]]# ]]; then echo "env file $f:$ln: $key: inline comment after unquoted value - refusing" >&2; exit 2; fi
    [[ "$key" =~ ^[0-9] ]] && { echo "env file $f:$ln: bad key - refusing" >&2; exit 2; }
    export "$key=$raw"
  done
  exec 8<&-
}
if [[ -L "$ENV_FILE" || -r "$ENV_FILE" ]]; then load_env_file "$ENV_FILE"; fi

: "${MONITOR_HOST_LABEL:=velto-pilot}" "${MONITOR_TLS_HOST:=}"
: "${MONITOR_TLS_WARN_DAYS:=21}" "${NGINX_ACCESS_LOG:=/var/log/nginx/access.log}"
: "${MONITOR_5XX_WINDOW_LINES:=2000}" "${MONITOR_5XX_MIN_COUNT:=5}" "${MONITOR_5XX_MIN_PERCENT:=5}"
: "${BACKUP_DIR:=/var/backups/velto}" "${MONITOR_BACKUP_MAX_AGE_HOURS:=26}"
: "${MONITOR_DISK_PATHS:=/}" "${MONITOR_DISK_WARN_PERCENT:=80}"
: "${MONITOR_JOB_FAILED_WINDOW_MINUTES:=60}" "${MONITOR_JOB_FAILED_MAX:=5}"
: "${MONITOR_STATE_DIR:=/var/lib/velto-monitor}" "${MONITOR_REPEAT_MINUTES:=360}"
: "${MONITOR_ALERT_COOLDOWN_SECONDS:=3600}" "${MONITOR_5XX_PATH_PREFIX:=/velto/api/}"
# Extended checks (all optional: unset target = SKIP, never a silent PASS of something unconfigured).
: "${MONITOR_TLS_CRIT_DAYS:=7}" "${MONITOR_DISK_CRIT_PERCENT:=90}" "${MONITOR_MEM_MIN_AVAIL_PERCENT:=10}" "${MONITOR_MEMINFO:=/proc/meminfo}"
: "${MONITOR_PUBLIC_URL:=}" "${MONITOR_S3_PUBLIC_URL:=}"
: "${MONITOR_BACKUP_STATUS_FILE:=}" "${MONITOR_BACKUP_MAX_AGE_MINUTES:=100}"
: "${MONITOR_OFFSITE_RPO_WARN_MINUTES:=40}" "${MONITOR_OFFSITE_RPO_CRIT_MINUTES:=50}"
: "${MONITOR_REDIS_HOST:=127.0.0.1}" "${MONITOR_REDIS_PORT:=6379}" "${MONITOR_REDIS_USER:=}" "${MONITOR_BULLMQ_PREFIX:=}"
: "${MONITOR_QUEUES:=idempotency-cleanup reconciliation-daily company-export 1c-export import-commit notification-telegram}"
: "${MONITOR_QUEUE_FAILED_DELTA_WARN:=1}" "${MONITOR_QUEUE_FAILED_DELTA_CRIT:=10}" "${MONITOR_NOWORKER_PROBE_SECONDS:=3}"
: "${MONITOR_QUEUE_WAIT_AGE_WARN_MINUTES:=10}" "${MONITOR_QUEUE_WAIT_AGE_CRIT_MINUTES:=30}" "${MONITOR_QUEUE_DELAYED_OVERDUE_MINUTES:=15}"
: "${MONITOR_QUEUE_ACTIVE_LIMIT_MINUTES:=30}" "${MONITOR_QUEUE_ACTIVE_LIMITS:=notification-telegram=5 1c-export=15 company-export=30 import-commit=30}"
: "${MONITOR_STALE_NOTIF_MINUTES:=15}" "${MONITOR_STALE_SENDING_MINUTES:=10}" "${MONITOR_STALE_IMPORT_GRACE_MINUTES:=10}" "${MONITOR_STALE_EXPORT_MINUTES:=25}"
: "${MONITOR_PM2_STATUS_FILE:=}" "${MONITOR_PM2_PROCESS:=velto-api}" "${MONITOR_PM2_RESTART_SPIKE:=3}" "${MONITOR_PM2_STATUS_MAX_AGE_SECONDS:=600}"
: "${MONITOR_ALERT_WEBHOOK_URL:=}" "${MONITOR_ALERT_EMAIL:=}" "${MONITOR_APP_ENV_FILE:=}"
# VELTO_API_HEALTH_URL: REQUIRED, no default (full URL of the API health route reaching the BACKEND, e.g. https://host/velto/api/health/ready).
# Every numeric knob is validated BEFORE it reaches SQL or (( )) (arithmetic expansion would evaluate e.g. a[$(id)]). An invalid value is
# replaced by its safe default AND reported loudly (stderr + a FAIL "config" check in run mode) - never a silent pass.
BADNUM=""
for kv in MONITOR_ALERT_COOLDOWN_SECONDS=3600 MONITOR_TLS_WARN_DAYS=14 MONITOR_5XX_WINDOW_LINES=2000 MONITOR_5XX_MIN_COUNT=5 \
  MONITOR_5XX_MIN_PERCENT=5 MONITOR_BACKUP_MAX_AGE_HOURS=26 MONITOR_DISK_WARN_PERCENT=80 \
  MONITOR_JOB_FAILED_WINDOW_MINUTES=60 MONITOR_JOB_FAILED_MAX=5 MONITOR_REPEAT_MINUTES=360 MONITOR_DB_PORT=5432 \
  MONITOR_TLS_CRIT_DAYS=7 MONITOR_DISK_CRIT_PERCENT=90 MONITOR_MEM_MIN_AVAIL_PERCENT=10 MONITOR_BACKUP_MAX_AGE_MINUTES=100 \
  MONITOR_OFFSITE_RPO_WARN_MINUTES=40 MONITOR_OFFSITE_RPO_CRIT_MINUTES=50 MONITOR_REDIS_PORT=6379 \
  MONITOR_QUEUE_FAILED_DELTA_WARN=1 MONITOR_QUEUE_FAILED_DELTA_CRIT=10 MONITOR_NOWORKER_PROBE_SECONDS=3 \
  MONITOR_QUEUE_WAIT_AGE_WARN_MINUTES=10 MONITOR_QUEUE_WAIT_AGE_CRIT_MINUTES=30 MONITOR_QUEUE_DELAYED_OVERDUE_MINUTES=15 \
  MONITOR_QUEUE_ACTIVE_LIMIT_MINUTES=30 MONITOR_STALE_NOTIF_MINUTES=15 MONITOR_STALE_SENDING_MINUTES=10 \
  MONITOR_STALE_IMPORT_GRACE_MINUTES=10 MONITOR_STALE_EXPORT_MINUTES=25 \
  MONITOR_PM2_RESTART_SPIKE=3 MONITOR_PM2_STATUS_MAX_AGE_SECONDS=600; do
  nv="${kv%%=*}"; dv="${kv#*=}"; cur="${!nv:-$dv}"
  if [[ "$cur" =~ ^[0-9]{1,9}$ ]]; then printf -v "$nv" '%s' "$((10#$cur))"   # 10# = decimal even for "08"
  else BADNUM+="$nv "; printf -v "$nv" '%s' "$dv"; echo "invalid numeric env $nv (must match ^[0-9]+$, max 9 digits) - using default $dv" >&2; fi
done
[[ "$ALERT_SEV" == warn || "$ALERT_SEV" == crit ]] || { echo "bad --severity" >&2; exit 2; }

# --- alert channel: must be SEPARATE from the Velto business bot (TELEGRAM_BOT_TOKEN / business chat) ---
bot_id() { printf '%s' "${1%%:*}"; }
read_app_var() { # $1 = key; value from env, else from MONITOR_APP_ENV_FILE by grep (never sourced, never printed)
  local v="${!1:-}"
  if [[ -z "$v" && -n "$MONITOR_APP_ENV_FILE" && -r "$MONITOR_APP_ENV_FILE" ]]; then
    v="$(grep -m1 -E "^$1=" "$MONITOR_APP_ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '\r')"
    # env-file.js rule: an UNQUOTED value must not carry an inline `# comment`. Here it is stripped (so the real token is compared) and reported.
    if [[ "$v" =~ ^[^\"\'].*[[:space:]]# ]]; then echo "warning: inline comment after $1 in MONITOR_APP_ENV_FILE (not allowed by env-file.js); ignored for the channel-separation check" >&2; v="${v%%[[:space:]]#*}"; fi
    v="$(printf '%s' "$v" | tr -d "\"' ")"
  fi
  printf '%s' "$v"
}
TG_BLOCK=""; app_tok="$(read_app_var TELEGRAM_BOT_TOKEN)"
if [[ -n "${OPS_TG_BOT_TOKEN:-}" && -n "$app_tok" && "$(bot_id "$OPS_TG_BOT_TOKEN")" == "$(bot_id "$app_tok")" ]]; then
  TG_BLOCK="OPS_TG_BOT_TOKEN is the same bot as TELEGRAM_BOT_TOKEN (business bot): alert channel must be separate"
fi
for _v in TELEGRAM_CHAT_ID MONITOR_BUSINESS_CHAT_ID; do
  _c="$(read_app_var "$_v")"
  if [[ -z "$TG_BLOCK" && -n "$_c" && -n "${OPS_TG_CHAT_ID:-}" && "$OPS_TG_CHAT_ID" == "$_c" ]]; then TG_BLOCK="OPS_TG_CHAT_ID equals business chat ($_v): alert channel must be separate"; fi
done
[[ -n "$TG_BLOCK" ]] && echo "CONFIG ERROR: $TG_BLOCK - Telegram alerts DISABLED" >&2

# Defence in depth: whatever a caller passes, strip URLs, bot tokens, emails, phones, and key=value secrets before leaving the host.
ci() { local o="" i lo up; lo="$(printf '%s' "$1" | tr 'A-Z' 'a-z')"; up="$(printf '%s' "$1" | tr 'a-z' 'A-Z')"
  for ((i=0;i<${#1};i++)); do if [[ "${lo:i:1}" == "${up:i:1}" ]]; then o+="${lo:i:1}"; else o+="[${lo:i:1}${up:i:1}]"; fi; done; printf '%s' "$o"; }
redact() {
  local kw; kw="($(ci password)|$(ci passwd)|$(ci pwd)|$(ci token)|$(ci secret)|$(ci otp)|$(ci apikey)|$(ci api_key)|$(ci authorization)|$(ci passphrase))"
  printf '%s' "$1" | sed -E "s#https?://[^[:space:]]+#<url>#g; s#$(ci bearer) +[^[:space:]]+#bearer=<redacted>#g; s#[0-9]{6,}:[A-Za-z0-9_-]{20,}#<token>#g; s#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}#<email>#g; s#\\+[0-9]{9,}#<phone>#g; s#998[0-9]{9}#<phone>#g; s#${kw}[=: ]+[^[:space:]]+#\\1=<redacted>#g"
}

send() { # $1 = text. Channels: Telegram ops bot, optional webhook, optional email; delivered if ANY configured channel accepts. Secrets only via stdin config (not argv/ps).
  local txt rc=1 out configured=0; txt="$(redact "$1")"
  if [[ "$MODE" == dry ]]; then echo "[dry-run] would send: $txt"; return 0; fi
  if [[ -z "$TG_BLOCK" && -n "${OPS_TG_BOT_TOKEN:-}" && -n "${OPS_TG_CHAT_ID:-}" ]]; then
    configured=1
    out="$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$OPS_TG_BOT_TOKEN" |
      curl -sS -m 15 -K - --data-urlencode "chat_id=$OPS_TG_CHAT_ID" --data-urlencode "text=$txt" -o - -w ' HTTP_%{http_code}' 2>&1)" || true
    if [[ "$out" == *'"ok":true'* ]]; then rc=0; else echo "telegram send failed:${out##* }" >&2; fi
  fi
  if [[ -n "$MONITOR_ALERT_WEBHOOK_URL" ]]; then
    configured=1
    out="$(printf 'url = "%s"\n' "$MONITOR_ALERT_WEBHOOK_URL" | curl -sS -m 15 -K - --data-urlencode "text=$txt" -o /dev/null -w 'HTTP_%{http_code}' 2>&1)" || true
    if [[ "$out" =~ HTTP_2[0-9][0-9]$ ]]; then rc=0; else echo "webhook send failed:${out##*HTTP_}" >&2; fi
  fi
  if [[ -n "$MONITOR_ALERT_EMAIL" ]] && command -v mail >/dev/null; then
    configured=1
    if printf '%s\n' "$txt" | mail -s "[$MONITOR_HOST_LABEL] velto-monitor" "$MONITOR_ALERT_EMAIL" 2>/dev/null; then rc=0; else echo "email send failed" >&2; fi
  fi
  if [[ $configured -eq 0 ]]; then echo "no usable alert channel (OPS_TG_BOT_TOKEN/OPS_TG_CHAT_ID, webhook or email) - ALERT NOT DELIVERED" >&2; return 1; fi
  return $rc
}

if [[ "$MODE" == test ]]; then
  send "[$MONITOR_HOST_LABEL] *** TEST ALERT - NOT A REAL INCIDENT *** ts=$(date -u +%FT%TZ). No action needed. Responsible person: confirm receipt to the engineer (monitoring is NOT accepted until you do)."
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
if [[ -n "$TG_BLOCK" ]]; then add alert_channel FAIL "ops Telegram bot/chat not separate from business bot"; fi

# 1. health/ready (PG + Redis + S3, apps/api/src/health/health.controller.ts). PASS only if HTTP 200 AND the body is the API contract
#    {"status":"up","checks":{...}} - nginx 502/404/HTML pages (even HTTP 200) FAIL. URL is required: no default that could pass by accident.
if [[ -z "${VELTO_API_HEALTH_URL:-}" ]]; then add health_ready FAIL "VELTO_API_HEALTH_URL unset"
else
  hb="$(curl -sS -m 10 -w $'\n%{http_code}' "$VELTO_API_HEALTH_URL" 2>/dev/null || true)"; code="${hb##*$'\n'}"; body="${hb%$'\n'*}"
  if [[ "$code" == 200 && "$body" =~ ^[[:space:]]*\{.*\"status\"[[:space:]]*:[[:space:]]*\"up\".*\"checks\"[[:space:]]*:[[:space:]]*\{.*\"db\"[[:space:]]*:[[:space:]]*\"up\".*\} ]]; then add health_ready OK "http 200 status=up"
    for dep in redis storage; do   # same body: PG is required above; Redis PING + S3 HeadBucket reported separately
      if [[ "$body" =~ \"$dep\"[[:space:]]*:[[:space:]]*\"up\" ]]; then add "health_$dep" OK up; else add "health_$dep" FAIL "not up in health body"; fi
    done
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
    if (( days < MONITOR_TLS_CRIT_DAYS )); then add tls FAIL "${days}d left (< $MONITOR_TLS_CRIT_DAYS crit)"
    elif (( days < MONITOR_TLS_WARN_DAYS )); then add tls WARN "${days}d left (< $MONITOR_TLS_WARN_DAYS)"
    else add tls OK "${days}d left"; fi
  fi
else add tls SKIP "MONITOR_TLS_HOST unset"; fi

# 3. API 5xx rate from nginx access log (combined format; status = field 9). Counts only.
if [[ -r "$NGINX_ACCESS_LOG" ]]; then
  read -r total bad < <(tail -n "$MONITOR_5XX_WINDOW_LINES" "$NGINX_ACCESS_LOG" | awk -v pfx="$MONITOR_5XX_PATH_PREFIX" 'index($7, pfx) == 1 {t++; if ($9 ~ /^5/) b++} END {print t+0, b+0}')
  pct=0; (( total > 0 )) && pct=$(( bad * 100 / total ))
  if (( bad >= MONITOR_5XX_MIN_COUNT && pct >= MONITOR_5XX_MIN_PERCENT )); then add api_5xx FAIL "$bad/$total (${pct}%)"; else add api_5xx OK "$bad/$total (${pct}%)"; fi
else add api_5xx SKIP "log unreadable"; fi

# 4. backup freshness. Preferred: root-owned attestation file MONITOR_BACKUP_STATUS_FILE (key=value lines, parsed with grep, NEVER sourced):
#    ts=<epoch of last fully verified local backup>  result=ok   (local: crit if result!=ok, older than MONITOR_BACKUP_MAX_AGE_MINUTES (100) or future)
#    offsite_restore_point_ts=<restore point (epoch before pg_dump start) of the newest set CONFIRMED offsite by listing incl. manifest; kept on failure>
#    offsite_ts=<when confirmed>  offsite_result=ok|failed (last upload attempt)   [restore_point_ts = local set's restore point, informational]
#    backup_offsite_rpo = now - offsite_restore_point_ts: WARN > MONITOR_OFFSITE_RPO_WARN_MINUTES (40), CRIT > ..._CRIT_MINUTES (50; must stay < RPO 60 - run interval - delivery);
#    missing/invalid/future = CRIT "no confirmed restore point". backup_offsite_upload: offsite_result=failed = CRIT (separate incident from the RPO one).
#    Legacy fallback (status file var empty): newest velto-db-*.dump.gpg in BACKUP_DIR with .sha256, age in hours.
sfield() { grep -m1 -E "^$1=" "$MONITOR_BACKUP_STATUS_FILE" 2>/dev/null | cut -d= -f2- | tr -d ' \r\t'; }
age_check() { # name tsvalue resultvalue max_minutes
  local nm="$1" tsv="$2" rv="$3" mx="$4" nowt age
  nowt="$(date +%s)"
  if [[ ! "$tsv" =~ ^[0-9]{1,12}$ ]]; then add "$nm" FAIL "ts missing/invalid"; return; fi
  if [[ "$rv" != ok ]]; then add "$nm" FAIL "result=${rv:-missing}"; return; fi
  if (( tsv > nowt + 300 )); then add "$nm" FAIL "ts in the future"; return; fi
  age=$(( (nowt - tsv) / 60 ))
  if (( age <= mx )); then add "$nm" OK "age ${age}m"; else add "$nm" FAIL "age ${age}m (> $mx)"; fi
}
offsite_check() { # restore_point_ts result confirmed_ts
  local rp="$1" rs="$2" ct="$3" nowt age cinfo=""
  nowt="$(date +%s)"; [[ "$ct" =~ ^[0-9]{1,12}$ ]] && (( ct <= nowt )) && cinfo=", confirmed $(( (nowt - 10#$ct) / 60 ))m ago"
  if [[ ! "$rp" =~ ^[0-9]{1,12}$ ]]; then add backup_offsite_rpo FAIL "no confirmed restore point (missing/invalid offsite_restore_point_ts)"
  elif (( 10#$rp > nowt + 60 )); then add backup_offsite_rpo FAIL "no confirmed restore point (offsite_restore_point_ts in the future)"
  else
    age=$(( (nowt - 10#$rp) / 60 ))
    if (( age > MONITOR_OFFSITE_RPO_CRIT_MINUTES )); then add backup_offsite_rpo FAIL "restore point age ${age}m (> $MONITOR_OFFSITE_RPO_CRIT_MINUTES crit)$cinfo"
    elif (( age > MONITOR_OFFSITE_RPO_WARN_MINUTES )); then add backup_offsite_rpo WARN "restore point age ${age}m (> $MONITOR_OFFSITE_RPO_WARN_MINUTES warn)$cinfo"
    else add backup_offsite_rpo OK "restore point age ${age}m$cinfo"; fi
  fi
  case "$rs" in
    ok) add backup_offsite_upload OK "last upload ok" ;;
    failed) add backup_offsite_upload FAIL "last offsite upload attempt failed" ;;
    *) add backup_offsite_upload FAIL "offsite_result missing/invalid" ;;
  esac
}
if [[ -n "$MONITOR_BACKUP_STATUS_FILE" ]]; then
  if [[ -r "$MONITOR_BACKUP_STATUS_FILE" ]]; then
    age_check backup "$(sfield ts)" "$(sfield result)" "$MONITOR_BACKUP_MAX_AGE_MINUTES"
    offsite_check "$(sfield offsite_restore_point_ts)" "$(sfield offsite_result)" "$(sfield offsite_ts)"
  else add backup FAIL "status file missing/unreadable"; add backup_offsite_rpo FAIL "status file missing/unreadable"; add backup_offsite_upload FAIL "status file missing/unreadable"; fi
elif [[ -d "$BACKUP_DIR" ]]; then
  add backup_offsite_rpo SKIP "MONITOR_BACKUP_STATUS_FILE unset (offsite state unknown)"
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
  if (( u >= MONITOR_DISK_CRIT_PERCENT )); then add "disk:$p" FAIL "${u}% (>= $MONITOR_DISK_CRIT_PERCENT crit)"
  elif (( u >= MONITOR_DISK_WARN_PERCENT )); then add "disk:$p" WARN "${u}% (>= $MONITOR_DISK_WARN_PERCENT)"
  else add "disk:$p" OK "${u}%"; fi
done

# 5b. memory (MemAvailable / MemTotal)
if [[ -r "$MONITOR_MEMINFO" ]]; then
  read -r mt_kb ma_kb < <(awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} END {print t+0, a+0}' "$MONITOR_MEMINFO")
  if (( mt_kb > 0 )); then
    mp=$(( ma_kb * 100 / mt_kb ))
    (( mp >= MONITOR_MEM_MIN_AVAIL_PERCENT )) && add memory OK "${mp}% available" || add memory FAIL "${mp}% available (< $MONITOR_MEM_MIN_AVAIL_PERCENT)"
  else add memory FAIL "meminfo unparsable"; fi
else add memory SKIP "meminfo unreadable"; fi

# 5c. local curl of the PUBLIC https URL (through nginx+TLS). NOT a substitute for an external uptime service (see README).
if [[ -n "$MONITOR_PUBLIC_URL" ]]; then
  pc="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$MONITOR_PUBLIC_URL" 2>/dev/null || true)"
  if [[ "$pc" =~ ^[23][0-9][0-9]$ ]]; then add public_https OK "http $pc"; else add public_https FAIL "http ${pc:-000}"; fi
else add public_https SKIP "MONITOR_PUBLIC_URL unset"; fi

# 5d. S3: anonymous HEAD on the bucket URL MUST be denied (401/403). 2xx/3xx = publicly readable = FAIL. Reachability with credentials = health_storage.
if [[ -n "$MONITOR_S3_PUBLIC_URL" ]]; then
  sc="$(curl -sS -I -m 10 -o /dev/null -w '%{http_code}' "$MONITOR_S3_PUBLIC_URL" 2>/dev/null || true)"
  case "$sc" in
    401|403) add s3_anon_denied OK "http $sc" ;;
    2??|3??) add s3_anon_denied FAIL "anonymous HEAD allowed (http $sc)" ;;
    *) add s3_anon_denied FAIL "unexpected http ${sc:-000}" ;;
  esac
else add s3_anon_denied SKIP "MONITOR_S3_PUBLIC_URL unset"; fi

# 5e. Redis + BullMQ, STRICTLY read-only (PING ACL-WHOAMI EXISTS LLEN LINDEX LRANGE ZCARD ZRANGE HGET XRANGE XREVRANGE; README ACL). Password via REDISCLI_AUTH, never argv.
#     Keys: $MONITOR_BULLMQ_PREFIX:<queue>:{meta,wait,active,delayed,paused,failed,events,stalled-check,<jobId>}. Only fixed fields are parsed
#     (timestamp, delay, processedOn, stc, stream "event"/"jobId"); job data/returnvalue/failedReason are never requested, parsed or printed;
#     job ids are used only to build keys. Output = queue names + numbers. Per-queue state (last stream id; failed = `failed` events since it): $MONITOR_STATE_DIR/q.<queue>.*
REDIS_UP=0; NWC=()
st_get() { [[ "$MODE" == dry ]] && return 0; head -n1 "$MONITOR_STATE_DIR/$1" 2>/dev/null | tr -cd '0-9-'; }
st_put() { [[ "$MODE" == dry ]] && return 0; ( umask 077; mkdir -p "$MONITOR_STATE_DIR" && t="$(mktemp "$MONITOR_STATE_DIR/.$1.XXXXXX")" && { { printf '%s\n' "$2" > "$t" && mv -f "$t" "$MONITOR_STATE_DIR/$1"; } || { rm -f "$t"; false; }; } ) 2>/dev/null || echo "WARN: cannot persist $1 in $MONITOR_STATE_DIR" >&2; }
id_lt() { local a="$1" b="$2"; (( 10#${a%-*} < 10#${b%-*} || ( 10#${a%-*} == 10#${b%-*} && 10#${a#*-} < 10#${b#*-} ) )); } # stream ids "ms-seq"
active_limit() { local t v; for t in $MONITOR_QUEUE_ACTIVE_LIMITS; do
    if [[ "$t" == "$1="* ]]; then v="${t#*=}"; if [[ "$v" =~ ^[0-9]{1,6}$ ]]; then echo $((10#$v)); return; fi; fi; done
  echo "$MONITOR_QUEUE_ACTIVE_LIMIT_MINUTES"; }
qadd() { add "$1" "$2" "$3"; QISSUE=1; }
scan_events() { # $1 queue $2 key-prefix $3 ZCARD failed (informational): stalled / retries-exhausted / failed events since the stored stream id
  local q="$1" k="$2" ftot="$3" stored last first cur out parsed sn=0 en=0 fn=0 jids="" l v j stc hi=0 rrc
  SCAN_FD=0
  stored="$(st_get "q.$q.evid")"
  if [[ ! "$stored" =~ ^[0-9]+-[0-9]+$ ]]; then   # first run (or dry-run): baseline only, old events are not alerts
    last="$(rcli XREVRANGE "$k:events" + - COUNT 1)"; rrc=$?; last="${last%%$'\n'*}"
    if (( rrc != 0 )); then qadd "queue_events:$q" FAIL "cannot read events stream (redis error)"; return   # error: never baseline 0-0
    elif [[ -z "$last" ]]; then last="0-0"; elif [[ ! "$last" =~ ^[0-9]+-[0-9]+$ ]]; then qadd "queue_events:$q" FAIL "cannot read events stream (ACL?)"; return; fi
    st_put "q.$q.evid" "$last"; return
  fi
  first="$(rcli XRANGE "$k:events" - + COUNT 1 | head -n1)"
  if [[ "$first" =~ ^[0-9]+-[0-9]+$ ]] && [[ "$stored" != 0-0 ]] && id_lt "$stored" "$first"; then
    qadd "queue_events_gap:$q" WARN "events stream trimmed past last seen id - stalled/exhausted events may have been missed"
  elif [[ -n "$first" && ! "$first" =~ ^[0-9]+-[0-9]+$ ]]; then qadd "queue_events:$q" FAIL "cannot read events stream (ACL?)"; return; fi
  cur="$stored"
  for _ in 1 2 3 4 5; do
    out="$(rcli XRANGE "$k:events" "($cur" + COUNT 1000)"; [[ -n "$out" ]] || break
    parsed="$(printf '%s\n' "$out" | awk '
      { line=$0
        if (want==2) { want=(line=="jobId")?1:0 }
        else if (want==1) { if (nj<20 && length(line)<=100 && line ~ /^[A-Za-z0-9_-]+$/) { print "J " line; nj++ } want=0 }
        if (line ~ /^[0-9]+-[0-9]+$/) last=line
        if (prev=="event") { if (line=="stalled") { s++; want=2 } else if (line=="retries-exhausted") e++; else if (line=="failed") f++ }
        prev=line }
      END { print "L " last; print "S " s+0; print "E " e+0; print "F " f+0 }')"
    last=""
    while read -r l v; do
      case "$l" in L) last="$v" ;; S) sn=$((sn + v)) ;; E) en=$((en + v)) ;; F) fn=$((fn + v)) ;; J) jids+="$v "; esac
    done <<<"$parsed"
    if [[ ! "$last" =~ ^[0-9]+-[0-9]+$ ]] || ! id_lt "$cur" "$last"; then break; fi
    cur="$last"
  done
  st_put "q.$q.evid" "$cur"
  for j in $jids; do   # job stall counter (stc) >= 2: same job stalled repeatedly
    stc="$(rcli HGET "$k:$j" stc)"; [[ "$stc" =~ ^[0-9]{1,6}$ ]] && (( 10#$stc >= 2 )) && hi=$((hi + 1))
  done
  if (( sn >= 3 || hi > 0 )); then qadd "queue_stalled:$q" FAIL "stalled events +$sn since last run, jobs with stc>=2: $hi"
  elif (( sn > 0 )); then qadd "queue_stalled:$q" WARN "stalled events +$sn since last run"; fi
  (( en > 0 )) && qadd "queue_exhausted:$q" FAIL "retries-exhausted events +$en since last run"
  SCAN_FD=$fn   # failed events (not the capped ZCARD, which is blind once removeOnFail trims the set)
  if (( fn >= MONITOR_QUEUE_FAILED_DELTA_CRIT )); then qadd "queue_failed:$q" FAIL "failed events +$fn since last run (failed set size $ftot)"
  elif (( fn >= MONITOR_QUEUE_FAILED_DELTA_WARN )); then qadd "queue_failed:$q" WARN "failed events +$fn since last run (failed set size $ftot)"; fi
  return 0
}
qcheck() { # one queue; $1 = sane name
  local q="$1" k="$MONITOR_BULLMQ_PREFIX:$1" nowm w a d p f oid ts dl wage lim aid pt amax=0 aover=0 sc am atm fo po ref
  QISSUE=0; nowm=$(( $(date +%s) * 1000 ))
  if [[ "$(rcli EXISTS "$k:meta")" != 1 ]]; then add "queue_meta:$q" FAIL "no $MONITOR_BULLMQ_PREFIX:$q:meta - BullMQ prefix mismatch (MONITOR_BULLMQ_PREFIX) or queue never created"; return; fi
  w="$(rcli LLEN "$k:wait")"; a="$(rcli LLEN "$k:active")"; d="$(rcli ZCARD "$k:delayed")"; p="$(rcli LLEN "$k:paused")"; f="$(rcli ZCARD "$k:failed")"
  if [[ ! "$w" =~ ^[0-9]+$ || ! "$a" =~ ^[0-9]+$ || ! "$d" =~ ^[0-9]+$ || ! "$p" =~ ^[0-9]+$ || ! "$f" =~ ^[0-9]+$ ]]; then add "queue:$q" FAIL "bad redis reply (ACL?)"; return; fi
  (( p > 0 )) && qadd "queue_paused:$q" WARN "queue paused ($p waiting in paused list)"
  if (( w > 0 )); then   # oldest waiting job = list tail; effective wait start = timestamp + delay (promoted delayed/backoff jobs)
    oid="$(rcli LINDEX "$k:wait" -1)"
    if [[ "$oid" =~ ^[A-Za-z0-9_-]{1,100}$ ]]; then
      ts="$(rcli HGET "$k:$oid" timestamp)"; dl="$(rcli HGET "$k:$oid" delay)"; [[ "$dl" =~ ^[0-9]{1,12}$ ]] || dl=0
      if [[ "$ts" =~ ^[0-9]{10,16}$ ]]; then
        ref=$(( 10#$ts + 10#$dl ))
        atm="$(rcli HGET "$k:$oid" atm)"; [[ "$atm" =~ ^[0-9]{1,6}$ ]] || atm="$(rcli HGET "$k:$oid" attemptsMade)"
        if [[ "$atm" =~ ^[0-9]{1,6}$ ]] && (( 10#$atm > 0 )); then   # retried job back in wait after backoff: age from its last attempt, not from creation
          po="$(rcli HGET "$k:$oid" processedOn)"; fo="$(rcli HGET "$k:$oid" finishedOn)"; ref=0
          [[ "$po" =~ ^[0-9]{10,16}$ ]] && ref=$((10#$po)); [[ "$fo" =~ ^[0-9]{10,16}$ ]] && (( 10#$fo > ref )) && ref=$((10#$fo))
          (( ref > 0 )) || ref=$(( 10#$ts + 10#$dl ))
        fi
        wage=$(( (nowm - ref) / 60000 )); (( wage < 0 )) && wage=0
        if (( wage > MONITOR_QUEUE_WAIT_AGE_CRIT_MINUTES )); then qadd "queue_wait_age:$q" FAIL "oldest waiting job ${wage}m (> $MONITOR_QUEUE_WAIT_AGE_CRIT_MINUTES crit), wait=$w"
        elif (( wage > MONITOR_QUEUE_WAIT_AGE_WARN_MINUTES )); then qadd "queue_wait_age:$q" WARN "oldest waiting job ${wage}m (> $MONITOR_QUEUE_WAIT_AGE_WARN_MINUTES warn), wait=$w"; fi
      fi
    fi
    [[ "$(rcli EXISTS "$k:stalled-check")" == 0 ]] && NWC+=("$q")   # probe 1; confirmed after the loop
  fi
  if (( a > 0 )); then
    lim="$(active_limit "$q")"
    for aid in $(rcli LRANGE "$k:active" -20 -1); do
      [[ "$aid" =~ ^[A-Za-z0-9_-]{1,100}$ ]] || continue
      pt="$(rcli HGET "$k:$aid" processedOn)"; [[ "$pt" =~ ^[0-9]{10,16}$ ]] || continue
      am=$(( (nowm - 10#$pt) / 60000 )); (( am > amax )) && amax=$am; (( am > lim )) && aover=$((aover + 1))
    done
    if (( amax > 2 * lim )); then qadd "queue_active_age:$q" FAIL "active job running ${amax}m (> 2x$lim crit), over limit: $aover"
    elif (( amax > lim )); then qadd "queue_active_age:$q" WARN "active job running ${amax}m (> $lim warn), over limit: $aover"; fi
  fi
  if (( d > 0 )); then   # delayed is normal (retry backoff, schedulers): never CRIT; WARN only when the earliest is overdue
    sc="$(rcli ZRANGE "$k:delayed" 0 0 WITHSCORES | sed -n 2p)"
    if [[ "$sc" =~ ^[0-9]{1,18}$ ]]; then
      wage=$(( (nowm - (10#$sc >> 12)) / 60000 ))
      (( wage > MONITOR_QUEUE_DELAYED_OVERDUE_MINUTES )) && qadd "queue_delayed:$q" WARN "earliest delayed job overdue ${wage}m (> $MONITOR_QUEUE_DELAYED_OVERDUE_MINUTES), delayed=$d"
    fi
  fi
  scan_events "$q" "$k" "$f"
  (( QISSUE == 0 )) && add "queue:$q" OK "wait=$w active=$a delayed=$d paused=$p failed+=$SCAN_FD"
  return 0
}
if [[ -n "${MONITOR_REDIS_PASSWORD:-}" || -n "$MONITOR_REDIS_USER" ]] && command -v redis-cli >/dev/null; then
  TMO=""; command -v timeout >/dev/null && TMO="timeout 5"
  rcli() { REDISCLI_AUTH="${MONITOR_REDIS_PASSWORD:-}" ${TMO:+$TMO} redis-cli -h "$MONITOR_REDIS_HOST" -p "$MONITOR_REDIS_PORT" ${MONITOR_REDIS_USER:+--user "$MONITOR_REDIS_USER"} --no-auth-warning "$@" 2>/dev/null; }
  # a wrong password makes redis-cli fall back to the unauthenticated `default` user (PING still works): require ACL WHOAMI == the configured user
  if [[ -z "$MONITOR_REDIS_USER" || "$MONITOR_REDIS_USER" == default ]]; then   # fail-closed: never run as the (unauthenticated-fallback) default user
    add redis FAIL "redis: monitor user not configured / user=default not allowed (set MONITOR_REDIS_USER to the read-only ACL user)"; add queues SKIP "redis user not configured - queue checks NOT run"
  elif [[ "$(rcli PING)" == PONG && "$(rcli ACL WHOAMI)" == "$MONITOR_REDIS_USER" ]]; then
    REDIS_UP=1; add redis OK PONG
    if [[ ! "$MONITOR_BULLMQ_PREFIX" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then add queue_prefix FAIL "MONITOR_BULLMQ_PREFIX unset/invalid (required, e.g. the app BULLMQ_PREFIX) - queue checks NOT run"; REDIS_UP=0
    else
      for qn in $MONITOR_QUEUES; do qn="$(sane_name "$qn")"; [[ -n "$qn" ]] && qcheck "$qn"; done
      if (( ${#NWC[@]} > 0 )); then   # worker heartbeat = stalled-check key (SET PX by live workers each stalledInterval); require 2 probes
        sleep "$MONITOR_NOWORKER_PROBE_SECONDS"
        for qn in "${NWC[@]}"; do
          [[ "$(rcli EXISTS "$MONITOR_BULLMQ_PREFIX:$qn:stalled-check")" == 0 ]] && add "queue_no_worker:$qn" FAIL "jobs waiting and no worker heartbeat (2 probes ${MONITOR_NOWORKER_PROBE_SECONDS}s apart)"
        done
      fi
    fi
  else add redis FAIL "no PONG / auth failed (wrong user/password, or ACL lacks +acl|whoami)"; add queues SKIP "redis unavailable - queue checks NOT run"; fi
else add redis SKIP "MONITOR_REDIS_PASSWORD/MONITOR_REDIS_USER unset"; add queues SKIP "redis not configured - queue checks NOT run"; fi

# 5f. PM2 via snapshot file written by pm2-status-export.sh (runs as the PM2 user; monitor needs no sudo/pm2 access, keeps NoNewPrivileges).
#     File: ts=<epoch>, proc.<name>.status=<online|...>, proc.<name>.restarts=<n>. Crit: stale/missing, not online, or restarts grew by >= MONITOR_PM2_RESTART_SPIKE since previous run.
if [[ -n "$MONITOR_PM2_STATUS_FILE" ]]; then
  pf() { grep -m1 -E "^$1=" "$MONITOR_PM2_STATUS_FILE" 2>/dev/null | cut -d= -f2- | tr -d ' \r\t'; }
  if [[ ! -r "$MONITOR_PM2_STATUS_FILE" ]]; then add pm2 FAIL "status file missing/unreadable"
  else
    pn="$(sane_name "$MONITOR_PM2_PROCESS")"; pts="$(pf ts)"; pst="$(pf "proc.$pn.status")"; prs="$(pf "proc.$pn.restarts")"
    if [[ ! "$pts" =~ ^[0-9]{1,12}$ ]] || (( $(date +%s) - pts > MONITOR_PM2_STATUS_MAX_AGE_SECONDS )); then add pm2 FAIL "status snapshot stale/invalid"
    elif [[ "$pst" != online ]]; then add pm2 FAIL "$pn status=${pst:-missing}"
    elif [[ ! "$prs" =~ ^[0-9]+$ ]]; then add pm2 FAIL "$pn restarts unreadable"
    else
      prev_rs=""; rsf="$MONITOR_STATE_DIR/pm2_restarts.$pn"; [[ "$MODE" != dry && -f "$rsf" ]] && prev_rs="$(cat "$rsf" 2>/dev/null)"
      delta=0; [[ "$prev_rs" =~ ^[0-9]+$ ]] && (( prs >= prev_rs )) && delta=$(( prs - prev_rs ))
      if [[ "$MODE" != dry ]]; then ( umask 077; mkdir -p "$MONITOR_STATE_DIR" && printf '%s\n' "$prs" > "$rsf" ) 2>/dev/null || echo "WARN: cannot persist pm2 restart counter in $MONITOR_STATE_DIR" >&2; fi
      if (( delta >= MONITOR_PM2_RESTART_SPIKE )); then add pm2 FAIL "$pn online, restarts +$delta since last run (total $prs)"; else add pm2 OK "$pn online restarts=$prs (+$delta)"; fi
    fi
  fi
else add pm2 SKIP "MONITOR_PM2_STATUS_FILE unset"; fi

# 6. stale/failed jobs (backoff-aware) + job_mismatch + DB connections (read-only role, counts only; see monitor-role.sql)
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
  # Stale = backoff-aware (rows that LEGITIMATELY wait for a retry are not stale). Counts only; columns: status/timestamps/attemptCount/type (monitor-role.sql).
  #  Notification PENDING: COALESCE(telegramNextAttemptAt, updatedAt) older than N min (a future backoff is NOT stale); SENDING: telegramClaimedAt older than N min
  #  ImportJob PROCESSING: updatedAt older than recovery backoff LEAST(3600, 300*2^attemptCount)s + grace (import-recovery.service.ts BACKOFF)
  #  ExportJob QUEUED/PROCESSING: updatedAt older than N min
  w_imp="\"status\"='PROCESSING' AND \"updatedAt\" < now() - make_interval(secs => LEAST(3600, 300 * POWER(2, LEAST(\"attemptCount\", 12)))) - interval '$MONITOR_STALE_IMPORT_GRACE_MINUTES minutes'"
  w_exp="\"status\" IN ('QUEUED','PROCESSING') AND \"updatedAt\" < now() - interval '$MONITOR_STALE_EXPORT_MINUTES minutes'"
  w_np="\"telegramStatus\"='PENDING' AND COALESCE(\"telegramNextAttemptAt\",\"updatedAt\") < now() - interval '$MONITOR_STALE_NOTIF_MINUTES minutes'"
  w_ns="\"telegramStatus\"='SENDING' AND \"telegramClaimedAt\" < now() - interval '$MONITOR_STALE_SENDING_MINUTES minutes'"
  q="SELECT
 (SELECT count(*) FROM \"ImportJob\" WHERE $w_imp),
 (SELECT count(*) FROM \"ExportJob\" WHERE $w_exp),
 (SELECT count(*) FROM \"Notification\" WHERE $w_np),
 (SELECT count(*) FROM \"Notification\" WHERE $w_ns),
 (SELECT count(*) FROM \"ImportJob\" WHERE status='FAILED' AND COALESCE(\"updatedAt\",\"createdAt\") > now() - interval '$MONITOR_JOB_FAILED_WINDOW_MINUTES minutes')
 +(SELECT count(*) FROM \"ExportJob\" WHERE status IN ('FAILED','FAILED_REVIEW') AND \"updatedAt\" > now() - interval '$MONITOR_JOB_FAILED_WINDOW_MINUTES minutes'),
 velto_monitor.conn_count()"
  # ids of stale rows (<=200, kept in memory only, NEVER printed) -> job_mismatch: does the BullMQ job key still exist?
  qids="SELECT k, id FROM (
 (SELECT 'i' AS k, id::text FROM \"ImportJob\" WHERE $w_imp LIMIT 200)
 UNION ALL (SELECT CASE type WHEN '1c' THEN 'e' WHEN 'company' THEN 'c' ELSE 'x' END, id::text FROM \"ExportJob\" WHERE $w_exp LIMIT 200)
 UNION ALL (SELECT 'n', id::text FROM \"Notification\" WHERE ($w_np) OR ($w_ns) LIMIT 200)) s LIMIT 200"
  pgq() { PGPASSFILE="$PGTMP/pgpass" PGCONNECT_TIMEOUT=5 psql -h "${MONITOR_DB_HOST:-127.0.0.1}" -p "${MONITOR_DB_PORT:-5432}" -U "$MONITOR_DB_USER" -d "$MONITOR_DB_NAME" -w -X -At -F ' ' -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null; }
  if [[ -z "${PGBAD:-}" ]] && row="$(pgq "$q")" && [[ -n "$row" ]]; then
    read -r si se sn ss fl conns <<<"$row"
    stale_ok=0
    if [[ ! "$si$se$sn$ss$fl" =~ ^[0-9]+$ || ! "$conns" =~ ^[0-9]+$ ]]; then add jobs_stale FAIL "monitor DB reply unparsable"
    elif (( si + se + sn + ss == 0 )); then stale_ok=1; add jobs_stale OK "import=0 export=0 notif_pending=0 notif_sending=0"
    else stale_ok=2; add jobs_stale WARN "import=$si export=$se notif_pending=$sn notif_sending=$ss (past backoff/lease limits)"; fi
    if (( stale_ok > 0 )); then
      if (( fl < MONITOR_JOB_FAILED_MAX )); then add jobs_failed OK "$fl in ${MONITOR_JOB_FAILED_WINDOW_MINUTES}m"; else add jobs_failed FAIL "$fl in ${MONITOR_JOB_FAILED_WINDOW_MINUTES}m"; fi
      add db_connections OK "$conns"
    fi
    # job_mismatch: stale DB row with NO BullMQ job key (lost enqueue / wrong prefix / flushed Redis). 1 run = WARN, 2 consecutive = CRIT. Counts only.
    if (( stale_ok == 1 )); then st_put job_mismatch 0; add job_mismatch OK "no stale rows"
    elif (( stale_ok == 2 )); then
      if (( REDIS_UP == 1 )); then
        mi=0; me=0; mn=0; chkd=0
        while read -r kd jid; do
          [[ "$jid" =~ ^[0-9a-f-]{36}$ ]] || continue
          case "$kd" in i) jq="import-commit"; jk="import-$jid" ;; e) jq="1c-export"; jk="export-$jid" ;; c) jq="company-export"; jk="export-$jid" ;; n) jq="notification-telegram"; jk="$jid" ;; *) continue ;; esac
          ex="$(rcli EXISTS "$MONITOR_BULLMQ_PREFIX:$jq:$jk")"; [[ "$ex" == 0 || "$ex" == 1 ]] || continue
          chkd=$((chkd + 1)); [[ "$ex" == 0 ]] || continue
          case "$kd" in i) mi=$((mi + 1)) ;; n) mn=$((mn + 1)) ;; *) me=$((me + 1)) ;; esac
        done < <(pgq "$qids")
        unchk=$(( si + se + sn + ss - chkd )); (( unchk < 0 )) && unchk=0   # unmapped type, bad id, redis error or LIMIT 200 truncation
        if (( mi + me + mn > 0 )); then
          mc="$(st_get job_mismatch)"; [[ "$mc" =~ ^[0-9]+$ ]] || mc=0; mc=$((10#$mc + 1)); st_put job_mismatch "$mc"
          if (( mc >= 2 )); then add job_mismatch FAIL "stale rows without BullMQ job: import=$mi export=$me notif=$mn (run $mc in a row), unchecked=$unchk"
          else add job_mismatch WARN "stale rows without BullMQ job: import=$mi export=$me notif=$mn (1st run), unchecked=$unchk"; fi
        elif (( unchk > 0 )); then add job_mismatch WARN "$unchk stale rows could not be checked against BullMQ (unmapped job type / invalid id / >200 rows) - mismatch status unknown"
        else st_put job_mismatch 0; add job_mismatch OK "all stale rows have a BullMQ job"; fi
      else add job_mismatch SKIP "redis/queue checks not run"; fi
    fi
  else add jobs_stale FAIL "monitor DB query failed"; fi
else add jobs_stale SKIP "MONITOR_DB_NAME/MONITOR_DB_USER unset"; fi

# report + alert with dedup (state change or repeat every MONITOR_REPEAT_MINUTES)
fails=""; fpsrc=""; hascrit=0; for i in "${!NAMES[@]}"; do
  printf '%-16s %-4s %s\n' "${NAMES[$i]}" "${STATUS[$i]}" "${DETAIL[$i]}"
  if [[ "${STATUS[$i]}" == FAIL ]]; then fails+="CRIT ${NAMES[$i]}: ${DETAIL[$i]}"$'\n'; fpsrc+="CRIT|${NAMES[$i]}"$'\n'; hascrit=1
  elif [[ "${STATUS[$i]}" == WARN ]]; then fails+="WARN ${NAMES[$i]}: ${DETAIL[$i]}"$'\n'; fpsrc+="WARN|${NAMES[$i]}"$'\n'; fi
done
if [[ "$MODE" == dry ]]; then [[ -n "$fails" ]] && send "[$MONITOR_HOST_LABEL] ALERT"$'\n'"$fails"; exit 0; fi
STATE_ERR=0
state_fail() { echo "ERROR: $1" >&2; STATE_ERR=1; }
mkdir -p "$MONITOR_STATE_DIR" && chmod 700 "$MONITOR_STATE_DIR" || state_fail "state dir $MONITOR_STATE_DIR unusable (mkdir/chmod failed; see README first-start order) - alerts will not be deduplicated"
sf="$MONITOR_STATE_DIR/last"; prev=""; [[ -f "$sf" ]] && { prev="$(cat "$sf")" || state_fail "cannot read $sf"; }
now="$(date +%s)"; prev_ts="${prev%%|*}"; prev_fp="${prev#*|}"; [[ "$prev_ts" =~ ^[0-9]{1,12}$ ]] || prev_ts=0; fp="$(printf '%s' "$fpsrc" | cksum | cut -d' ' -f1)"
if [[ -n "$fails" ]]; then
  if [[ "$fp" != "$prev_fp" ]] || (( now - ${prev_ts:-0} >= MONITOR_REPEAT_MINUTES * 60 )); then
    # the alert stays sent even if the state write fails (then exit status is non-zero anyway)
    send "[$MONITOR_HOST_LABEL] ALERT"$'\n'"$fails" && { echo "$now|$fp" > "$sf" || state_fail "cannot write $sf (alert already sent, will repeat every run)"; }
  fi
  (( hascrit )) && exit 1
  exit "$STATE_ERR"
elif [[ -n "$prev_fp" && "$prev_fp" != "$(printf '' | cksum | cut -d' ' -f1)" ]]; then
  send "[$MONITOR_HOST_LABEL] RECOVERED: all checks OK" && { : > "$sf" || state_fail "cannot write $sf (recovery already sent)"; }
fi
exit "$STATE_ERR"
