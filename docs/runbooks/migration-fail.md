# Production migration failed
- **Detection:** `deploy/deploy.sh` stops at "Applying migrations" (`prisma migrate deploy` non-zero); `_prisma_migrations` row with `finished_at IS NULL`.
- **Severity:** SEV1 if the app is down, SEV2 if the old version still serves.
- **Triage:** 1) The script is `set -e`: PM2 was NOT restarted, the old code still runs against the (possibly partly migrated) schema. 2) Read the Prisma error. 3) `prisma migrate status` (owner role) to see which migration failed. 4) Migrations must be backward compatible with the previous app version; if not, keep the API stopped.
- **Data safety:** deploy.sh made a backup first (`velto-backup-*.sql`, path printed); encrypted nightly backups come from `deploy/backup/backup.sh`. Do NOT edit applied migration files. Failed-and-rolled-back migration: fix forward with a NEW migration, or `prisma migrate resolve --rolled-back <name>` only after confirming the DDL really rolled back (check the schema). Partial DDL => restore the backup into a NEW database and verify (restore-drill.md) before swapping.
- **Owner:** Tech Lead + Ops owner.
- **Verification:** `prisma migrate status` = up to date; `/health/ready` 200; RLS check (`relforcerowsecurity` on all `companyId` tables) and tenant-isolation smoke pass (the restore drill script does both on a copy).
- **Comms:** Maintenance notice before retrying; if downtime > planned window, update customers with ETA. The "rollback in 5 minutes" claim is NOT made until a staging drill proves it.
