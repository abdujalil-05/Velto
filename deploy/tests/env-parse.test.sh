#!/usr/bin/env bash
# Regression: ecosystem.config.js (PM2) and deploy.sh must parse .env files with ONE rule (deploy/env-file.js).
# Run: bash deploy/tests/env-parse.test.sh   (needs node; no root, no network)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
D="$HERE/.."
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok() { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }

# bash side value of KEY via the same helper deploy.sh uses
bash_val() { ( eval "$(node "$D/env-file.js" export "$1")" && printf '%s' "${!2-__UNSET__}" ); }
# PM2 side value of KEY via the real ecosystem.config.js (VELTO_ENV_FILE selects the file)
pm2_val() { VELTO_ENV_FILE="$1" node -e "const c=require('$D/ecosystem.config.js');const v=c.apps[0].env['$2'];process.stdout.write(v===undefined?'__UNSET__':v)"; }
same() { # file key expected label
  local b p; b="$(bash_val "$1" "$2")"; p="$(pm2_val "$1" "$2")"
  if [[ "$b" != "$3" ]]; then bad "$4: deploy.sh got '$b', want '$3'"; elif [[ "$p" != "$3" ]]; then bad "$4: PM2 got '$p', want '$3'"; else ok "$4 (deploy.sh == PM2)"; fi
}

cat > "$T/a.env" <<'E'
# comment
PLAIN=abc123
  SPACED  =  with spaces inside  
DQ="quoted # not a comment"
SQ='single $HOME `x`'
DOLLAR=pa$$word$HOME
URL=postgresql://u:p%40ss@127.0.0.1:5432/db?schema=public
EMPTY=
HASHVAL=abc#def
E
same "$T/a.env" PLAIN abc123 "plain value"
same "$T/a.env" SPACED "with spaces inside" "trimmed value"
same "$T/a.env" DQ "quoted # not a comment" "double-quoted # kept"
same "$T/a.env" SQ 'single $HOME `x`' "single-quoted literal"
same "$T/a.env" DOLLAR 'pa$$word$HOME' "no shell expansion"
same "$T/a.env" URL 'postgresql://u:p%40ss@127.0.0.1:5432/db?schema=public' "url value"
same "$T/a.env" EMPTY '' "empty value"
same "$T/a.env" HASHVAL 'abc#def' "# without leading space is data"

# THE REGRESSION: inline comment must be rejected by BOTH sides (previously PM2 kept it, bash dropped it).
printf 'KEY=value # trailing comment\nOTHER=1\n' > "$T/c.env"
if node "$D/env-file.js" export "$T/c.env" >/dev/null 2>"$T/err1"; then bad "bash: inline comment accepted"; else ok "bash: inline comment rejected"; fi
grep -q 'inline comment' "$T/err1" && ok "error names the problem" || bad "error text"
grep -q 'value' "$T/err1" && grep -q 'trailing comment' "$T/err1" && bad "error leaks the value" || ok "error does not leak the value"
if VELTO_ENV_FILE="$T/c.env" node -e "require('$D/ecosystem.config.js')" 2>/dev/null; then bad "PM2: inline comment accepted"; else ok "PM2: inline comment rejected"; fi
# quoted + comment is also ambiguous
printf 'KEY="v" # c\n' > "$T/d.env"
node "$D/env-file.js" export "$T/d.env" >/dev/null 2>&1 && bad "quoted+comment accepted" || ok "quoted value followed by comment rejected"
# shell syntax rejected
printf 'export KEY=v\n' > "$T/e.env"
node "$D/env-file.js" export "$T/e.env" >/dev/null 2>&1 && bad "export syntax accepted" || ok "export syntax rejected"
# CRLF
printf 'CR=win\r\n' > "$T/f.env"
[[ "$(bash_val "$T/f.env" CR)" == win ]] && ok "CRLF stripped" || bad "CRLF"
# key filter + injection safety
printf "EVIL='; touch %s/pwn; echo '\n" "$T" > "$T/g.env"
bash_val "$T/g.env" EVIL >/dev/null; [[ ! -e "$T/pwn" ]] && ok "values are never executed" || bad "command injection via value"
printf 'A=1\nB=2\n' > "$T/h.env"
[[ "$(bash_val "$T/h.env" B)" == 2 && "$(node "$D/env-file.js" export "$T/h.env" A | wc -l | tr -d ' ')" == 1 ]] && ok "key filter" || bad "key filter"
# the shipped example file must parse
node "$D/env-file.js" export "$D/env.production.example" >/dev/null 2>"$T/err2" && ok "env.production.example parses" || { bad "env.production.example: $(head -1 "$T/err2")"; }
printf '\n%d passed, %d failed\n' "$pass" "$fail"; [[ $fail -eq 0 ]]
