#!/usr/bin/env bash
# Sourced helper (objects-backup.sh, restore-objects.sh, offsite-sync.sh): S3 remotes via rclone env config + credential separation.
# Credentials only travel in the environment of rclone (never argv, never written to disk).

# bk_check_endpoint <url>: https:// always; plain http:// only for a loopback host (local test backends, no network exposure).
bk_check_endpoint() {
  local u="$1"
  [[ "$u" == https://* ]] && return 0
  [[ "$u" =~ ^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/|$) ]] && return 0
  echo "endpoint must be https:// (http:// is allowed only for a loopback test backend)" >&2; return 1
}

# bk_remote <NAME> <endpoint> <access_key_id> <secret> [region] [provider]  -> remote "NAME:" usable with rclone
bk_remote() {
  local n="$1"
  bk_check_endpoint "$2" || return 1
  export "RCLONE_CONFIG_${n}_TYPE=s3" "RCLONE_CONFIG_${n}_PROVIDER=${6:-Other}" "RCLONE_CONFIG_${n}_ENDPOINT=$2" \
         "RCLONE_CONFIG_${n}_REGION=${5:-}" "RCLONE_CONFIG_${n}_ACCESS_KEY_ID=$3" "RCLONE_CONFIG_${n}_SECRET_ACCESS_KEY=$4" \
         "RCLONE_CONFIG_${n}_NO_CHECK_BUCKET=true" "RCLONE_CONFIG_${n}_ENV_AUTH=false"
}

# bk_app_s3_key: prints the app's S3_ACCESS_KEY from VELTO_APP_ENV_FILE (same parser as ecosystem.config.js). Empty if not found.
bk_app_s3_key() {
  local f="${VELTO_APP_ENV_FILE:-}" here v
  [[ -n "$f" && -r "$f" ]] || return 1
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if command -v node >/dev/null && [[ -f "$here/../env-file.js" ]]; then
    v="$(node "$here/../env-file.js" export "$f" S3_ACCESS_KEY 2>/dev/null | sed -E "s/^export S3_ACCESS_KEY='(.*)'$/\1/")"
  else
    v="$(grep -E '^[[:space:]]*S3_ACCESS_KEY=' "$f" | tail -n1 | sed -E 's/^[^=]*=//; s/^["'"'"']//; s/["'"'"']$//')"
  fi
  [[ -n "$v" ]] && printf '%s' "$v"
}

# bk_assert_key_separation <label> <key_id> [<label> <key_id> ...]: fails if any key id equals the app's S3 key or another listed key.
# Fail-closed: BACKUP_REQUIRE_KEY_SEPARATION=0 is the only way to skip the app comparison (documented as NOT for production).
bk_assert_key_separation() {
  local app="" i j
  if app="$(bk_app_s3_key)"; then :; elif [[ "${BACKUP_REQUIRE_KEY_SEPARATION:-1}" != 0 ]]; then
    echo "cannot verify credential separation: set VELTO_APP_ENV_FILE to the app env file (root-readable) so the app's S3_ACCESS_KEY can be compared" >&2; return 1
  fi
  local -a args=("$@")
  for ((i = 0; i < ${#args[@]}; i += 2)); do
    [[ -n "$app" && "${args[i+1]}" == "$app" ]] && { echo "${args[i]} uses the SAME access key as the app (S3_ACCESS_KEY): backup identities must be separate" >&2; return 1; }
    for ((j = i + 2; j < ${#args[@]}; j += 2)); do
      [[ "${args[i+1]}" == "${args[j+1]}" ]] && { echo "${args[i]} and ${args[j]} share one access key: identities must be separate" >&2; return 1; }
    done
  done
  return 0
}

# bk_ts_before <seconds> [now-epoch]: the velto-*-<TS> timestamp (local time, YYYYmmdd-HHMMSS, same format as the file names) of "now minus <seconds>". GNU and BSD date.
bk_ts_before() {
  local e=$(( ${2:-$(date +%s)} - $1 ))
  date -d "@$e" +%Y%m%d-%H%M%S 2>/dev/null || date -r "$e" +%Y%m%d-%H%M%S
}

# bk_prune_sets <dir> <keep_all_hours> <keep_days> [now-epoch]: TIERED local retention, whole sets only (replaces `find -mtime +30`):
#   * every file whose name timestamp is younger than <keep_all_hours> is kept (the 20-min cadence: ~3 sets/h are kept for 48 h);
#   * from there to <keep_days>: only the EARLIEST VERIFIED set (manifest) of each calendar day, with every file that manifest lists (+ .sig, .sha256 sidecars);
#   * the NEWEST verified set is always kept, whatever its age; older than <keep_days>, non-keepers and orphans (archives with no manifest) are deleted.
# A manifest counts as verified only if the callback named in BK_PRUNE_VERIFY (called: fn <manifest> <dir>; rc 0 = sizes/sha256/structure ok) accepts it; with no callback
# nothing is pruned (fail closed). Call it only AFTER the new set is complete and verified. Only regular files directly in <dir> named velto-{db,globals,objects,fp}-<TS>.* or
# velto-set-<TS>.manifest[.sig] are considered. Offsite copies are never touched.
bk_prune_sets() {
  local dir="$1" ah="$2" kd="$3" now="${4:-${BK_NOW:-$(date +%s)}}" t48 t30 f b ts day mf keep=$'\n' n newest="" seen_days=" "   # (no associative arrays: bash 3.2 runs the tests)
  [[ "$ah" =~ ^[0-9]+$ && "$kd" =~ ^[0-9]+$ ]] || { echo "bk_prune_sets: bad arguments" >&2; return 1; }
  [[ -n "${BK_PRUNE_VERIFY:-}" ]] && declare -F "$BK_PRUNE_VERIFY" >/dev/null || { echo "bk_prune_sets: no verifier (BK_PRUNE_VERIFY): nothing pruned" >&2; return 1; }
  t48="$(bk_ts_before $(( ah * 3600 )) "$now")"; t30="$(bk_ts_before $(( kd * 86400 )) "$now")"
  keepset() { # manifest basename + its sig + every listed file
    keep+="$1"$'\n'"$1.sig"$'\n'
    for n in $(grep -E '^[A-Z]+_ARCHIVE=' "$dir/$1" | cut -d= -f2-); do keep+="$n"$'\n'"$n.sha256"$'\n'; done
  }
  # 1. newest VERIFIED set is untouchable
  while IFS= read -r mf; do
    if "$BK_PRUNE_VERIFY" "$mf" "$dir"; then newest="$(basename "$mf")"; keepset "$newest"; break; fi
  done < <(find "$dir" -maxdepth 1 -type f -name 'velto-set-*.manifest' | sort -r)
  # 2. keeper manifests: all younger than <ah> (verified or not: a set being written is never touched); older but within <kd>: the earliest VERIFIED one of each day
  while IFS= read -r mf; do
    b="$(basename "$mf")"; ts="${b#velto-set-}"; ts="${ts%.manifest}"; day="${ts%%-*}"
    [[ "$ts" =~ ^[0-9]{8}-[0-9]{6}$ ]] || continue
    if [[ "$ts" > "$t48" || "$ts" == "$t48" ]]; then keepset "$b"; continue; fi
    [[ "$ts" < "$t30" ]] && continue
    [[ "$seen_days" == *" $day "* ]] && continue
    "$BK_PRUNE_VERIFY" "$mf" "$dir" || continue
    seen_days+="$day "; keepset "$b"
  done < <(find "$dir" -maxdepth 1 -type f -name 'velto-set-*.manifest' | sort)
  # 3. delete every older, unreferenced backup file
  while IFS= read -r f; do
    b="$(basename "$f")"
    ts="$(sed -E 's/^velto-(db|globals|objects|fp|set)-([0-9]{8}-[0-9]{6})\..*$/\2/' <<<"$b")"
    [[ "$ts" =~ ^[0-9]{8}-[0-9]{6}$ ]] || continue
    if [[ "$ts" > "$t48" || "$ts" == "$t48" ]]; then continue; fi
    [[ "$keep" == *$'\n'"$b"$'\n'* ]] && continue
    echo "[retention] delete $b"; rm -f "$f"
  done < <(find "$dir" -maxdepth 1 -type f \( -name 'velto-db-*' -o -name 'velto-globals-*' -o -name 'velto-objects-*' -o -name 'velto-fp-*' -o -name 'velto-set-*' \) | sort)
}
