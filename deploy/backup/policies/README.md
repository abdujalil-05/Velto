# Backup S3 identities and offsite bucket (D-1 / D-4)

| Identity | Where its key lives | Policy file | Can | Cannot |
|---|---|---|---|---|
| app | `/etc/velto/app.env` (`S3_ACCESS_KEY`), runtime user `velto` | `app-bucket-rw.json` | get/put objects; `s3:ListBucket` only because `StorageService` calls `HeadBucketCommand` (storage.service.ts:3) | delete, change policy/lifecycle/versioning |
| backup-writer, source side (`OBJECTS_SRC_*`) | `/etc/velto/backup.env`, root only | `backup-reader-app-bucket.json` | read + list the app bucket | write/delete anything |
| backup-writer, offsite side (`OFFSITE_S3_*`) | `/etc/velto/backup.env`, root only | `offsite-backup-writer-put-only.json` | put new objects, list names (rclone needs it to skip existing files) | read content, delete, version-delete, change retention/policy |
| restore | NOT on the server; password manager / separate admin workstation | `offsite-restore-read.json` | read + list versions of the offsite bucket | write/delete |

Rules enforced by the scripts: `offsite-sync.sh` and `objects-backup.sh` fail if `OFFSITE_S3_ACCESS_KEY_ID` / `OBJECTS_SRC_ACCESS_KEY_ID` equal the app's `S3_ACCESS_KEY` (read from `VELTO_APP_ENV_FILE`) or each other.
The offsite bucket must be in a different account/provider than the app's storage. Admin credentials (create bucket, Object Lock, lifecycle) are used once from a workstation, never stored on the VPS.
Bucket names in the JSON (`velto-files`, `velto-offsite-backups`) are samples: replace them.

## Offsite bucket (storage-owner action, admin identity; AWS CLI shown, `mc`/provider console equivalents exist)
```
aws s3api create-bucket --bucket velto-offsite-backups --object-lock-enabled-for-bucket [--region ...]   # Object Lock can only be enabled at creation
aws s3api put-bucket-versioning --bucket velto-offsite-backups --versioning-configuration Status=Enabled
aws s3api put-object-lock-configuration --bucket velto-offsite-backups --object-lock-configuration \
  '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":30}}}'
```
- Retention 30 days (PO D-4). Recommended: COMPLIANCE mode (nobody, including the account owner, can shorten or delete before expiry; set `"Mode":"COMPLIANCE"` above). GOVERNANCE only if you accept that any identity holding `s3:BypassGovernanceRetention` can delete/shorten retention: no key used by the Velto host (backup-writer, app, monitor) may ever hold that permission, and a human admin holding it must stay off the server. Trade-off of COMPLIANCE: no error recovery before expiry (cost); do the restore drill first.
- Do NOT add a lifecycle rule that expires application objects. Backup copies: expiry of NONCURRENT/expired backup versions after the retention window is the storage owner's call (only `velto-{db,globals,objects}-*` backups live in this bucket).
- Provider without Object Lock: documented equivalent = a bucket in a separate account with versioning + a bucket policy that denies `DeleteObject*` to every identity except a break-glass admin, plus a second host that PULLS with the restore identity (read-only) into a third location. Say which one was chosen in the runbook; "same account, no immutability" is not equivalent.
- Check after setup (from a workstation, with the writer key): `aws s3api delete-object --bucket ... --key <existing> --version-id <v>` must be AccessDenied; `aws s3 cp s3://.../<file> -` must be AccessDenied.
