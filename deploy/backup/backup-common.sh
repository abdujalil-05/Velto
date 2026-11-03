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
