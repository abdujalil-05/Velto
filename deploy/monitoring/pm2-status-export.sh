#!/usr/bin/env bash
# Runs AS THE PM2 USER (cron/systemd timer, every minute). Writes a minimal snapshot for velto-monitor: no env, no args, no log paths, no PII.
#   install -d -m 755 -o <pm2user> /var/lib/velto-pm2 ; * * * * * /usr/local/bin/velto-pm2-status-export
# Output (default /var/lib/velto-pm2/status, 0644): ts=<epoch>, proc.<name>.status=<online|stopped|errored|...>, proc.<name>.restarts=<n>
set -uo pipefail
OUT="${PM2_STATUS_FILE:-/var/lib/velto-pm2/status}"
PM2_BIN="${PM2_BIN:-pm2}"
json="$("$PM2_BIN" jlist 2>/dev/null)" || { echo "pm2 jlist failed" >&2; exit 1; }
tmp="$OUT.tmp.$$"; trap 'rm -f "$tmp"' EXIT
{
  echo "ts=$(date +%s)"
  printf '%s' "$json" | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      const l=JSON.parse(d);
      for(const p of l){const n=String(p.name).replace(/[^A-Za-z0-9._-]/g,"").slice(0,40);
        if(!n)continue;console.log("proc."+n+".status="+String((p.pm2_env||{}).status||"unknown").replace(/[^a-z]/g,""));
        console.log("proc."+n+".restarts="+(Number((p.pm2_env||{}).restart_time)||0));}})'
} > "$tmp" || { echo "export failed" >&2; exit 1; }
chmod 644 "$tmp" && mv -f "$tmp" "$OUT"
