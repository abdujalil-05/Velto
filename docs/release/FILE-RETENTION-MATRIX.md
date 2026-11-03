# File & data retention matrix (pilot v0.9)

Status 2026-11-02. Policy approved by PO for pilot v0.9:
- Unbound temporary files: 7 days after confirmed unused; reference check against active ImportJob/ExportJob/documents; dry-run first; audited deletion; never delete files of active/recoverable jobs.
- Financial/accounting files: automatic deletion FORBIDDEN until legal/accounting sign-off. No legal period is invented here.
- Logs/PII/backups: separate policy from data inventory; documentation only.

## Findings
- `StorageService` (apps/api/src/common/storage/storage.service.ts:3,51-86) has only Head/Put/Get. No DeleteObject anywhere in apps/api. No S3 lifecycle rule in deploy/ (deploy/minio-policy.json is access policy only).
- Only cleanup jobs: idempotency-record purge (apps/api/src/common/idempotency/idempotency-cleanup.processor.ts:14, hourly, module:18) and the export-1c/import recovery sweeps (export-1c-recovery.service.ts:47) which change job status only, never delete files or rows.
- No unbound-temp-file cleanup exists. Per instruction it is not built; this is a PENDING item.
- No existing job deletes financial files, so no code change was required.

## Matrix
| Category | Storage | Current behavior (file:line) | Policy | Decision owner |
|---|---|---|---|---|
| Product images | S3 bucket; Product.imageUrl (schema.prisma:435) | Uploaded products.controller.ts:72; never deleted; replaced images stay orphaned | Unbound temp rule (7d, ref check, dry-run, audit) approved; cleanup NOT implemented | PO / integrations-dev |
| 1C exports | S3 key export1cStorageKey; ExportJob.storageKey (schema.prisma:1375) | Written export-1c.processor.ts:103 (deterministic key, overwrite guarded); never deleted | Auto-deletion FORBIDDEN; period PENDING legal/accounting — not set | Legal + accounting |
| Import sources (customers/products) | S3; ImportJob file url | import.service.ts:39 upload; never deleted | Auto-deletion FORBIDDEN (import sources); period PENDING legal/accounting — not set | Legal + accounting |
| Opening-balance sources | S3 | opening-balances.service.ts:124 upload; never deleted | Auto-deletion FORBIDDEN; PENDING legal/accounting — not set | Legal + accounting |
| Company export (ADR-045) archives | S3 companyExportStorageKey | company-export.processor.ts:70-71; never deleted | Treated as financial: auto-deletion FORBIDDEN; PENDING legal/accounting — not set | Legal + PO |
| Report exports | Async export jobs / S3 | No expiry or delete job | Unbound temp rule once confirmed unbound; PENDING implementation | PO |
| Checksums / ACK evidence | ExportJob fileHash/ack fields (DB) | Stored with job rows; no deletion | Auto-deletion FORBIDDEN; PENDING legal/accounting — not set | Legal + accounting |
| AuditLog | Postgres | Append-only DB trigger; even velto_system cannot UPDATE/DELETE | Keep; period PENDING legal/accounting — not set | Legal + PO |
| App logs | stdout via TraceLogger (main.ts:12) | No JSON format/redaction config (PILOT-INFRA-AUDIT:30) | Separate policy from data inventory; PENDING | PO + devops |
| PM2 logs | server pm2-logrotate | Documented deploy/README.md:80; rotation params not in repo | Separate policy; PENDING (params unverified) | devops |
| Backups | /var/backups/velto, GPG; offsite | backup.sh:18,65-66 deletes local dumps older than BACKUP_RETENTION_DAYS (default 14). Contains financial data. Offsite: README.md:87 write-only, lifecycle by admin | Operational rotation of encrypted DB dumps exists; legal period PENDING legal/accounting — not set; offsite lifecycle not defined | Legal + devops |
| Telegram/notification rows | Postgres Notification | notifications.service.ts:106-137 read/unread only; no deletion | No deletion; PII inventory PENDING | PO |
| Idempotency records | Postgres IdempotencyRecord | Hourly purge of expiresAt < now (idempotency-cleanup.processor.ts:14); not a file/financial document | Technical, keep | engineering |
| Refresh tokens / MFA codes | Postgres | expiresAt fields (schema.prisma:226,294); no purge job | PII/security inventory PENDING | PO + security |
| SyncTombstone | Postgres | schema.prisma:1599 "no cleanup job yet" | Keep >= longest offline window; PENDING | engineering |
| Offline device data | Dexie IndexedDB, AES-GCM | apps/miniapp/src/lib/offline/ (50MB cap, storage-budget.ts) | Device-side; held payments reconciled by server; no server policy | PO |

## Open
1. Legal/accounting periods for 1C exports, import sources, ACK/checksums, backups, AuditLog.
2. Unbound-temp cleanup (7d, reference check, dry-run, audit) is not built; requires an object-reference registry (schema change -> db-rls) because files are not tracked as unbound/bound.
3. Backup local 14-day deletion conflicts with "no auto-deletion until sign-off" only if backups count as accounting evidence; PO to decide.

## Дополнение 2026-11-02 (Backups / S3-префиксы; факты, сроки НЕ установлены)
- Один bucket (`S3_BUCKET`, `storage.service.ts:37`), префиксы: `products/{companyId}/`, `imports/{customers|products}/{companyId}/`, `opening/{opening-customers|opening-stock}/{companyId}/`, `exports/1c/{companyId}/`, `exports/company/{companyId}/`. Права/lifecycle задаются на префиксах; автоудаление финансовых префиксов (`exports/`, `opening/`, `imports/`) запрещено до заключения юриста/бухгалтера.
- Backups: локально 14 дн. (`backup.sh:18,83`, только локальная копия); offsite — Object Lock >= 30 дн. и lifecycle 60-90 дн. являются ТРЕБОВАНИЕМ К ПРОВАЙДЕРУ и вариантом для PO, не установленным сроком (BACKUP-RESTORE-RUNBOOK B.5, B.9). Бэкап самих S3-объектов отсутствует (B.6).
- Redis: не хранилище данных; очереди восстанавливаются из PG (BACKUP-RESTORE-RUNBOOK, раздел A). Срок хранения не применим.
- Сводка по категориям ПДн и вендорам: PILOT-DATA-INVENTORY.md.
