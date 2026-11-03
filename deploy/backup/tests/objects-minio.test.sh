#!/usr/bin/env bash
# End-to-end test of the object-store backup against a THROWAWAY MinIO container used purely as a synthetic S3 (not the binding provider choice).
# Needs: docker, rclone, gpg. No root, no real servers; the container, its volume and the temp dir are removed on exit.
# Image: MINIO_TEST_IMAGE (default bitnamilegacy/minio:latest; any image whose entrypoint serves S3 on :9000 and has `mc` in PATH works).
# Covers: 2 companies x 5 prefix groups (+1 object outside them: must FAIL the backup), backup -> encrypted archive + sha256 + manifest, offsite put-only identity
# (put OK / read denied / delete denied / Object Lock retention), key-separation refusal, restore into an EMPTY bucket, manifest + byte comparison,
# tamper detection, non-empty destination refusal.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMG="${MINIO_TEST_IMAGE:-bitnamilegacy/minio:latest}"
command -v docker >/dev/null && command -v rclone >/dev/null && command -v gpg >/dev/null || { echo "SKIP: docker/rclone/gpg missing"; exit 0; }
docker image inspect "$IMG" >/dev/null 2>&1 || { echo "SKIP: image $IMG not present locally (docker pull $IMG)"; exit 0; }

T="$(mktemp -d)"; NAME="velto-test-minio-$$"; PORT=$((20000 + RANDOM % 2000))
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; gpgconf --homedir "$T/signhome" --kill all >/dev/null 2>&1; rm -rf "${T:?}"; }
trap cleanup EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }
rnd() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$1"; }

ADMIN_U="adm$(rnd 8)"; ADMIN_P="$(rnd 24)"
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:9000" -e MINIO_ROOT_USER="$ADMIN_U" -e MINIO_ROOT_PASSWORD="$ADMIN_P" "$IMG" >/dev/null || { echo "cannot start $IMG"; exit 1; }
EP="http://127.0.0.1:$PORT"
for _ in $(seq 1 40); do [[ "$(curl -s -o /dev/null -w '%{http_code}' "$EP/minio/health/live")" == 200 ]] && break; sleep 0.5; done
mc() { docker exec "$NAME" mc "$@"; }
for _ in $(seq 1 30); do mc alias set l "http://127.0.0.1:9000" "$ADMIN_U" "$ADMIN_P" >/dev/null 2>&1 && mc admin info l >/dev/null 2>&1 && break; sleep 1; done
mc alias set l "http://127.0.0.1:9000" "$ADMIN_U" "$ADMIN_P" >/dev/null || { echo "mc alias failed"; exit 1; }
for f in app-bucket-rw backup-reader-app-bucket offsite-backup-writer-put-only offsite-restore-read; do docker cp "$HERE/policies/$f.json" "$NAME:/tmp/$f.json"; mc admin policy create l "$f" "/tmp/$f.json" >/dev/null; done
mkuser() { # user policy -> sets K_ID / K_SECRET
  K_ID="$1-$(rnd 6)"; K_SECRET="$(rnd 28)"
  for _ in 1 2 3 4 5 6; do mc admin user add l "$K_ID" "$K_SECRET" >/dev/null 2>&1 && mc admin policy attach l "$2" --user "$K_ID" >/dev/null 2>&1 && return 0; sleep 2; done
  echo "FATAL: cannot attach policy $2" >&2; exit 1
}
mkuser app app-bucket-rw;                   APP_ID="$K_ID"; APP_SECRET="$K_SECRET"
mkuser srcreader backup-reader-app-bucket;  SRC_ID="$K_ID"; SRC_SECRET="$K_SECRET"
mkuser writer offsite-backup-writer-put-only; OFF_ID="$K_ID"; OFF_SECRET="$K_SECRET"
mkuser restore offsite-restore-read;        RD_ID="$K_ID"; RD_SECRET="$K_SECRET"
mc mb l/velto-files >/dev/null; mc mb l/velto-restore-target >/dev/null
mc mb --with-lock l/velto-offsite-backups >/dev/null; mc retention set --default GOVERNANCE 30d l/velto-offsite-backups >/dev/null 2>&1

rc_env() { # NAME id secret  (exports an rclone remote for the host-side rclone)
  export "RCLONE_CONFIG_$1_TYPE=s3" "RCLONE_CONFIG_$1_PROVIDER=Minio" "RCLONE_CONFIG_$1_ENDPOINT=$EP" "RCLONE_CONFIG_$1_ACCESS_KEY_ID=$2" "RCLONE_CONFIG_$1_SECRET_ACCESS_KEY=$3" "RCLONE_CONFIG_$1_NO_CHECK_BUCKET=true"
}
rc_env ADM "$ADMIN_U" "$ADMIN_P"; rc_env APP "$APP_ID" "$APP_SECRET"; rc_env WRI "$OFF_ID" "$OFF_SECRET"; rc_env RDR "$RD_ID" "$RD_SECRET"

echo "== seed synthetic objects as the APP identity"
C1="11111111-1111-4111-8111-111111111111"; C2="22222222-2222-4222-8222-222222222222"
KEYS=()
for c in "$C1" "$C2"; do
  for p in "products/$c" "imports/customers/$c" "imports/products/$c" "opening/opening-customers/$c" "opening/opening-stock/$c" "exports/1c/$c" "exports/company/$c"; do
    for n in 1 2 3; do KEYS+=("$p/obj-$n.bin"); done
  done
done
KEYS+=("products/$C1/big.bin" "misc/outside-prefixes.txt")
for k in "${KEYS[@]}"; do
  mkdir -p "$T/seed/$(dirname "$k")"
  if [[ "$k" == */big.bin ]]; then head -c 6000000 /dev/urandom > "$T/seed/$k"; else head -c $((100 + RANDOM % 4000)) /dev/urandom > "$T/seed/$k"; fi
done
rclone copy "$T/seed" APP:velto-files >/dev/null 2>"$T/e" && ok "app identity uploaded ${#KEYS[@]} synthetic objects" || bad "seed upload: $(head -c 200 "$T/e")"
rclone deletefile "APP:velto-files/products/$C1/obj-1.bin" >/dev/null 2>&1 && bad "app identity can delete" || ok "app identity cannot delete objects"

echo "== object backup"
printf '%s' "$(rnd 40)" > "$T/pass"; chmod 600 "$T/pass"
printf 'S3_ACCESS_KEY=%s\nS3_SECRET_KEY=x\n' "$APP_ID" > "$T/app.env"
mkdir -p "$T/bk"; chmod 750 "$T/bk"
export BACKUP_DIR="$T/bk" BACKUP_PASSPHRASE_FILE="$T/pass" VELTO_APP_ENV_FILE="$T/app.env" \
  OBJECTS_SRC_ENDPOINT="$EP" OBJECTS_SRC_BUCKET=velto-files OBJECTS_SRC_ACCESS_KEY_ID="$SRC_ID" OBJECTS_SRC_SECRET_ACCESS_KEY="$SRC_SECRET" OBJECTS_SRC_PROVIDER=Minio
# fail-closed: an object outside the 5 prefix groups = NO restore point (no archive, non-zero exit)
out="$(bash "$HERE/objects-backup.sh" 2>"$T/oberr")"; rc=$?
[[ $rc -ne 0 ]] && grep -q "outside the 5 prefix groups" "$T/oberr" && ok "object outside the 5 prefixes FAILS the objects backup" || bad "outside-prefix object did not fail (rc=$rc)"
[[ -z "$(find "$T/bk" -name 'velto-objects-*')" ]] && ok "no archive left after the failed run" || bad "archive produced despite failure"
rclone deletefile "ADM:velto-files/misc/outside-prefixes.txt" >/dev/null 2>&1 && ok "foreign object removed (admin identity)" || bad "could not remove foreign object"
KEYS=("${KEYS[@]:0:$(( ${#KEYS[@]} - 1 ))}")
out="$(bash "$HERE/objects-backup.sh" 2>"$T/oberr")"; rc=$?
[[ $rc -eq 0 ]] && ok "objects-backup.sh exit 0" || bad "objects-backup.sh rc=$rc: $(tail -n 3 "$T/oberr")"
EXPECT=${#KEYS[@]}
grep -q "^OBJECTS_COUNT=$EXPECT\$" <<<"$out" && ok "manifest counts $EXPECT objects" || bad "count: $(grep OBJECTS_COUNT <<<"$out")"
ARCH="$(grep '^OBJECTS_FILE=' <<<"$out" | cut -d= -f2-)"; [[ -s "$ARCH" && -s "$ARCH.sha256" ]] && ok "encrypted archive + sha256 sidecar written" || bad "archive missing"
( cd "$BACKUP_DIR" && b="$(basename "$ARCH")" && [[ "$(cut -d' ' -f1 "$b.sha256")" == "$(shasum -a 256 "$b" | cut -d' ' -f1)" ]] ) && ok "sidecar sha256 matches" || bad "sidecar sha mismatch"
head -c 2000 "$ARCH" | grep -aq "velto-objects-manifest\|MANIFEST" && bad "archive is NOT encrypted" || ok "archive is ciphertext (no plaintext manifest header)"
[[ -z "$(find "$T/bk" -name '.objects-work.*')" ]] && ok "staging dir removed" || bad "staging dir left behind"
rclone lsf APP:velto-files -R >/dev/null 2>&1; [[ "$(rclone lsf ADM:velto-files -R --files-only | wc -l | tr -d ' ')" == "${#KEYS[@]}" ]] && ok "app bucket untouched (nothing deleted)" || bad "app bucket changed"

echo "== key separation (fail-closed)"
( OBJECTS_SRC_ACCESS_KEY_ID="$APP_ID" OBJECTS_SRC_SECRET_ACCESS_KEY="$APP_SECRET" bash "$HERE/objects-backup.sh" >/dev/null 2>"$T/e" ) && bad "backup ran with the APP key" || { grep -q "SAME access key as the app" "$T/e" && ok "objects-backup refuses the app's access key" || bad "wrong refusal: $(head -c 150 "$T/e")"; }
( unset VELTO_APP_ENV_FILE; bash "$HERE/objects-backup.sh" >/dev/null 2>"$T/e" ) && bad "ran without VELTO_APP_ENV_FILE" || ok "no app env file -> cannot prove separation -> refuses"
OFFENV=(BACKUP_DIR="$T/bk" OFFSITE_BUCKET=velto-offsite-backups OFFSITE_S3_ENDPOINT="$EP" OFFSITE_S3_PROVIDER=Minio)
( env "${OFFENV[@]}" OFFSITE_S3_ACCESS_KEY_ID="$APP_ID" OFFSITE_S3_SECRET_ACCESS_KEY="$APP_SECRET" bash "$HERE/offsite-sync.sh" >/dev/null 2>"$T/e" ) && bad "offsite-sync ran with the APP key" || { grep -q "SAME access key" "$T/e" && ok "offsite-sync refuses the app's access key" || bad "offsite refusal text"; }
( env "${OFFENV[@]}" OFFSITE_S3_ACCESS_KEY_ID="$SRC_ID" OFFSITE_S3_SECRET_ACCESS_KEY="$SRC_SECRET" OBJECTS_SRC_ACCESS_KEY_ID="$SRC_ID" bash "$HERE/offsite-sync.sh" >/dev/null 2>"$T/e" ) && bad "offsite key == source key accepted" || ok "offsite key equal to the object-read key refused"

echo "== offsite (backup-writer: put-only, Object Lock)"
echo "decoy-db" > "$T/bk/velto-db-20261102-000000.dump.gpg"; ( cd "$T/bk" && shasum -a 256 velto-db-20261102-000000.dump.gpg > velto-db-20261102-000000.dump.gpg.sha256 )
echo "PLAINTEXT-SHOULD-NOT-UPLOAD" > "$T/bk/plain.sql"
# the set manifest (what backup-run.sh writes): offsite-sync.sh uploads ONLY the set it lists, then verifies it by listing
# shellcheck source=../backup-status-lib.sh
. "$HERE/backup-status-lib.sh"
DBN=velto-db-20261102-000000.dump.gpg; OBN="$(basename "$ARCH")"; MAN="$T/bk/velto-set-20261102-000000.manifest"
# shellcheck source=sign-fixture.sh
. "$HERE/tests/sign-fixture.sh"
SGH="$T/signhome"; SFPR="$(mk_signkey "$SGH" minio)"; pub_export "$SGH" "$SFPR" "$T/sign-pub.gpg"
export BACKUP_SIGN_GNUPGHOME="$SGH" BACKUP_SIGN_KEY_FPR="$SFPR" BACKUP_VERIFY_KEYRING="$T/sign-pub.gpg" BACKUP_TRUSTED_SIGN_FPRS="$SFPR"
bsm_write "$MAN" RUN_ID=minio-test RESTORE_POINT_TS=1790000000 OBJECTS_SNAPSHOT_TS=1790000005 OBJECTS=ok BACKUP_GLOBALS=0 OFFSITE_VERIFY=readback-sha256 \
  "DB_ARCHIVE=$DBN" "DB_SIZE=$(bs_size "$T/bk/$DBN")" "DB_SHA256=$(bs_sha256 "$T/bk/$DBN")" "OBJ_ARCHIVE=$OBN" "OBJ_SIZE=$(bs_size "$ARCH")" "OBJ_SHA256=$(bs_sha256 "$ARCH")" \
  && bsm_sign "$MAN" && ok "set manifest written + signed" || bad "set manifest"
OFFENV+=(OFFSITE_MANIFEST="$MAN" OFFSITE_VERIFY_S3_ACCESS_KEY_ID="$RD_ID" OFFSITE_VERIFY_S3_SECRET_ACCESS_KEY="$RD_SECRET")
env "${OFFENV[@]}" OFFSITE_S3_ACCESS_KEY_ID="$OFF_ID" OFFSITE_S3_SECRET_ACCESS_KEY="$OFF_SECRET" bash "$HERE/offsite-sync.sh" >"$T/o" 2>&1 && grep -q '^OFFSITE_VERIFIED_RESTORE_POINT_TS=1790000000$' "$T/o" && ok "offsite-sync.sh with writer key: uploaded + verified by listing AND sha256 read-back through the restore-read identity (marker printed)" || bad "offsite-sync failed: $(tail -n 3 "$T/o" | tr -d '\r')"
[[ "$(rclone lsf ADM:velto-offsite-backups -R --files-only | grep -c 'velto-objects-.*\.tar\.gpg$')" == 1 ]] && ok "objects archive reached offsite" || bad "objects archive not offsite"
rclone lsf ADM:velto-offsite-backups -R --files-only | grep -q 'plain.sql' && bad "plaintext uploaded" || ok "non-backup file (plain.sql) not uploaded"
OBJNAME="$(basename "$ARCH")"
rclone cat "WRI:velto-offsite-backups/$OBJNAME" >/dev/null 2>&1 && bad "writer can READ offsite objects" || ok "writer cannot read offsite objects"
rclone deletefile "WRI:velto-offsite-backups/$OBJNAME" >/dev/null 2>&1 && bad "writer can DELETE" || ok "writer cannot delete"
( mkdir -p "$T/put2" && cp "$T/bk/$OBJNAME" "$T/put2/velto-objects-20990101-000000.tar.gpg" && rclone copy "$T/put2" WRI:velto-offsite-backups --ignore-existing --s3-no-head >/dev/null 2>&1 ) && ok "writer can put a new object" || bad "writer cannot put"
mc retention info l/velto-offsite-backups 2>&1 | grep -qiE "GOVERNANCE|30" && ok "bucket default retention GOVERNANCE 30d (Object Lock)" || bad "no default retention"
mkdir -p "$T/dl"; rclone copy RDR:velto-offsite-backups "$T/dl" --filter "+ $OBJNAME" --filter '- *' >/dev/null 2>"$T/e"; [[ -f "$T/dl/$OBJNAME" && "$(shasum -a 256 < "$T/dl/$OBJNAME")" == "$(shasum -a 256 < "$ARCH")" ]] && ok "restore identity downloads the offsite archive intact (sha256 equal)" || bad "restore identity cannot download: $(head -c 150 "$T/e")"
rclone deletefile "RDR:velto-offsite-backups/$OBJNAME" >/dev/null 2>&1 && bad "restore identity can delete" || ok "restore identity cannot delete"

env "${OFFENV[@]}" OFFSITE_S3_ACCESS_KEY_ID="$OFF_ID" OFFSITE_S3_SECRET_ACCESS_KEY="$OFF_SECRET" bash "$HERE/offsite-sync.sh" >"$T/o2" 2>&1 && ok "offsite-sync.sh re-run is idempotent (existing files skipped, exit 0)" || bad "offsite re-run failed: $(tail -n 2 "$T/o2")"
( env "${OFFENV[@]}" OFFSITE_BUCKET=velto-offsite-backups/prod OFFSITE_S3_ACCESS_KEY_ID="$OFF_ID" OFFSITE_S3_SECRET_ACCESS_KEY="$OFF_SECRET" bash "$HERE/offsite-sync.sh" >/dev/null 2>&1 ) && bad "bucket prefix accepted" || ok "bucket with prefix refused (documented limitation)"

( env "${OFFENV[@]}" OFFSITE_VERIFY_S3_ACCESS_KEY_ID="$OFF_ID" OFFSITE_VERIFY_S3_SECRET_ACCESS_KEY="$OFF_SECRET" OFFSITE_S3_ACCESS_KEY_ID="$OFF_ID" OFFSITE_S3_SECRET_ACCESS_KEY="$OFF_SECRET" bash "$HERE/offsite-sync.sh" >/dev/null 2>"$T/e" ) && bad "read-back identity == writer key accepted" || ok "read-back identity equal to the writer key refused"
( env "${OFFENV[@]}" OFFSITE_VERIFY_S3_ACCESS_KEY_ID= OFFSITE_S3_ACCESS_KEY_ID="$OFF_ID" OFFSITE_S3_SECRET_ACCESS_KEY="$OFF_SECRET" bash "$HERE/offsite-sync.sh" >/dev/null 2>"$T/e" ); rcv=$?
[[ $rcv -eq 11 ]] && grep -q "read-back verification unavailable" "$T/e" && ok "no read-back identity -> exit 11 (fail closed, nothing uploaded)" || bad "missing read identity: rc=$rcv $(head -c 150 "$T/e")"

echo "== restore into an empty bucket + comparison"
export RESTORE_S3_ENDPOINT="$EP" RESTORE_S3_BUCKET=velto-restore-target RESTORE_S3_ACCESS_KEY_ID="$ADMIN_U" RESTORE_S3_SECRET_ACCESS_KEY="$ADMIN_P" RESTORE_S3_PROVIDER=Minio
bash "$HERE/restore-objects.sh" "$ARCH" --to-bucket >"$T/r" 2>&1 && ok "restore-objects.sh into empty bucket" || bad "restore failed: $(tail -n 3 "$T/r")"
manifest_of() { # remote-path -> sorted "sha256 size key" computed from the bucket bytes
  local d; d="$(mktemp -d "$T/m.XXXX")"; rclone copy "$1" "$d" >/dev/null 2>&1
  ( cd "$d" && find . -type f | sed 's#^\./##' | LC_ALL=C sort | while IFS= read -r k; do printf '%s\t%s\t%s\n' "$(shasum -a 256 "$k" | cut -d' ' -f1)" "$(wc -c < "$k" | tr -d ' ')" "$k"; done )
}
manifest_of ADM:velto-restore-target > "$T/m-restored"
manifest_of ADM:velto-files | grep -Ev $'\tmisc/' > "$T/m-source"
cmp -s "$T/m-restored" "$T/m-source" && ok "restored bucket == source bucket (sha256/size/key for all $EXPECT objects)" || bad "restored != source: $(diff "$T/m-source" "$T/m-restored" | head -n 3)"
gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$T/pass" --decrypt "$ARCH" | tar -xOf - MANIFEST.tsv | grep -v '^#' | LC_ALL=C sort -t$'\t' -k3,3 > "$T/m-embedded"
cmp -s "$T/m-embedded" "$T/m-restored" && ok "embedded manifest == restored bucket" || bad "embedded manifest differs"
bash "$HERE/restore-objects.sh" "$ARCH" --to-bucket >"$T/r2" 2>&1 && bad "restore into a NON-empty bucket accepted" || ok "non-empty destination refused"
mc mb l/velto-restore-prefix >/dev/null
RESTORE_S3_BUCKET=velto-restore-prefix bash "$HERE/restore-objects.sh" "$ARCH" --to-bucket --prefix products/ >"$T/r3" 2>&1 && [[ "$(rclone lsf ADM:velto-restore-prefix -R --files-only | grep -vc '^products/')" == 0 && "$(rclone lsf ADM:velto-restore-prefix -R --files-only | wc -l | tr -d ' ')" -gt 0 ]] && ok "selective restore (--prefix products/) restores only that class" || bad "selective restore: $(tail -n 2 "$T/r3")"
cp "$ARCH" "$T/tampered.tar.gpg"; printf 'X' | dd of="$T/tampered.tar.gpg" bs=1 seek=300 conv=notrunc 2>/dev/null
RESTORE_S3_BUCKET=velto-restore-prefix bash "$HERE/restore-objects.sh" "$T/tampered.tar.gpg" --to-dir "$T/tdir" >/dev/null 2>&1 && bad "tampered archive restored" || ok "tampered archive rejected"
printf 'deadbeef  x\n' > "$ARCH.sha256.bad"; cp "$ARCH" "$T/side.tar.gpg"; echo "0000  side.tar.gpg" > "$T/side.tar.gpg.sha256"
bash "$HERE/restore-objects.sh" "$T/side.tar.gpg" --to-dir "$T/sdir" >/dev/null 2>&1 && bad "sha256 sidecar mismatch ignored" || ok "sha256 sidecar mismatch rejected"
rm -f "$ARCH.sha256.bad"

printf '\n%d passed, %d failed\n' "$pass" "$fail"; [[ $fail -eq 0 ]]
