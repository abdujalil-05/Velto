#!/usr/bin/env bash
# deploy.sh must stop BEFORE install/migrate/build/restart when the backup gate fails, never restore, and never need a passphrase.
# Sandbox: copy of deploy/ + stub pnpm/pm2/sudo that record calls. Runs without root/network.
set -uo pipefail
D="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "${T:?}"' EXIT
pass=0; fail=0
ok() { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }
mkdir -p "$T/repo/deploy" "$T/bin" "$T/state"
cp -R "$D/." "$T/repo/deploy/"; rm -rf "$T/repo/deploy/monitoring"
printf 'DATABASE_URL=postgresql://velto_app:x@127.0.0.1/db\nDATABASE_MIGRATE_URL=postgresql://velto_owner:x@127.0.0.1/db\n' > "$T/repo/.env.production.local"
for c in pnpm pm2 curl; do printf '#!/bin/sh\necho "$0 $*" >> "%s/state/calls"\nexit 0\n' "$T" > "$T/bin/$c"; chmod +x "$T/bin/$c"; done
printf '#!/bin/sh\necho "sudo $*" >> "%s/state/calls"\nexit 1\n' "$T" > "$T/bin/sudo"; chmod +x "$T/bin/sudo"   # sudoers rule absent / service failed
run() { : > "$T/state/calls"; ( cd "$T/repo" && env -u BACKUP_PASSPHRASE_FILE -u BACKUP_PASSPHRASE PATH="$T/bin:$PATH" VELTO_MIGRATE_ENV_FILE=/nonexistent \
  VELTO_BACKUP_STATUS_FILE="$T/state/status" VELTO_BACKUP_DIR="$T/state" "$@" bash deploy/deploy.sh ) >"$T/out" 2>&1; }
run env; rc=$?
[[ $rc -ne 0 ]] && ok "no status + no sudo rule: deploy exits non-zero" || bad "deploy continued"
grep -q "DEPLOY ABORTED" "$T/out" && ok "clear abort message" || bad "abort message"
grep -qE "^$T/bin/(pnpm|pm2)" "$T/state/calls" && bad "pnpm/pm2 ran after a failed gate: $(head -3 "$T/state/calls")" || ok "install/migrate/build/restart never started"
grep -q "systemctl start velto-backup.service" "$T/state/calls" && ok "only the single narrow systemctl rule is attempted" || bad "trigger not attempted"
grep -q "BACKUP_PASSPHRASE" "$T/out" && bad "deploy still asks for BACKUP_PASSPHRASE*" || ok "deploy.sh needs no BACKUP_PASSPHRASE_FILE"
run env VELTO_DEPLOY_TRIGGER_BACKUP=0; rc=$?
[[ $rc -ne 0 ]] && ! grep -q sudo "$T/state/calls" && grep -q "no backup" "$T/out" && ok "trigger disabled: only checks, reports 'no backup'" || bad "check-only mode (rc=$rc)"
# status forged by the deploy user itself (file owned by uid != 0) must not pass even if everything else is perfect
if [[ "$(id -u)" != 0 ]]; then
  mkdir -p "$T/state"; chmod 755 "$T/state"; head -c 100 /dev/urandom > "$T/state/velto-db-20261102-010101.dump.gpg"; chmod 640 "$T/state/velto-db-20261102-010101.dump.gpg"
  # shellcheck source=../backup/backup-status-lib.sh
  . "$D/backup/backup-status-lib.sh"
  f="$T/state/velto-db-20261102-010101.dump.gpg"
  bs_write "$T/state" ok VERIFY=ok OFFSITE=skipped OBJECTS=disabled DB_ARCHIVE=velto-db-20261102-010101.dump.gpg "DB_SIZE=$(bs_size "$f")" "DB_SHA256=$(bs_sha256 "$f")"
  run env VELTO_DEPLOY_TRIGGER_BACKUP=0 VELTO_REQUIRE_OBJECTS=0; rc=$?
  [[ $rc -ne 0 ]] && grep -q "not owned" "$T/out" && ok "perfect status owned by the deploy user itself is rejected (forgery)" || bad "self-made status accepted (rc=$rc)"
  grep -qE "^$T/bin/(pnpm|pm2)" "$T/state/calls" && bad "install ran" || ok "still nothing installed"
fi
# env file with an inline comment: the parse error must ABORT the deploy (the old `eval "$(...)" || die` never fired)
printf 'DATABASE_URL=postgresql://velto_app:x@127.0.0.1/db # app\nDATABASE_MIGRATE_URL=postgresql://velto_owner:x@127.0.0.1/db\n' > "$T/repo/.env.production.local"
run env VELTO_DEPLOY_TRIGGER_BACKUP=0; rc=$?
[[ $rc -ne 0 ]] && grep -q "DEPLOY ABORTED: cannot parse .env.production.local" "$T/out" && ok "legacy env with inline comment: deploy aborts with the parse error" || bad "inline comment did not abort (rc=$rc): $(head -c 300 "$T/out")"
grep -q "backup-gate" "$T/out" && bad "gate ran after a parse failure" || ok "nothing after the parse error ran (gate not reached)"
printf 'DATABASE_MIGRATE_URL=postgresql://velto_owner:x@127.0.0.1/db # c\n' > "$T/migrate.env"
run env VELTO_MIGRATE_ENV_FILE="$T/migrate.env"; rc=$?
[[ $rc -ne 0 ]] && grep -q "DEPLOY ABORTED: cannot read $T/migrate.env" "$T/out" && ok "split migrate.env with inline comment: deploy aborts" || bad "migrate.env inline comment did not abort (rc=$rc): $(head -c 300 "$T/out")"
grep -qE "^$T/bin/(pnpm|pm2)" "$T/state/calls" && bad "install ran after parse failure" || ok "no pnpm/pm2 after parse failure"
printf '\n%d passed, %d failed\n' "$pass" "$fail"; [[ $fail -eq 0 ]]
