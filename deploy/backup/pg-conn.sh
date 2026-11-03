#!/usr/bin/env bash
# Sourced helper (not executable on its own): keeps Postgres passwords OUT of argv (ps / /proc/<pid>/cmdline).
# Usage:  . pg-conn.sh; pgc_init; pgc_parse "$URL"  -> sets PGC_HOST PGC_PORT PGC_DB PGC_USER (decoded) and appends the
#         password to a 0600 PGPASSFILE inside a 0700 mktemp dir; call pgc_cleanup from the caller's EXIT trap.
#         pgc_conninfo prints "host=.. port=.. dbname=.. user=.." (no password) for tools that take a conninfo string.
# URL query (?schema= etc.) is dropped; only sslmode is honoured (exported as PGSSLMODE).

PGC_DIR=""
pgc_init() {
  [[ -n "$PGC_DIR" ]] && return 0
  PGC_DIR="$(umask 077; mktemp -d)" || return 1
  chmod 700 "$PGC_DIR"
  ( umask 077; : > "$PGC_DIR/pgpass" ); chmod 600 "$PGC_DIR/pgpass"
  export PGPASSFILE="$PGC_DIR/pgpass"
}
pgc_cleanup() { [[ -n "${PGC_DIR:-}" ]] && rm -rf "$PGC_DIR"; PGC_DIR=""; }

_pgc_urldecode() { # fails on malformed %-escapes; a raw backslash stays literal
  local s="$1"
  if [[ "$s" =~ %[^0-9A-Fa-f]|%[0-9A-Fa-f]?$ ]]; then return 1; fi
  s="${s//\\/\\\\}"; printf '%b' "${s//%/\\x}"
}
_pgc_esc() { local s="$1"; s="${s//\\/\\\\}"; printf '%s' "${s//:/\\:}"; }  # pgpass escaping: \ and :

pgc_parse() { # $1 = postgresql://user:pw@host:port/db[?query]
  local url="$1" rest query="" auth hostport ui host port="" db user pw="" pp
  [[ "$url" =~ ^postgres(ql)?:// ]] || { echo "pg-conn: not a postgres:// URL" >&2; return 1; }
  rest="${url#*://}"
  [[ "$rest" == *\?* ]] && query="${rest#*\?}"
  rest="${rest%%\?*}"
  [[ "$rest" == */* ]] || { echo "pg-conn: URL has no database" >&2; return 1; }
  auth="${rest%%/*}"; db="${rest#*/}"
  hostport="${auth##*@}"; user=""
  if [[ "$auth" == *@* ]]; then ui="${auth%@*}"; user="${ui%%:*}"; [[ "$ui" == *:* ]] && pw="${ui#*:}"; fi
  if [[ "$hostport" == \[* ]]; then host="${hostport%%]*}"; host="${host#\[}"; pp="${hostport##*]}"; [[ "$pp" == :* ]] && port="${pp#:}"
  else host="${hostport%%:*}"; [[ "$hostport" == *:* ]] && port="${hostport#*:}"; fi
  [[ -n "$port" ]] || port=5432
  [[ "$port" =~ ^[0-9]+$ ]] || { echo "pg-conn: bad port in URL" >&2; return 1; }
  user="$(_pgc_urldecode "$user")" && pw="$(_pgc_urldecode "$pw")" && db="$(_pgc_urldecode "$db")" && host="$(_pgc_urldecode "$host")" \
    || { echo "pg-conn: malformed %-escape in URL" >&2; return 1; }
  [[ -n "$host" && -n "$user" && -n "$db" ]] || { echo "pg-conn: URL needs host, user and database" >&2; return 1; }
  [[ "$host$user$db$pw" != *$'\n'* && "$host$user$db$pw" != *$'\r'* ]] || { echo "pg-conn: control chars in URL" >&2; return 1; }
  [[ "$query" =~ (^|&)sslmode=([a-z-]+)($|&) ]] && export PGSSLMODE="${BASH_REMATCH[2]}"
  pgc_add "$host" "$port" "$db" "$user" "$pw" || return 1
}
pgc_add() { # host port db user password -> sets PGC_* and appends a pgpass line
  pgc_init || return 1
  PGC_HOST="$1"; PGC_PORT="$2"; PGC_DB="$3"; PGC_USER="$4"
  printf '%s:%s:%s:%s:%s\n' "$(_pgc_esc "$1")" "$2" "$(_pgc_esc "$3")" "$(_pgc_esc "$4")" "$(_pgc_esc "$5")" >> "$PGC_DIR/pgpass"
}
pgc_conninfo() { # prints a password-less conninfo string for the last pgc_parse/pgc_add
  local v out=""
  for v in "host=$PGC_HOST" "port=$PGC_PORT" "dbname=$PGC_DB" "user=$PGC_USER"; do
    local k="${v%%=*}" val="${v#*=}"; val="${val//\\/\\\\}"; val="${val//\'/\\\'}"; out+="$k='$val' "
  done
  printf '%s' "${out% }"
}
