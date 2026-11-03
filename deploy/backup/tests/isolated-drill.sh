#!/usr/bin/env bash
# ISOLATED restore drill (R1/R2/R4), end to end, everything throwaway and local: postgres:16 (16.15) + MinIO (synthetic S3 with Object Lock) + a root runner container.
#   runner (root, pg16 clients, rclone, flock)  : backup-run.sh = snapshot dump + encrypted fingerprint + objects + SIGNED manifest + upload + READ-BACK
#   host                                        : downloads the offsite copy with the restore-read identity, runs restore-drill.sh with an INDEPENDENT keyring + pinned fingerprints
# then the negative matrix on copies of the downloaded set. Prints one line per check; exit 0 only if every check behaved as expected.
# Needs: docker, pnpm (prisma/tsx), psql/pg_restore, rclone, gpg on the host. Touches NO existing container, port 5433, velto_dev or any production system.
# Usage: bash deploy/backup/tests/isolated-drill.sh [workdir-for-the-drill-report]      (images: postgres:16, bitnamilegacy/minio:latest, velto-drill-runner:r1r4 built from the Dockerfile below)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"; BK="$ROOT/deploy/backup"
OUT_DIR="${1:-$(mktemp -d)}"; mkdir -p "$OUT_DIR"
P="velto-drill-$(date +%Y%m%d%H%M%S)"; T="$(mktemp -d /tmp/vd.XXXXXX)"; chmod 700 "$T"   # short path: gpg-agent socket limit
PGIMG="${PG_IMAGE:-postgres:16}"; MINIO="${MINIO_TEST_IMAGE:-bitnamilegacy/minio:latest}"; RIMG=velto-drill-runner:r1r4
rnd() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$1"; }
pass=0; fail=0
ok()  { pass=$((pass+1)); printf 'PASS %s\n' "$1"; }
bad() { fail=$((fail+1)); printf 'FAIL %s\n' "$1"; }
cleanup() {
  docker rm -f "$P-pg" "$P-minio" "$P-runner" >/dev/null 2>&1; docker network rm "$P-net" >/dev/null 2>&1
  for h in "$T"/sign*; do gpgconf --homedir "$h" --kill all >/dev/null 2>&1; done; rm -rf "${T:?}"
}
trap cleanup EXIT
command -v docker >/dev/null && docker image inspect "$PGIMG" "$MINIO" "$RIMG" >/dev/null 2>&1 || { echo "SKIP: docker images missing ($PGIMG, $MINIO, $RIMG)"; exit 0; }
# shellcheck source=sign-fixture.sh
. "$BK/tests/sign-fixture.sh"
# shellcheck source=../backup-status-lib.sh
. "$BK/backup-status-lib.sh"

SPW="$(rnd 20)"; BPW="$(rnd 20)"; ADMIN_U="adm$(rnd 6)"; ADMIN_P="$(rnd 24)"; PHRASE="$(rnd 40)"
PGPORT=$((46000 + RANDOM % 900)); S3PORT=$((47000 + RANDOM % 900))
docker network create "$P-net" >/dev/null
docker run -d --name "$P-pg" --network "$P-net" --network-alias pg -p "127.0.0.1:$PGPORT:5432" -e POSTGRES_PASSWORD="$SPW" "$PGIMG" -c fsync=off >/dev/null || exit 1
docker run -d --name "$P-minio" --network "$P-net" --network-alias minio -p "127.0.0.1:$S3PORT:9000" -e MINIO_ROOT_USER="$ADMIN_U" -e MINIO_ROOT_PASSWORD="$ADMIN_P" "$MINIO" >/dev/null || exit 1
docker run -d --name "$P-runner" --network "$P-net" "$RIMG" sleep infinity >/dev/null || exit 1
echo "PG: $(docker exec "$P-pg" postgres --version)   host 127.0.0.1:$PGPORT   MinIO 127.0.0.1:$S3PORT   prefix $P"
SU() { PGPASSWORD="$SPW" psql -X -q -h 127.0.0.1 -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 "$@"; }
mc() { docker exec "$P-minio" mc "$@"; }
for _ in $(seq 1 60); do SU -d postgres -c 'select 1' >/dev/null 2>&1 && break; sleep 1; done

# ---- 1. database: roles, migrations, synthetic 2-tenant data (the repo's own seed-load.ts), backup role
SU -d postgres -c 'create database velto_load'
SU -d velto_load -v velto_env=dev -f "$ROOT/packages/database/scripts/provision-roles.sql" >/dev/null && ok "provision-roles.sql (velto_env=dev)" || bad "provision-roles"
HP="127.0.0.1:$PGPORT"
( cd "$ROOT/packages/database" && DATABASE_URL="postgresql://velto_app:velto_app@$HP/velto_load?schema=public" DATABASE_MIGRATE_URL="postgresql://velto_owner:velto_owner@$HP/velto_load?schema=public" pnpm exec prisma migrate deploy 2>&1 | tail -n 2 )
SU -d velto_load -f "$ROOT/packages/database/scripts/provision-backup-role.sql" >/dev/null && SU -d velto_load -c "alter role velto_backup password '$BPW'" >/dev/null && ok "migrations + velto_backup role" || bad "backup role"
LOAD_PASSWORD="$(rnd 16)"; export LOAD_PASSWORD
for s in drilla drillb; do
  ( cd "$ROOT/packages/database" && NODE_ENV=development DATABASE_LOAD_URL="postgresql://velto_app:velto_app@$HP/velto_load?schema=public" DATABASE_LOAD_SYSTEM_URL="postgresql://velto_system:velto_system@$HP/velto_load?schema=public" \
    pnpm exec tsx src/seed-load.ts --slug=$s --agents=3 --skus=40 --outlets=30 --warehouses=1 --orders=150 --chunk=150 2>&1 | tail -n 1 )
done
NINV="$(SU -d velto_load -tA -c 'select count(*) from "Invoice"')"; [[ "${NINV:-0}" -gt 0 ]] && ok "seeded 2 tenants ($NINV invoices)" || bad "seed produced no invoices"
unset LOAD_PASSWORD

# ---- 2. MinIO: app bucket (objects), offsite bucket with Object Lock, 4 identities (app, source-reader, put-only writer, restore-read)
for _ in $(seq 1 40); do mc alias set l http://127.0.0.1:9000 "$ADMIN_U" "$ADMIN_P" >/dev/null 2>&1 && mc admin info l >/dev/null 2>&1 && break; sleep 1; done
for f in app-bucket-rw backup-reader-app-bucket offsite-backup-writer-put-only offsite-restore-read; do docker cp "$BK/policies/$f.json" "$P-minio:/tmp/$f.json"; mc admin policy create l "$f" "/tmp/$f.json" >/dev/null; done
mkuser() { K_ID="$1-$(rnd 6)"; K_SECRET="$(rnd 28)"; for _ in 1 2 3 4 5 6; do mc admin user add l "$K_ID" "$K_SECRET" >/dev/null 2>&1 && mc admin policy attach l "$2" --user "$K_ID" >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }
mkuser app app-bucket-rw; APP_ID="$K_ID"; APP_S="$K_SECRET"; mkuser srcreader backup-reader-app-bucket; SRC_ID="$K_ID"; SRC_S="$K_SECRET"
mkuser writer offsite-backup-writer-put-only; OFF_ID="$K_ID"; OFF_S="$K_SECRET"; mkuser restore offsite-restore-read; RD_ID="$K_ID"; RD_S="$K_SECRET"
mc mb l/velto-files >/dev/null; mc mb --with-lock l/velto-offsite-backups >/dev/null; mc retention set --default GOVERNANCE 30d l/velto-offsite-backups >/dev/null 2>&1
rc_env() { export "RCLONE_CONFIG_$1_TYPE=s3" "RCLONE_CONFIG_$1_PROVIDER=Minio" "RCLONE_CONFIG_$1_ENDPOINT=http://127.0.0.1:$S3PORT" "RCLONE_CONFIG_$1_ACCESS_KEY_ID=$2" "RCLONE_CONFIG_$1_SECRET_ACCESS_KEY=$3" "RCLONE_CONFIG_$1_NO_CHECK_BUCKET=true"; }
rc_env ADM "$ADMIN_U" "$ADMIN_P"; rc_env APP "$APP_ID" "$APP_S"; rc_env RDR "$RD_ID" "$RD_S"
C1="$(SU -d velto_load -tA -c 'select id from "Company" order by "createdAt" limit 1')"
mkdir -p "$T/seed"; for p in "products/$C1" "imports/customers/$C1" "exports/company/$C1"; do mkdir -p "$T/seed/$p"; for n in 1 2 3; do head -c $((200 + RANDOM % 3000)) /dev/urandom > "$T/seed/$p/o$n.bin"; done; done
rclone copy "$T/seed" APP:velto-files >/dev/null 2>&1 && ok "synthetic objects uploaded as the app identity" || bad "object seed"

# ---- 3. runner: ROOT-OWNED copy of deploy/, signing key (private key ONLY here), backup.env
docker exec "$P-runner" sh -c 'install -d -m 755 -o root -g root /opt/velto /opt/velto/deploy /etc/velto /var/backups/velto /var/lib/velto-backup && install -d -m 700 /var/lib/velto-backup-sign && chmod 750 /var/backups/velto'
docker cp "$BK/." "$P-runner:/opt/velto/deploy/backup" && docker cp "$ROOT/deploy/env-file.js" "$P-runner:/opt/velto/deploy/env-file.js"
docker exec "$P-runner" sh -c 'chown -R root:root /opt/velto && find /opt/velto -type d -exec chmod 755 {} + && chmod 755 /opt/velto/deploy/backup/*.sh /opt/velto/deploy/backup/tests/*.sh'
docker exec "$P-runner" sh -c 'socat TCP-LISTEN:9000,fork,reuseaddr TCP:minio:9000 >/dev/null 2>&1 &'
SGH="$T/sign1"; F1="$(mk_signkey "$SGH" drill)"; pub_export "$SGH" "$F1" "$T/verify-pub.gpg"   # the public key + fingerprint stay on the "restore workstation" (host)
gpg --homedir "$SGH" --batch --export-secret-keys "$F1" 2>/dev/null | docker exec -i "$P-runner" gpg --homedir /var/lib/velto-backup-sign --batch --quiet --import 2>/dev/null
docker cp "$T/verify-pub.gpg" "$P-runner:/etc/velto/backup-sign-public.gpg"
docker exec "$P-runner" sh -c "printf '%s' '$PHRASE' > /etc/velto/backup.pass; printf 'S3_ACCESS_KEY=%s\nS3_SECRET_KEY=x\n' '$APP_ID' > /etc/velto/app.env; chmod 600 /etc/velto/backup.pass /etc/velto/app.env"
{
  echo "DATABASE_BACKUP_URL=postgresql://velto_backup:$BPW@pg:5432/velto_load"
  echo "BACKUP_DIR=/var/backups/velto"; echo "BACKUP_STATUS_DIR=/var/lib/velto-backup"; echo "BACKUP_PASSPHRASE_FILE=/etc/velto/backup.pass"
  echo "VELTO_APP_ENV_FILE=/etc/velto/app.env"; echo "BACKUP_SIGN_GNUPGHOME=/var/lib/velto-backup-sign"; echo "BACKUP_SIGN_KEY_FPR=$F1"
  echo "BACKUP_VERIFY_KEYRING=/etc/velto/backup-sign-public.gpg"; echo "BACKUP_TRUSTED_SIGN_FPRS=$F1"
  echo "OBJECTS_BACKUP_ENABLED=1"; echo "OBJECTS_SRC_ENDPOINT=http://127.0.0.1:9000"; echo "OBJECTS_SRC_BUCKET=velto-files"; echo "OBJECTS_SRC_PROVIDER=Minio"
  echo "OBJECTS_SRC_ACCESS_KEY_ID=$SRC_ID"; echo "OBJECTS_SRC_SECRET_ACCESS_KEY=$SRC_S"
  echo "OFFSITE_ENABLED=1"; echo "OFFSITE_BUCKET=velto-offsite-backups"; echo "OFFSITE_S3_ENDPOINT=http://127.0.0.1:9000"; echo "OFFSITE_S3_PROVIDER=Minio"
  echo "OFFSITE_S3_ACCESS_KEY_ID=$OFF_ID"; echo "OFFSITE_S3_SECRET_ACCESS_KEY=$OFF_S"; echo "OFFSITE_VERIFY_S3_ACCESS_KEY_ID=$RD_ID"; echo "OFFSITE_VERIFY_S3_SECRET_ACCESS_KEY=$RD_S"
  echo "BACKUP_GLOBALS=1"; echo "VELTO_MONITOR_BIN=/nonexistent"
} > "$T/backup.env"
docker cp "$T/backup.env" "$P-runner:/etc/velto/backup.env"; docker exec "$P-runner" chmod 600 /etc/velto/backup.env
RUN() { docker exec "$P-runner" bash -c "set -a; . /etc/velto/backup.env; set +a; $*"; }

# ---- 4. the backup run (as systemd would: root, env file), 2 consecutive runs; the second proves incremental uniqueness and lock release
t0=$(date +%s); RUN "/opt/velto/deploy/backup/backup-run.sh" > "$T/run1.log" 2>&1; rc1=$?; t1=$(date +%s)
[[ $rc1 -eq 0 ]] && ok "backup-run.sh (snapshot dump + FP + objects + signed manifest + upload + read-back) rc=0 in $((t1-t0)) s" || { bad "backup-run rc=$rc1: $(tail -n 6 "$T/run1.log")"; cat "$T/run1.log" | tail -n 15; }
RUN "grep -E '^(OFFSITE|offsite_result|VERIFY|OBJECTS|RESULT)=' /var/lib/velto-backup/status | tr '\n' ' '" ; echo
RUN "ls /var/backups/velto | sed -E 's/[0-9]{8}-[0-9]{6}/<TS>/' | sort | tr '\n' ' '"; echo
RUN "find /var/backups/velto /var/lib/velto-backup -type f ! -name '*.gpg' ! -name '*.sha256' ! -name '*.manifest' ! -name '*.sig' ! -name status ! -name '.backup-run.lock'" | grep -q . && bad "unexpected non-ciphertext file in the backup/status dirs" || ok "no plaintext file in BACKUP_DIR / status dir (only .gpg, .sha256, .manifest, .sig, status)"
RUN "flock -n 9 9>/var/lib/velto-backup/.backup-run.lock && echo free" | grep -q free && ok "flock released after the run" || bad "lock still held"
# overlap: hold the lock in the runner, start a run -> it must exit 0 and do nothing
docker exec -d "$P-runner" bash -c 'exec 9>/var/lib/velto-backup/.backup-run.lock; flock -n 9 && sleep 25'; sleep 1
N0="$(RUN 'ls /var/backups/velto | wc -l')"; RUN "/opt/velto/deploy/backup/backup-run.sh" > "$T/overlap.log" 2>&1; rco=$?; N1="$(RUN 'ls /var/backups/velto | wc -l')"
[[ $rco -eq 75 && "$N0" == "$N1" ]] && grep -q 'still active' "$T/overlap.log" && ok "overlap (real flock): second run exits 75 (reported), creates nothing" || bad "overlap rc=$rco files $N0->$N1"
sleep 25

# ---- 5. offsite copy -> workstation (restore-read identity only), independent keyring + pinned fingerprints
DL="$T/dl"; mkdir -p "$DL"; rclone copy RDR:velto-offsite-backups "$DL" >/dev/null 2>&1
M="$(ls "$DL"/velto-set-*.manifest | tail -n 1)"; [[ -f "$M" && -f "$M.sig" ]] && ok "downloaded offsite set: $(basename "$M") + .sig + $(find "$DL" -name 'velto-*.gpg' | wc -l | tr -d ' ') archives" || bad "download"
export BACKUP_VERIFY_KEYRING="$T/verify-pub.gpg" BACKUP_TRUSTED_SIGN_FPRS="$F1" BACKUP_PASSPHRASE_FILE="$T/pass"
printf '%s' "$PHRASE" > "$T/pass"; chmod 600 "$T/pass"
drill() { # name dir expected-rc [env...]  -> runs restore-drill.sh on a set dir, prints verdict line
  local n="$1" d="$2" erc="$3" mf; shift 3; mf="$(ls "$d"/velto-set-*.manifest | tail -n 1)"
  env DRILL_MAX_RESTORE_POINT_AGE_MINUTES=120 "$@" DRILL_HOST=127.0.0.1 DRILL_PORT="$PGPORT" DRILL_ADMIN_USER=postgres DRILL_ADMIN_PASSWORD="$SPW" DRILL_REPORT_DIR="$OUT_DIR" DRILL_SET_MANIFEST="$mf" \
    SOURCE_URL="postgresql://velto_system:velto_system@127.0.0.1:$PGPORT/velto_load" bash "$BK/restore-drill.sh" > "$T/drill-$n.log" 2>&1; local rc=$?
  if [[ $rc -eq $erc ]]; then ok "drill[$n]: exit $rc as expected ($(grep -m1 -E 'verdict|Verdict' "$T/drill-$n.log" | sed -E 's/.*verdict: //' | cut -c1-70))"; else bad "drill[$n]: exit $rc (want $erc): $(grep -E 'FAIL|NOT_VERIFIED' "$T/drill-$n.log" | head -n 3 | tr '\n' ' ' | cut -c1-250)"; fi
}
drill positive "$DL" 0
grep -E 'financial fingerprint|restore set manifest' "$T/drill-positive.log" | cut -c1-260
cp "$T/drill-positive.log" "$OUT_DIR/drill-positive.log"

# freshness / replay: no bound -> FAIL; bound too small for this set -> FAIL; explicit RUN_ID of the signed set -> PASS (historical restore)
RIDS="$(grep -m1 '^RUN_ID=' "$M")"; RIDS="${RIDS#RUN_ID=}"
drill no-freshness-bound "$DL" 1 DRILL_MAX_RESTORE_POINT_AGE_MINUTES=
drill historical-by-run-id "$DL" 0 DRILL_MAX_RESTORE_POINT_AGE_MINUTES= DRILL_EXPECT_RUN_ID="$RIDS"
drill wrong-run-id "$DL" 1 DRILL_MAX_RESTORE_POINT_AGE_MINUTES= DRILL_EXPECT_RUN_ID=not-this-run
# ---- 6. negative matrix on copies of the downloaded set
cpset() { rm -rf "$T/n_$1"; mkdir -p "$T/n_$1"; cp "$DL"/* "$T/n_$1/"; N="$T/n_$1"; NM="$(ls "$N"/velto-set-*.manifest | tail -n 1)"; }
keep_lines() { KEEP=(); local l; while IFS= read -r l; do KEEP+=("$l"); done < <(grep -vE "$1" "$NM"); }   # (bash 3.2: no mapfile)
sign_with() { BACKUP_SIGN_GNUPGHOME="$SGH" BACKUP_SIGN_KEY_FPR="$F1" bsm_sign "$NM"; }
cpset renamed; cp "$NM" "$N/velto-set-20991231-235959.manifest"; cp "$NM.sig" "$N/velto-set-20991231-235959.manifest.sig"; rm -f "$NM" "$NM.sig"; drill renamed-manifest "$N" 1
cpset unsigned; rm -f "$NM.sig"; drill unsigned "$N" 1
cpset tmanifest; sed -i.bak 's/^RESTORE_POINT_TS=.*/RESTORE_POINT_TS=1700000000/' "$NM" && rm -f "$NM.bak"; drill tampered-manifest "$N" 1
cpset tarchive; DBF="$(ls "$N"/velto-db-*.dump.gpg)"; flipbyte "$DBF" 100; drill tampered-archive "$N" 1
cpset untrusted; SGH3="$T/sign3"; F3="$(mk_signkey "$SGH3" other)"; drill untrusted-key "$N" 1 BACKUP_TRUSTED_SIGN_FPRS="$F3"
cpset signedbyother; pub_export "$SGH3" "$F3" "$T/pub3.gpg"; cat "$T/verify-pub.gpg" "$T/pub3.gpg" > "$T/pub13.gpg"; BACKUP_SIGN_GNUPGHOME="$SGH3" BACKUP_SIGN_KEY_FPR="$F3" bsm_sign "$NM"
drill signed-by-unpinned-key "$N" 1 BACKUP_VERIFY_KEYRING="$T/pub13.gpg"
drill rotation-both-pinned "$N" 0 BACKUP_VERIFY_KEYRING="$T/pub13.gpg" BACKUP_TRUSTED_SIGN_FPRS="$F1 $F3"
cpset extra; head -c 30 /dev/urandom > "$N/$(basename "$(ls "$N"/velto-objects-*.tar.gpg)").extra"; drill extra-file "$N" 1
cpset missing; rm -f "$(ls "$N"/velto-globals-*.sql.gpg)"; drill missing-file "$N" 1
cpset nofp; keep_lines '^(FP_ARCHIVE|FP_SIZE|FP_SHA256|VELTO_SET_MANIFEST)='; rm -f "$NM" "$N"/velto-fp-*
bsm_write "$NM" "${KEEP[@]}"; sign_with; drill missing-fingerprint-NOT_VERIFIED "$N" 3
cpset fpmis; FPF="$(ls "$N"/velto-fp-*.txt.gpg)"
gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$T/pass" --decrypt "$FPF" | sed -E "s/^(Payment\\|[0-9]+\\|[^|]*\\|).*/\\1$(printf '0%.0s' {1..64})/" > "$T/fp.doctored"
gpg --batch --yes --pinentry-mode loopback --passphrase-file "$T/pass" --symmetric --cipher-algo AES256 -o "$FPF" "$T/fp.doctored"   # (an attacker-style edit with the passphrase: re-signed by the legitimate signer below)
keep_lines '^(FP_SIZE|FP_SHA256|VELTO_SET_MANIFEST)='; rm -f "$NM"; bsm_write "$NM" "${KEEP[@]}" "FP_SIZE=$(bs_size "$FPF")" "FP_SHA256=$(bs_sha256 "$FPF")"; sign_with
drill fingerprint-mismatch "$N" 1; grep -E 'financial fingerprint' "$T/drill-fingerprint-mismatch.log" | cut -c1-260
grep -qE 'Payment=MISMATCH' "$T/drill-fingerprint-mismatch.log" && ! grep -qE '[0-9a-f]{64}' "$T/drill-fingerprint-mismatch.log" && ok "mismatch report names the table (Payment=MISMATCH) and prints no hash" || bad "mismatch report"

# ---- 7. read-back against REAL MinIO: corrupt an offsite object in place (same size), rerun the offsite step -> must fail closed (exit 11)
OBJN="$(basename "$(ls "$DL"/velto-objects-*.tar.gpg)")"; SZ="$(wc -c < "$DL/$OBJN" | tr -d ' ')"
{ b="$(head -c1 "$DL/$OBJN")"; [[ "$b" == Z ]] && printf 'Y' || printf 'Z'; tail -c +2 "$DL/$OBJN"; } > "$T/evil"; rc_env ADMW "$ADMIN_U" "$ADMIN_P"; rclone copyto "$T/evil" "ADMW:velto-offsite-backups/$OBJN" >/dev/null 2>&1
RUN "BACKUP_RUN_ACTIVE= OFFSITE_MANIFEST=/var/backups/velto/$(basename "$M") /opt/velto/deploy/backup/offsite-sync.sh" > "$T/rb.log" 2>&1; rcr=$?
[[ $rcr -eq 11 ]] && grep -q "read-back sha256 MISMATCH offsite: $OBJN" "$T/rb.log" && ok "real MinIO: same-size content change offsite -> offsite-sync exit 11 (listing alone would have passed; size equal: $SZ)" || bad "read-back vs MinIO: rc=$rcr $(tail -n 3 "$T/rb.log")"
RUN "grep -E '^offsite_result=' /var/lib/velto-backup/status"
# ---- 8. leak scan: none of the secrets used may appear in any log, report or status
SECRETS=("$SPW" "$BPW" "$ADMIN_P" "$APP_S" "$SRC_S" "$OFF_S" "$RD_S" "$PHRASE")
RUN "cat /var/lib/velto-backup/status" > "$T/status.copy"; docker logs "$P-runner" > "$T/runner.log" 2>&1
hits=0; for f in "$T"/*.log "$T/status.copy" "$OUT_DIR"/*.md "$OUT_DIR"/*.log; do [[ -f "$f" ]] || continue; for s in "${SECRETS[@]}"; do grep -qF -- "$s" "$f" && hits=$((hits+1)); done; done
[[ $hits -eq 0 ]] && ok "leak scan: 0 hits of ${#SECRETS[@]} secrets in $(ls "$T"/*.log "$OUT_DIR"/*.md "$OUT_DIR"/*.log 2>/dev/null | wc -l | tr -d ' ') logs/reports + status" || bad "secret leaked in $hits place(s)"
printf '\n%d passed, %d failed (reports in %s)\n' "$pass" "$fail" "$OUT_DIR"; [[ $fail -eq 0 ]]
