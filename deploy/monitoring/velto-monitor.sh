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
: "${MONITOR_JOB_STUCK_MINUTES:=30}" "${MONITOR_NOTIF_STUCK_MINUTES:=30}"
: "${MONITOR_JOB_FAILED_WINDOW_MINUTES:=60}" "${MONITOR_JOB_FAILED_MAX:=5}"
: "${MONITOR_STATE_DIR:=/var/lib/velto-monitor}" "${MONITOR_REPEAT_MINUTES:=360}"
: "${MONITOR_ALERT_COOLDOWN_SECONDS:=3600}" "${MONITOR_5XX_PATH_PREFIX:=/velto/api/}"
# Extended checks (all optional: unset target = SKIP, never a silent PASS of something unconfigured).
: "${MONITOR_TLS_CRIT_DAYS:=7}" "${MONITOR_DISK_CRIT_PERCENT:=90}" "${MONITOR_MEM_MIN_AVAIL_PERCENT:=10}" "${MONITOR_MEMINFO:=/proc/meminfo}"
: "${MONITOR_PUBLIC_URL:=}" "${MONITOR_S3_PUBLIC_URL:=}"
: "${MONITOR_BACKUP_STATUS_FILE:=}" "${MONITOR_BACKUP_MAX_AGE_MINUTES:=100}" "${MONITOR_OFFSITE_MAX_AGE_MINUTES:=180}"
: "${MONITOR_REDIS_HOST:=127.0.0.1}" "${MONITOR_REDIS_PORT:=6379}" "${MONITOR_REDIS_USER:=}" "${MONITOR_BULLMQ_PREFIX:=bull}"
: "${MONITOR_QUEUES:=idempotency-cleanup reconciliation-daily company-export 1c-export import-commit notification-telegram}"
: "${MONITOR_QUEUE_FAILED_MAX:=10}" "${MONITOR_QUEUE_WAIT_MAX:=100}"
: "${MONITOR_PM2_STATUS_FILE:=}" "${MONITOR_PM2_PROCESS:=velto-api}" "${MONITOR_PM2_RESTART_SPIKE:=3}" "${MONITOR_PM2_STATUS_MAX_AGE_SECONDS:=600}"
: "${MONITOR_ALERT_WEBHOOK_URL:=}" "${MONITOR_ALERT_EMAIL:=}" "${MONITOR_APP_ENV_FILE:=}"
# VELTO_API_HEALTH_URL: REQUIRED, no default (full URL of the API health route reaching the BACKEND, e.g. https://host/velto/api/health/ready).
# Every numeric knob is validated BEFORE it reaches SQL or (( )) (arithmetic expansion would evaluate e.g. a[$(id)]). An invalid value is
# replaced by its safe default AND reported loudly (stderr + a FAIL "config" check in run mode) - never a silent pass.
BADNUM=""
for kv in MONITOR_ALERT_COOLDOWN_SECONDS=3600 MONITOR_TLS_WARN_DAYS=14 MONITOR_5XX_WINDOW_LINES=2000 MONITOR_5XX_MIN_COUNT=5 \
  MONITOR_5XX_MIN_PERCENT=5 MONITOR_BACKUP_MAX_AGE_HOURS=26 MONITOR_DISK_WARN_PERCENT=80 MONITOR_JOB_STUCK_MINUTES=30 \
  MONITOR_NOTIF_STUCK_MINUTES=30 MONITOR_JOB_FAILED_WINDOW_MINUTES=60 MONITOR_JOB_FAILED_MAX=5 MONITOR_REPEAT_MINUTES=360 MONITOR_DB_PORT=5432 \
  MONITOR_TLS_CRIT_DAYS=7 MONITOR_DISK_CRIT_PERCENT=90 MONITOR_MEM_MIN_AVAIL_PERCENT=10 MONITOR_BACKUP_MAX_AGE_MINUTES=100 \
  MONITOR_OFFSITE_MAX_AGE_MINUTES=180 MONITOR_REDIS_PORT=6379 MONITOR_QUEUE_FAILED_MAX=10 MONITOR_QUEUE_WAIT_MAX=100 \
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
#    ts=<epoch UTC of last fully verified local backup>  result=ok  offsite_ts=<epoch of last confirmed offsite copy>  offsite_result=ok
#    Crit if missing/unreadable, result!=ok, ts older than MONITOR_BACKUP_MAX_AGE_MINUTES (100) or in the future. Offsite likewise vs MONITOR_OFFSITE_MAX_AGE_MINUTES.
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
if [[ -n "$MONITOR_BACKUP_STATUS_FILE" ]]; then
  if [[ -r "$MONITOR_BACKUP_STATUS_FILE" ]]; then
    age_check backup "$(sfield ts)" "$(sfield result)" "$MONITOR_BACKUP_MAX_AGE_MINUTES"
    age_check backup_offsite "$(sfield offsite_ts)" "$(sfield offsite_result)" "$MONITOR_OFFSITE_MAX_AGE_MINUTES"
  else add backup FAIL "status file missing/unreadable"; add backup_offsite FAIL "status file missing/unreadable"; fi
elif [[ -d "$BACKUP_DIR" ]]; then
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

# 5e. Redis + BullMQ: PING, then per queue failed (ZSET) and wait (LIST) counts. Read-only ACL user (README); password via REDISCLI_AUTH, never argv.
if [[ -n "${MONITOR_REDIS_PASSWORD:-}" || -n "$MONITOR_REDIS_USER" ]] && command -v redis-cli >/dev/null; then
  TMO=""; command -v timeout >/dev/null && TMO="timeout 5"
  rcli() { REDISCLI_AUTH="${MONITOR_REDIS_PASSWORD:-}" ${TMO:+$TMO} redis-cli -h "$MONITOR_REDIS_HOST" -p "$MONITOR_REDIS_PORT" ${MONITOR_REDIS_USER:+--user "$MONITOR_REDIS_USER"} --no-auth-warning "$@" 2>/dev/null; }
  if [[ "$(rcli PING)" == PONG ]]; then
    add redis OK PONG
    for qn in $MONITOR_QUEUES; do
      qn="$(sane_name "$qn")"; [[ -n "$qn" ]] || continue
      qf="$(rcli ZCARD "$MONITOR_BULLMQ_PREFIX:$qn:failed")"; qw="$(rcli LLEN "$MONITOR_BULLMQ_PREFIX:$qn:wait")"
      if [[ ! "$qf" =~ ^[0-9]+$ || ! "$qw" =~ ^[0-9]+$ ]]; then add "queue:$qn" FAIL "bad redis reply"
      elif (( qf >= MONITOR_QUEUE_FAILED_MAX || qw >= MONITOR_QUEUE_WAIT_MAX )); then add "queue:$qn" FAIL "failed=$qf wait=$qw"
      else add "queue:$qn" OK "failed=$qf wait=$qw"; fi
    done
  else add redis FAIL "no PONG / auth failed"; fi
else add redis SKIP "MONITOR_REDIS_PASSWORD/MONITOR_REDIS_USER unset"; fi

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
fails=""; hascrit=0; for i in "${!NAMES[@]}"; do
  printf '%-16s %-4s %s\n' "${NAMES[$i]}" "${STATUS[$i]}" "${DETAIL[$i]}"
  if [[ "${STATUS[$i]}" == FAIL ]]; then fails+="CRIT ${NAMES[$i]}: ${DETAIL[$i]}"$'\n'; hascrit=1
  elif [[ "${STATUS[$i]}" == WARN ]]; then fails+="WARN ${NAMES[$i]}: ${DETAIL[$i]}"$'\n'; fi
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
  (( hascrit )) && exit 1
  exit "$STATE_ERR"
elif [[ -n "$prev_fp" && "$prev_fp" != "$(printf '' | cksum | cut -d' ' -f1)" ]]; then
  send "[$MONITOR_HOST_LABEL] RECOVERED: all checks OK" && { : > "$sf" || state_fail "cannot write $sf (recovery already sent)"; }
fi
exit "$STATE_ERR"
