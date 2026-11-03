# Backup / Restore runbook (pilot)

Status 2026-11-02: scripts and drills verified LOCALLY only. Nothing here is activated on a server. Targets: RPO <= 24 h (pilot, daily backup), RTO <= 4 h (TZ 12.2).

## Components (deploy/backup/)
- `backup.sh` - pg_dump -Fc as the read-only `velto_backup` role (BYPASSRLS; NOT velto_system) -> gpg AES256 -> streaming verify -> `.sha256`; globals via `pg_dumpall --globals-only --no-role-passwords`; pg_dump/server major must match; retention `BACKUP_RETENTION_DAYS` (default 30).
- `objects-backup.sh` / `restore-objects.sh` - S3 object archive (D-1), see Part 3. `backup-status-lib.sh`, `verify-backup-status.sh` - status attestation + deploy gate (D-3), see Part 3.
- `offsite-sync.sh` - `rclone copy --ignore-existing` of `velto-{db,globals,objects}-*.gpg`/`.sha256` to a bare offsite bucket with the put-only backup-writer key (fails if it equals the app key). Never deletes/overwrites, never uploads the passphrase.
- `backup-run.sh` - scheduled entrypoint: backup -> offsite (if `OFFSITE_ENABLED=1`) -> alert on any failure.
- `restore-drill.sh` - restore into a separate `velto_restore_drill*` DB + checks. `backup.env.example`, `velto-backup.{service,timer}.example` - config samples (not installed).

## Schedule (user action on the server; not activated by the repo)
1. `/etc/velto/backup.env` (root, 600) from `backup.env.example`; passphrase in `/etc/velto/backup.pass` (600), plus an offline copy in the PO password manager. Without the passphrase the backups are unreadable.
2. systemd: first install the scripts to the root-owned `/opt/velto/deploy/{backup,monitoring}/` (commands in the header of `velto-backup.service.example`, incl. `pg-conn.sh`; re-run after each git pull), then copy the two `.example` units to `/etc/systemd/system/` (sandboxed; runs as root by design, reasons in the unit header), `systemctl daemon-reload && systemctl enable --now velto-backup.timer`. Or cron: `15 2 * * * set -a; . /etc/velto/backup.env; set +a; /root/projects/parviz_aka/Velto/deploy/backup/backup-run.sh >>/var/log/velto-backup.log 2>&1`.
3. First run manually, then check `systemctl list-timers`, the log, and that `.gpg` + `.sha256` exist.

## Offsite and who may delete (storage owner action)
- A different provider/account than the VPS and the app's S3/MinIO. App S3 keys (`S3_*`) must NOT be reused.
- The server key (`OFFSITE_S3_*`) is put-only: allow `s3:PutObject` on the prefix; deny `s3:DeleteObject*`, `s3:PutBucketPolicy`, `s3:PutLifecycle*`, `s3:PutObjectRetention`, and ideally `s3:GetObject`/`ListBucket` (then `NO_CHECK_BUCKET` is already set; `--immutable` needs list/head, so if List is denied expect rclone to re-upload and fail on existing objects - use unique timestamped names, which backup.sh does).
- Enable at the bucket: versioning + Object Lock (compliance/governance, retention >= 30 days) and lifecycle expiry (e.g. 60-90 days) set by the storage owner with a separate admin identity. Restore/list uses a third read-only identity kept off the server.
- Local `BACKUP_RETENTION_DAYS` only prunes the local dir; it never touches offsite.

## Alerts
`backup-run.sh` calls, in order: `$BACKUP_ALERT_CMD` (absolute path of a root-owned executable, not group/world-writable; no args/shell; called as `cmd <severity> <incident-id> <msg>`; msg = host/step/exit/timestamp only, never command output), else `velto-monitor --alert backup-<step> "<msg>" --severity crit` (deduped per incident, cooldown `MONITOR_ALERT_COOLDOWN_SECONDS`=3600; `--resolve` sends recovery after a successful run) (called as the `velto-monitor` user via `runuser` when run as root, so state files are never root-owned; `$VELTO_MONITOR_BIN`, `velto-monitor` in PATH, or `deploy/monitoring/velto-monitor.sh`; the one Telegram path, token in `/etc/velto/monitor.env`), else `logger -p user.err -t velto-backup` (also used if Telegram is NOT DELIVERED; message contains `VELTO-BACKUP-FAILED`). Non-zero exit also feeds cron MAILTO / systemd `OnFailure=`. Missed run (timer not firing): covered by the `backup` check of `velto-monitor` (newest verified `velto-db-*.dump.gpg` older than `MONITOR_BACKUP_MAX_AGE_HOURS`=26 h -> FAIL alert), so one skipped daily run alerts within ~2 h. Limits: checks local `BACKUP_DIR` only (not offsite copy); the monitor runs on the same host, so a dead host needs the external probe (see deploy/monitoring/README.md, OPEN). Not verified on a server: delivery requires `velto-monitor --test-alert` received by a human.

## Recovery procedure
Never restore over production in place. Restore into a NEW database, verify, then switch the app.
1. Fetch the latest `velto-db-*.dump.gpg` and its `.sha256` (offsite via the read-only identity if the server is lost). `sha256sum -c velto-db-*.gpg.sha256` must say OK.
2. Provision a Postgres 16 and restore roles first: globals (`velto-globals-*.sql.gpg`, superuser) -> set each role's password (`\password`) -> on a CLEAN database `psql -d <prod_db> -v velto_env=production -f packages/database/scripts/provision-roles.sql` (as superuser; prod uses the host's role names - see deploy/README.md role runbook, do not run it as is on a foreign host).
3. Drill-style verification (local/staging): `DUMP_FILE=<file> BACKUP_PASSPHRASE_FILE=<pass> SOURCE_URL=<src> DRILL_KEEP_DB=1 deploy/backup/restore-drill.sh` -> all checks PASS.
4. Real restore: `createdb velto_restored` (clean), then `gpg -d file | pg_restore --exit-on-error --single-transaction --no-owner --no-privileges -d velto_restored` (superuser), then `psql -f packages/database/scripts/provision-backup-role.sql`; `prisma migrate status` = up to date (use `migrate deploy` only if the dump is older than the code). Same order as "Порядок восстановления БД" below.
5. Point `DATABASE_URL/DATABASE_SYSTEM_URL` to the new DB (env, no repo change), `pm2 restart`, check `/health/ready`. Keep the damaged DB for forensics; do not drop it.
6. Data written after the last backup (<= 24 h) is lost; reconcile held offline payments per the reconciliation runbook.

## Measured locally (2026-11-02)
Synthetic consistent dataset `velto_restore_src_synth_20261102` (46 migrations, demo seed: 282 orders/invoices, 195 payments+allocations, 1842 stock movements, 49 RLS tables): backup 1 s, 388 KB `.gpg`; restore (create + pg_restore + roles) 9 s; full drill with 13 checks 12 s; all PASS (report `docs/ops/restore-drill-synth-2026-11-02.md`). Tiny data on a laptop: NOT representative of production volume; earlier velto_dev drill: 35-57 s on 76-80 MB.
Checks: sha256, gpg decrypt, negatives (corrupted `.gpg` -> gpg exit 2 and sha256 FAILED; wrong passphrase -> exit 2), `_prisma_migrations` == repo, migrate status, RLS ENABLE+FORCE, allocation sums, invoice total = sum(lines), StockLevel = sum(StockMovement), AuditLog append-only trigger, row counts vs source, tenant isolation as `velto_app`.

## OPEN (not proven)
1. Real offsite upload with a put-only key and bucket policy/Object Lock/lifecycle (needs provider + storage owner; rclone path untested against a real bucket).
2. Restore drill on a separate stand/server (different OS/PG minor, real roles/host), and on production-sized data (RTO).
3. Alert delivery check end to end (deploy/monitoring alert channel; missed-run/dead-man detection).
4. Schedule not installed; `BACKUP_GLOBALS_URL` (roles) not configured.
5. RPO <= 15 min (WAL/PITR) is plan-only: `docs/ops/wal-pitr-plan.md`.
6. Legal data-location review for the offsite provider (TZ 11.5, ADR-008).

---

# Часть 2. Offsite: рабочая процедура, полный inventory восстановления, drill, RPO/RTO (2026-11-02)

Статус: ПЛАН/ПРОЦЕДУРА. На сервере ничего не выполнялось, реальный bucket не создан, секреты не генерировались. Всё помеченное «замерить на стенде» заполняется только по реальному прогону.

## A. Одного pg_dump НЕДОСТАТОЧНО

`velto-db-*.dump.gpg` восстанавливает только данные Postgres. Рабочий Velto после потери сервера требует ещё (источники фактов: `apps/api/src/common/config/env.schema.ts`, `storage.service.ts`, `deploy/README.md`):

| Что | Почему критично | Где хранится / как бэкапится | Если потеряно |
|---|---|---|---|
| S3-объекты (один bucket `S3_BUCKET`, `storage.service.ts:37`): `products/{companyId}/…` (картинки, `products.controller.ts:76`), `imports/{customers\|products}/{companyId}/…` (`import.service.ts:43`), `opening/{opening-customers\|opening-stock}/{companyId}/…` (`opening-balances.service.ts:128`), `exports/1c/{companyId}/{jobId}.*` (`export-1c.constants.ts:28`), `exports/company/{companyId}/{jobId}.xlsx` (`company-export.constants.ts:36`) | В БД только ключи; без объектов скачивание/повтор/сверка с 1С и ACK невозможны | **НЕ покрыто текущими скриптами** (backup.sh = только PG). Нужен отдельный бэкап bucket (см. раздел B) | Файлы 1С/импортов/opening потеряны; ключи в БД «висят» |
| `MFA_ENCRYPTION_KEY` (`secret-box.ts:35`) | Шифрует TOTP-секреты (`UserMfa.secretCiphertext`). Старого ключа-fallback нет | Только в `.env.production.local` + офлайн-копия у PO (менеджер паролей) | TOTP-секреты нечитаемы; вход по recovery-кодам работает (`mfa.service.ts:221`), затем повторная регистрация MFA для всех пользователей |
| `OFFLINE_KEK_SECRET`, `OFFLINE_KEK_VERSION`, `OFFLINE_KEK_PREVIOUS_SECRETS` (`offline-kek.service.ts:41`) | Выводят KEK оффлайн-хранилищ агентов; ротация по версиям | env + офлайн-копия; предыдущие секреты хранить, пока есть устройства со старой версией | Оффлайн-хранилища на устройствах не раскрыть; несинхронизированные данные агентов потеряны (`vault.ts:99`) |
| `JWT_ACCESS_SECRET` | Подпись access-токенов | env + офлайн-копия | Не катастрофа: новые токены; refresh-токены в БД (хэш) работают (`auth.service.ts:571`) |
| `S3_*`, `REDIS_URL`/пароль Redis, `DATABASE_URL`, `DATABASE_SYSTEM_URL`, `DATABASE_MIGRATE_URL` | Подключение к зависимостям | env + офлайн-копия **и** запись в менеджере паролей; значения НЕ в репозитории и НЕ в бэкапе БД | Пересоздаются, но пароли ролей Postgres должны совпасть с `provision-roles.sql`/`globals` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `SMS_API_TOKEN`, `SENTRY_DSN` (пуст) | Внешние интеграции | выпускаются у провайдера заново | Перевыпуск у провайдера; initData со старым токеном невалидна |
| `.env.production.local` (файл целиком) | Совокупность выше | chmod 600, вне git; шифрованная копия вне сервера (см. B.5) | См. строки выше |
| `/etc/velto/backup.env`, `backup.pass`, `monitor.env` | Без `backup.pass` все бэкапы нечитаемы | root 600 + офлайн-копия пароля | Бэкапы = мусор. Критично |
| nginx (`deploy/nginx.conf`-сниппет + внешний 443-блок хоста), TLS-сертификаты (certbot) | Внешний блок и сертификаты не в репозитории | Конфиги хоста копировать в зашифрованный архив; сертификат перевыпускается certbot | Перевыпуск за минуты при наличии DNS |
| PM2: `deploy/ecosystem.config.js` в git; сохранённый список `pm2 save` | Процесс `velto-api`, порт и пути — по репозиторию | git + `pm2 save` | Пересоздаётся из репозитория |
| Роли Postgres: `packages/database/scripts/provision-roles.sql` в git; пароли ролей — в env | Дамп с `--no-owner --no-privileges` не несёт владельцев/grants | git; globals (`pg_dumpall --globals-only`) снимаются по умолчанию ролью `velto_backup` (`BACKUP_GLOBALS_URL` — опциональное переопределение) | Роли пересоздаются скриптом, пароли — из env |
| Версия миграций | `_prisma_migrations` приезжает с дампом | сверка `restore-drill.sh` (3b); код той же ревизии (git tag/commit в `deploy.sh`-логе) | Дамп новее кода → ошибка схемы; старее → `migrate deploy` |
| Redis | см. ниже: НЕ источник истины | AOF желателен, в бэкап не входит | Восстанавливается из БД (sweeps) |

### Redis после потери (факты из кода)
- Очереди BullMQ in-process. Истина по задачам — в PG. Sweeps пересоздают очереди из БД: `import-commit` каждые 5 мин (`import-recovery.service.ts:46`), `1c-export`/`company-export` каждые 5 мин (`export-1c-recovery.service.ts:47`), `notification-telegram` каждые 60 с (`notification-delivery-sweep.service.ts:41`); планировщики `idempotency-cleanup` (hourly) и `reconciliation-daily` (03:00 Asia/Tashkent) пересоздаются при старте API.
- Не восстанавливается: «курьерские пинги» (нет outbox — `notifications.service.ts:156`), challenge MFA-логина, лимитер логина, состояние сброса пароля (`auth-challenge.store.ts`, `login-rate-limiter.service.ts`, `password-reset.service.ts` — в Redis): пользователи входят/запрашивают код заново.
- Вывод: бэкап Redis не требуется; обязателен `appendonly yes` + `noeviction` (deploy/README.md:80), чтобы не терять очередь при рестарте. После восстановления БД + пустой Redis: старт API → дождаться sweeps (≤5 мин) → проверить, что нет задач PENDING/PROCESSING старше 30 мин (SQL ниже).
- Остальные очереди (analytics и т.п.) не проверялись — «проверить на стенде».

## B. Offsite: рабочая процедура (после выбора провайдера PO)

**B.1 Шифрование и хранение ключа.** Сейчас: симметричное `gpg --symmetric AES256`, passphrase из `BACKUP_PASSPHRASE_FILE` (`backup.sh:40-49,63`); passphrase в offsite не загружается (`offsite-sync.sh:4`). Хранение: (1) `/etc/velto/backup.pass` root 600; (2) копия у PO в менеджере паролей; (3) вторая копия (запечатанный конверт/другой ответственный). Раз в квартал — проверка расшифровки на машине оператора. Потеря passphrase = потеря всех бэкапов. Вариант на решение PO: асимметричное шифрование (на сервере только публичный ключ, приватный офлайн) — убирает passphrase с сервера, **требует изменения `backup.sh`/`restore-drill.sh`**, сейчас не реализовано.

**B.2 Расписание.** `velto-backup.timer.example`: ежедневно 02:15 (+RandomizedDelay 300 s, Persistent). Установка — по шапке `velto-backup.service.example` (root-owned `/opt/velto/deploy/...`). Для RPO 6 ч (см. раздел F) добавить `OnCalendar` или второй таймер; для deploy — `deploy.sh` делает собственный шифрованный backup перед миграцией.

**B.3 Отдельные учётные данные.** `OFFSITE_S3_*` ≠ `S3_*` приложения; другой аккаунт/провайдер, чем VPS и S3 приложения. Три идентичности: (1) server-put (на сервере, только запись); (2) restore-read (read-only, хранится ВНЕ сервера у PO/оператора); (3) admin (владелец bucket: политики, versioning, lifecycle — не на сервере).

**B.4 Минимальные права server-put (пример, формат AWS IAM/S3-совместимый; точный синтаксис зависит от провайдера):**
- Allow: `s3:PutObject` на `arn:aws:s3:::<bucket>/prod/*`; `s3:ListBucket` на bucket с условием prefix `prod/` (rclone `copy` читает листинг получателя; список имён ≠ чтение данных).
- Deny: `s3:GetObject`, `s3:DeleteObject`, `s3:DeleteObjectVersion`, `s3:PutBucketPolicy`, `s3:PutLifecycleConfiguration`, `s3:PutBucketVersioning`, `s3:PutObjectRetention`, `s3:BypassGovernanceRetention`.
- НЕ ПРОВЕРЕНО на реальном bucket: нужен ли `ListBucket` для `rclone copy --immutable --s3-no-head` (`offsite-sync.sh:25`); если провайдер запрещает List — загрузка упадёт; проверить на стенде и зафиксировать фактический минимум прав.

**B.5 Защита от удаления/перезаписи (требование к провайдеру).** Versioning + Object Lock (Compliance или Governance) с retention ≥ 30 дней, если провайдер поддерживает; если нет — вариант «append-only через отдельный аккаунт + запрет delete политикой» и явная запись остаточного риска (компрометация сервера → удаление/порча при отсутствии Lock). Локально `rclone copy --immutable` уже не удаляет и не перезаписывает (`offsite-sync.sh:5,25`). Дополнительно: шифрованная копия конфигов (`.env.production.local`, `backup.env`, nginx/host-конфиги) НЕ кладётся тем же put-ключом автоматически — отдельное решение PO (секреты в offsite только в зашифрованном виде, с отдельным passphrase).

**B.6 Бэкап S3-объектов приложения (ПРОБЕЛ).** Текущие скрипты S3 не бэкапят. Варианты: (a) версионирование + Object Lock на самом S3 приложения, (b) периодический `rclone copy` bucket приложения → offsite-bucket отдельной read-only парой ключей приложения-источника и put-only парой назначения, (c) репликация на уровне провайдера. Выбор — PO; до выбора пункт «S3 восстановим» = NOT_TESTED. Финансовые файлы (1С, company export, opening) автоматически не удаляются (FILE-RETENTION-MATRIX).

**B.7 Контрольная сумма.** (1) Перед загрузкой: `backup.sh` пишет `.sha256` после проверки (`backup.sh:61,70`), оба файла загружаются (`offsite-sync.sh:26`). (2) После загрузки автоматической проверки НЕТ (ключ put-only не читает) — ручная процедура на машине оператора с restore-read ключом, раз в неделю в пилоте: скачать последний `.dump.gpg` + `.sha256` в пустой каталог → `sha256sum -c velto-db-*.gpg.sha256` → должен быть OK; затем `gpg -d … | pg_restore -l >/dev/null`. (3) Перед любым restore: `sha256sum -c` обязателен, при несовпадении брать предыдущий бэкап. Не полагаться на ETag многочастной загрузки как на MD5 (зависит от провайдера).

**B.8 Уведомление об ошибке.** `backup-run.sh:39-51`: сообщение = `VELTO-BACKUP-FAILED host= step= exit= ts=` (без вывода команд, без ПДн/сумм), канал — `BACKUP_ALERT_CMD` либо `velto-monitor --alert backup-<step>` (отдельный ops-бот, `monitor.env`), иначе `logger`. Устаревший бэкап (>26 ч) ловит `velto-monitor` (check `backup`). Не покрыто: давность/наличие объекта в offsite (monitor видит только локальный каталог). Критерий PASS — реальная доставка (см. MONITORING-ACCEPTANCE-CHECKLIST.md).

**B.9 Retention.** Локально `BACKUP_RETENTION_DAYS=14` (`backup.sh:18,83`) — удаляет только локальные копии. Offsite: Lock ≥ 30 дн + lifecycle expiry 60–90 дн задаёт владелец bucket; юридический срок хранения не установлен (FILE-RETENTION-MATRIX, открытый вопрос 1) — число не выдумывается.

**B.10 Диск.** Локальный `BACKUP_DIR` должен быть на диске с запасом ≥ 14 × размер дампа; `velto-monitor` проверяет `MONITOR_DISK_PATHS` ≥ 80 %. Размер дампа на пилоте — замерить на стенде.

## C. Drill восстановления (на стенде/локально, НИКОГДА на prod)

Предусловия: scratch-кластер Postgres 16 (не `velto_dev`, не prod), `restore-read` копия бэкапа, passphrase.
1. `sha256sum -c velto-db-*.gpg.sha256` → OK.
2. Запуск: `DUMP_FILE=<файл.gpg> BACKUP_PASSPHRASE_FILE=<pass> DRILL_DB=velto_restore_drill_<дата> DRILL_REPORT_DIR=<вне репозитория или docs/ops> deploy/backup/restore-drill.sh` (имя БД обязано начинаться с `velto_restore_drill`; не-локальный хост требует `DRILL_ALLOW_REMOTE=1`; параметры доступа — через env, значения не печатаются). **Для drill на реальных данных `DRILL_REPORT_DIR` обязан быть вне репозитория** (по умолчанию `docs/ops` отслеживается git; отчёт не содержит сумм, но содержит имена, диапазоны и объёмы). `DRILL_COMPARE_SOURCE=1` — только если источник неизменен.
3. Что проверяет скрипт сам (`restore-drill.sh`): sha/gpg/restore; `provision-roles.sql`; `prisma migrate status`; `_prisma_migrations` == репозиторий; Invoice.total = Σlines; RLS ENABLE+FORCE на всех таблицах с `companyId`; счётчики таблиц vs источник; StockLevel = Σ StockMovement; суммы аллокаций (нет переаллокации); AuditLog (уникальность, диапазон) + append-only trigger (UPDATE отклонён); изоляция тенантов под `velto_app`.
4. **Добавлено в эту сессию** (были пробелами): проверка ролей `velto_app`/`velto_owner` = NOSUPERUSER NOBYPASSRLS, `velto_system` = BYPASSRLS (раздел 8c скрипта); отпечаток финансовых сумм «Invoice count+Σtotal | Payment count+Σamount | PaymentAllocation count+Σamount | Σ Customer.cachedBalance» с автосравнением с источником в snapshot-режиме (8b; в режиме `DUMP_FILE` без quiescent-источника — SKIP с выводом значения для ручного сравнения).
5. Вне скрипта (делает человек/CI): запустить на восстановленной БД ежедневный reconciliation (`reconciliation-daily`) и убедиться в 0 расхождений BALANCE/STOCK (формула баланса — единственный источник `CustomersService.getLedger`, `reconciliation.service.ts:199-222`); проверка S3-объектов (раздел E); запуск API против восстановленной БД + Redis-пустой, `/health/ready` = up, вход тестовым пользователем.
6. Drill считается пройденным только если все строки PASS и (для финансовых сумм) нет SKIP при наличии источника.

## D. Read-only SQL-проверки (выполнять роль `velto_system` на восстановленной БД; имена из `schema.prisma`)

```
-- 1. RLS: таблицы с companyId без ENABLE+FORCE (ожидается 0 строк)
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','p')
   AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='companyId' AND NOT a.attisdropped)
   AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
-- 2. Роли (ожидается app/owner: false,false; system: false,true)
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('velto_app','velto_owner','velto_system');
-- 3. Триггеры на AuditLog (ожидается ≥1 запрещающий UPDATE/DELETE)
SELECT tgname FROM pg_trigger WHERE tgrelid='"AuditLog"'::regclass AND NOT tgisinternal;
-- 4. Счёт и суммы (сравнить с источником/протоколом бэкапа)
SELECT count(*), sum(total) FROM "Invoice";
SELECT status, count(*), sum(amount) FROM "Payment" GROUP BY status ORDER BY status;
SELECT count(*), sum(amount) FROM "PaymentAllocation";
-- 5. Аллокации: платёж не переаллоцирован; счёт не переоплачен (ожидается 0 / 0)
SELECT count(*) FROM "Payment" p JOIN (SELECT "paymentId", sum(amount) s FROM "PaymentAllocation" GROUP BY 1) a ON a."paymentId"=p.id WHERE a.s>p.amount;
SELECT count(*) FROM "Invoice" i JOIN (SELECT pa."invoiceId", sum(pa.amount) s FROM "PaymentAllocation" pa JOIN "Payment" py ON py.id=pa."paymentId" WHERE py.status IN ('POSTED','PENDING_HANDOVER') GROUP BY 1) a ON a."invoiceId"=i.id WHERE a.s>i.total;
-- 6. Остаток: StockLevel vs движения (формула restore-drill.sh STOCK_SQL; ожидается 0/N)
--    см. restore-drill.sh:57-62
-- 7. Зависшие задачи после рестарта (ожидается 0 после ≤5 мин)
SELECT count(*) FROM "ImportJob" WHERE status IN ('PENDING','PROCESSING') AND COALESCE("updatedAt","createdAt") < now() - interval '30 minutes';
SELECT count(*) FROM "ExportJob" WHERE status IN ('QUEUED','PROCESSING') AND "updatedAt" < now() - interval '30 minutes';
```
Примечание: «FIFO-согласованность» в схеме выражена как инвариант аллокаций (`PaymentAllocation`; schema.prisma:1075-1095), отдельной таблицы партий FIFO для остатков нет — проверяется пунктами 4–5 и reconciliation (п. C.5), а не отдельным запросом. Порядок самих аллокаций (по возрасту счетов) SQL-ом без бизнес-правил не доказать — это тест приложения, не restore-проверка.

## E. Восстановление S3-объектов (после выбора варианта B.6)
Скопировать объекты в новый bucket; для выборки по БД: `ExportJob.storageKey`, `ImportJob`-url, `company export` ключи (schema.prisma:1375 и FILE-RETENTION-MATRIX) — проверить, что `HeadObject` каждого ключа успешен; расхождения = список потерянных файлов для PO. Скрипта для массовой сверки нет (ПРОБЕЛ; не создавался: требует доступа приложения к S3, вне рамок).

## F. RPO/RTO: варианты (числа не выдуманы)

| Вариант | RPO (теор.) | Сложность / стоимость | Риски | Статус |
|---|---|---|---|---|
| 1. Ежедневный dump (сейчас) | до 24 ч | минимальная | потеря дня платежей/заказов; оффлайн-платежи сверять вручную | реализован в скриптах, на сервере не включён |
| 2. Dump каждые 6 ч | до 6 ч | таймер ×4, больше места/трафика в offsite | нагрузка pg_dump на VPS (замерить), рост хранилища | требует правки таймера; `deploy.sh` независим |
| 3. WAL archiving + base backup (PITR) | минуты (цель ТЗ ≤15 мин: `archive_timeout=300`) | pgBackRest/WAL-G, отдельный репозиторий с шифрованием, drill PITR | сложность, мониторинг архива | только план: `docs/ops/wal-pitr-plan.md` |
| 4. Снапшоты VPS провайдера | зависит от провайдера | дёшево | не заменяет логический dump; в той же зоне отказа | дополнение, не замена |

Замерено локально (синтетика, 660 KB): restore 1–9 с, drill 3–12 с — НЕ репрезентативно. На стенде: RPO фактический = ___ ; RTO (скачать из offsite + sha + gpg + restore + roles + migrate + S3 + запуск) = ___ ; объём дампа = ___ ; пропускная способность offsite = ___ . Решение PO по варианту — после замера.

## G. Локальный синтетический прогон 2026-11-02 (после доработки скрипта)
Источник — scratch `velto_restore_src_synth_20261102` (синтетика), цель `velto_restore_drill_synth3_20261102` (удалена скриптом после прогона). Все проверки PASS, включая новые: roles NOBYPASSRLS и financial sums (Invoice 282 / Σ 85332648.27; Payment 195 / Σ 50183699.78; Allocation 195 / Σ 50183699.78; Σ cachedBalance 35148948.49). Restore 1–2 с, всего 3–4 с на 660 KB — только локальная синтетика, НЕ RTO. `velto_dev` и docker-контейнеры не затрагивались.

## OPEN (дополнение к списку выше)
7. Бэкап S3-объектов приложения (B.6) — решение PO, реализации нет.
8. Асимметричное шифрование вместо passphrase на сервере (B.1) — решение PO, нужна правка скриптов.
9. Реальный offsite с Object Lock и проверка минимума прав server-put (B.4).
10. Хранение/копии секретов `MFA_ENCRYPTION_KEY`, `OFFLINE_KEK_*` вне сервера — подтвердить PO по PILOT-RUNTIME-SECRETS-CHECKLIST.md.


# Часть 3. D-1 (S3-объекты), D-3 (статус-аттестация, deploy gate), D-4 (30 дней) — 2026-11-02

Статус: скрипты и тесты готовы; НИЧЕГО не включено на сервере; PASS по восстановимости не объявляется (нужен drill на стенде с реальным провайдером).

## Что делает root-сервис `velto-backup.service` (каждые 20 минут с 2026-11-03, см. Часть 4; `velto-backup.timer.example`)
`backup.sh` (DB + globals) -> `objects-backup.sh` (5 префиксов) -> `offsite-sync.sh` (если `OFFSITE_ENABLED=1`) -> атомарно пишет `/var/lib/velto-backup/status` (root:root 0644, каталог root:root 0755). Ошибка любого шага пишет `result=failed STEP=...` (старый ok не остаётся «свежим») и шлёт алерт. Формат: строки `KEY=VALUE` (только `[A-Za-z0-9._:-]`), парсится grep, не `source`. Поля: `ts`/`TIMESTAMP_EPOCH`, `result`/`RESULT`, `VERIFY`, `RUN_ID`, `DB_/GLOBALS_/OBJ_ ARCHIVE|SIZE|SHA256`, `OBJ_COUNT`, `OBJ_MANIFEST_SHA256`, `OBJECTS`, `OFFSITE`, `offsite_ts`, `offsite_result` (последние для velto-monitor). Секретов и путей к ключам нет.
`deploy.sh` (velto-deploy) проверяет: файл и каталог принадлежат root (uid 0 зашит литералом), не group/world-writable, не symlink, строгая грамматика без дублей, `result=ok`, `VERIFY=ok`, возраст <= `VELTO_BACKUP_MAX_AGE_MIN` (60), каждый архив: имя по шаблону, обычный файл root-owned, размер и sha256 ШИФРОТЕКСТА пересчитываются самим deploy. Шифртекст читаем группой `velto-deploy` (0640): это выбрано вместо доверия `.sha256`-sidecar, потому что sidecar не ловит подмену архива вместе с sidecar; passphrase у deploy нет, каталог для deploy read-only. Нечитаемый архив = отказ (fallback на sidecar нет). По умолчанию deploy сначала просит свежий бэкап правилом sudoers `systemctl start velto-backup.service` (oneshot: код возврата = результат) и требует обновлённый статус. Любой отказ = стоп до install/migrate, авто-restore нет, обходного флага нет.

## Матрица префиксов S3 (ключи: storage.service.ts, products.controller.ts:76, import.service.ts:43, opening-balances.service.ts:128, export-1c.constants.ts:28, company-export.constants.ts:36)
| Префикс | Что это | Регенерируемо? | Решение | Восстанавливать |
|---|---|---|---|---|
| `products/{companyId}/` | картинки товаров (`Product.imageUrl`, публичные) | нет (загруженные файлы; осиротевшие остаются) | бэкап + restore | ДА, иначе битые картинки в каталоге |
| `imports/{customers\|products}/{companyId}/` | исходные файлы импорта | нет | бэкап + restore; авто-удаление ЗАПРЕЩЕНО (FILE-RETENTION-MATRIX) | ДА (аудит/источник) |
| `opening/{opening-customers\|opening-stock}/{companyId}/` | исходники начальных остатков | нет | бэкап + restore | ДА (аудит) |
| `exports/1c/{companyId}/` | файлы выгрузки 1С (`ExportJob.storageKey`, ключ детерминирован) | технически перегенерируется из БД, но ACK/хэши (`fileHash`) привязаны к конкретному файлу | бэкап (дёшево) + restore | ДА, чтобы совпадали ACK/хэши; без него — только перегенерация с новым файлом |
| `exports/company/{companyId}/` | архивы экспорта компании (ADR-045) | перегенерируется, но считается финансовым документом (матрица) | бэкап + restore | ДА (по матрице auto-delete запрещён) |
Объекты ВНЕ этих префиксов не копируются; `objects-backup.sh` предупреждает о них. Приложение не удаляет файлы, lifecycle-очистка на app-bucket НЕ включается; чистятся только старые АРХИВЫ бэкапов (30 дней локально; offsite — Object Lock 30 дней, дальше решает владелец хранилища).

## Объектный бэкап: как устроен
rclone (любой S3-совместимый: AWS/Wasabi/B2/MinIO/...) под ОТДЕЛЬНЫМ read-only ключом (`OBJECTS_SRC_*`, `policies/backup-reader-app-bucket.json`) -> staging в `BACKUP_DIR/.objects-work.*` (нужно свободное место >= размера bucket, `OBJECTS_MIN_FREE_MB`) -> `MANIFEST.tsv` (sha256, size, key) -> tar -> gpg AES256 тем же passphrase -> проверка потоком (число файлов, хэш манифеста внутри архива) -> `.sha256`. Каждый объект, существовавший ДО копирования, обязан присутствовать с тем же размером. Ключи: app / backup-read / offsite-put-only / restore-read — четыре разных идентификатора (`deploy/backup/policies/`); скрипты падают, если ключ backup/offsite совпадает с `S3_ACCESS_KEY` приложения (`VELTO_APP_ENV_FILE`) или друг с другом.
Restore: `restore-objects.sh <archive> --to-bucket|--to-dir [--prefix products/]` — только в ПУСТОЙ bucket (иначе отказ), сверка каждого объекта с манифестом до загрузки, побайтовая сверка после (`rclone check --download`).
Ограничения: полный архив каждый раз (без инкремента) — при росте bucket это определяющая стоимость часового режима (см. RPO-RTO-ASSESSMENT.md); ключи с `\r` отклоняются; offsite bucket — «голое» имя без `/` (put+list ключ не может открыть prefix-root в rclone, проверено на MinIO); `OBJECTS_BACKUP_ENABLED=0` помечает статус `OBJECTS=disabled`, deploy тогда требует `VELTO_REQUIRE_OBJECTS=0`.

## Порядок восстановления БД (согласовано с db-rls)
1. Globals как superuser (`velto-globals-*.sql.gpg`; пароли ролей в бэкап НЕ входят: `--no-role-passwords`). 2. `\password` каждой роли по runbook секретов. 3. На чистой БД `psql -d <prod_db> -v velto_env=production -f packages/database/scripts/provision-roles.sql` (скрипт работает с `current_database()`). 4. `pg_restore --exit-on-error --single-transaction` от superuser (мажор клиента = мажор сервера). 5. `provision-backup-role.sql`. 6. Объекты: `restore-objects.sh` в пустой bucket, затем переключение приложения — отдельный одобренный шаг.

## Тесты (статические/синтетические; на сервере не запускались)
`deploy/backup/tests/backup-gate.test.sh` (32: нет бэкапа, устарел, подмена/усечение архива, сервис упал, подделка статуса, позитив), `deploy/tests/deploy-abort.test.sh` (8), `deploy/tests/env-parse.test.sh` (18), `deploy/backup/tests/objects-minio.test.sh` (32, throwaway MinIO в docker как синтетический S3, 2 компании x 5 префиксов, restore в пустой bucket, put-only/Object Lock/разделение ключей), `deploy/backup/tests/db-e2e-measure.sh` (замеры).

## Изолированный drill 2026-11-03 (ADR-067; синтетика, НЕ RPO/RTO)
Протокол: `RESTORE-DRILL-ISOLATED-2026-11-03.md`. Одноразовые postgres:16.15 + MinIO (offsite = отдельный bucket с Object Lock), runner на образе postgres:16 под root, 2 tenant (seed-load), 43 объекта в 5 префиксах; после прогона удалены только ресурсы `velto-drill-*`.
`backup-run.sh` rc=0 (роль `velto_backup`) → 3 архива gpg AES256, plaintext нет → offsite (манифест набора загружен последним) → sha256 3/3 после скачивания → `restore-drill.sh` set-mode rc=0 (17 PASS, 1 SKIP финансовые суммы) → `restore-objects.sh` dir+bucket 43/43 sha256.
После restore: RLS+FORCE на всех таблицах с `companyId`; UPDATE/DELETE AuditLog отклонены для 4 ролей; Invoice/Payment/Allocation/StockMovement — count+sum+md5 по компаниям совпали; verify-integrity 0 строк; чужие строки 0 в обе стороны.
Негатив: повреждённый/усечённый/отсутствующий архив, удалённый объект, подмена sha/count в манифесте → rc=1; только БД → rc=2 PARTIAL. `backup-run.sh`: неверный пароль БД rc=2, неверный offsite-ключ rc=10, объект вне 5 префиксов rc=1 — везде алерт через `velto-monitor.sh --alert` и RECOVERED после успешного прогона. 23 файла логов/алертов × 15 секретов = 0 совпадений.
Время (backup 2 с, restore 1 с) — локальное, на крошечном объёме; строка 35 матрицы остаётся NOT_TESTED.

## OPEN (Часть 3)
11. Реальный offsite с Object Lock у выбранного провайдера и проверка put-only политики именно на нём (в тесте — MinIO).
12. Drill на стенде: полный цикл velto-backup.service под root -> deploy.sh под velto-deploy (в песочнице root-owner проверен только аргументом/CLI с uid 0).
13. Размер/время объектного архива на реальных данных (полный архив ежечасно может не уложиться).
14. Переход текущего хоста (всё под root) на раскладку users (deploy/system/) — отдельное плановое изменение.
15. Манифест набора не подписан, offsite сверяется по размеру (ADR-067 §5 R1/R2): регулярный drill из offsite обязателен, put-only ключ + Object Lock.
16. `restore-drill.sh` не сверяет финансовые суммы без внешнего fingerprint (SKIP): на стенде снять fingerprint источника до backup.

---

# Часть 4. R1 подпись манифеста, R2 read-back offsite, R4 финансовый fingerprint, каденс 20 мин — 2026-11-03

Закрывает пункты 15 и 16 «OPEN (Часть 3)» в коде и тестах; на сервере НИЧЕГО не включено (user action). Протокол: `RESTORE-DRILL-ISOLATED-2026-11-03-R1R4.md`.

## Что изменилось в наборе (restore set)
Набор = `velto-db`, `velto-globals`, `velto-objects`, `velto-fp-<TS>.txt.gpg` (fingerprint, gpg AES256 той же парольной фразой), `.sha256`, `velto-set-<TS>.manifest` и `velto-set-<TS>.manifest.sig` (detached gpg-подпись манифеста). В манифесте: имя/размер/sha256 каждого архива, включая `FP_*`; `OFFSITE_VERIFY=readback-sha256`. Порядок offsite: архивы -> листинг (размеры) -> `.sig` -> манифест ПОСЛЕДНИМ -> листинг -> read-back sha256 каждого объекта. Без подписи, без `FP_ARCHIVE` или без read-back ключа запуск не считается точкой восстановления (fail closed).

## R1 ключи (ОТДЕЛЬНЫЙ ключ подписи; парольная фраза бэкапа ничего не подписывает)
Генерация на сервере под root (приватный ключ остаётся только там; каталог `/var/lib/velto-backup-sign` root:root 0700 создаёт `deploy/system/velto-tmpfiles.conf`, в `ReadWritePaths` юнита):
- `GNUPGHOME=/var/lib/velto-backup-sign gpg --batch --pinentry-mode loopback --passphrase '' --quick-generate-key 'velto-backup-sign' ed25519 sign never`  (срок `never`: истёкший ключ задним числом отклонит и старые наборы; ротация решается политикой, не сроком)
- отпечаток: `gpg --homedir /var/lib/velto-backup-sign --with-colons --list-keys | awk -F: '/^fpr/{print $10; exit}'`  -> `BACKUP_SIGN_KEY_FPR` в `/etc/velto/backup.env`
- публичный ключ: `gpg --homedir /var/lib/velto-backup-sign --export <FPR> > backup-sign-public.gpg`
Без пароля на ключе (иначе `BACKUP_SIGN_PASSPHRASE_FILE`, root 600). Права: каталог и владелец root, режим без доступа group/world: `backup-run.sh` отказывается иначе (`sign-key-perms`).
Распространение отпечатка: PO/владелец записывает 40-hex ПЕРВИЧНОГО отпечатка вне сервера (менеджер паролей) и сверяет глазами: `gpg --show-keys --with-fingerprint backup-sign-public.gpg`. На рабочей станции восстановления лежат ДВЕ вещи, полученные не из бэкапа: `BACKUP_VERIFY_KEYRING` (экспорт публичного ключа) и `BACKUP_TRUSTED_SIGN_FPRS` (закреплённые первичные отпечатки через пробел/запятую; допускается >1 для ротации). Проверка: GOODSIG + ровно один VALIDSIG из `--status-fd`, первичный отпечаток в списке; EXPKEYSIG/REVKEYSIG/BADSIG/NO_PUBKEY = отказ; пустой keyring/список = отказ.
Ротация: (1) создать K2 на сервере; (2) на станции добавить K2: `cat pub1.gpg pub2.gpg > keyring.gpg`, `BACKUP_TRUSTED_SIGN_FPRS="F1 F2"`; (3) на сервере `BACKUP_SIGN_KEY_FPR=F2`, обновить `BACKUP_VERIFY_KEYRING`/`BACKUP_TRUSTED_SIGN_FPRS`; (4) когда последний набор, подписанный K1, вышел из срока (30 дней offsite) — убрать F1. Компрометация: убрать F1 из списка немедленно, добавить сертификат отзыва в keyring (REVKEYSIG), решить судьбу наборов, подписанных до инцидента.

## R2 read-back offsite
`offsite-sync.sh` скачивает каждый загруженный объект (`rclone cat`, без записи на диск) ОТДЕЛЬНЫМ read-only ключом `OFFSITE_VERIFY_S3_*` (`policies/offsite-restore-read.json`, третий ключ: не равен writer, app и objects) и сравнивает sha256 байтов с манифестом/локальным файлом. Размер и multipart ETag доказательством не считаются; провайдер не известен, поэтому read-back обязателен для всех. Нет ключа / ошибка скачивания / расхождение = exit 11, `offsite_result=failed`, предыдущая подтверждённая точка сохраняется. Выключателя нет. Цена: egress ~1x объёма набора на каждый запуск (3 запуска/час); у провайдеров с платным egress учесть заранее. Restore/drill повторно считают sha256 каждого файла.

## R4 финансовый fingerprint
`backup.sh` экспортирует snapshot (`pg_export_snapshot`) в одной REPEATABLE READ READ ONLY транзакции, `pg_dump --snapshot=` и fingerprint считаются на ОДНОМ срезе (доказано при живом писателе, см. протокол). Таблицы (`fingerprint-lib.sh`): Invoice, InvoiceLine, Payment, PaymentAllocation, PaymentReversal, PaymentIntentResolution, StockMovement, GoodsReceiptLine, Customer, AuditLog; на таблицу: count, суммы денежных/количественных колонок, sha256 по каноническим упорядоченным строкам. Отдельных таблиц ledger и FIFO-слоёв в схеме НЕТ: ledger = Invoice+Payment+PaymentAllocation(+Reversal), FIFO = аллокация платежей PaymentAllocation; StockLevel без `id` (проекция StockMovement) проверяется drill, не хэшируется. Файл только в зашифрованном виде (psql -> gpg, plaintext на диск не пишется). Drill пересчитывает на восстановленной БД: в логе только имя таблицы и MATCH/MISMATCH. Набор без fingerprint = `NOT_VERIFIED`, exit 3, никогда PASS. Коды drill: 0 PASS, 1 FAIL, 2 PARTIAL (только БД), 3 NOT_VERIFIED.

## Шаги восстановления (рабочая станция, НЕ prod)
1. Скачать набор read-ключом: `rclone copy RESTORE:velto-offsite-backups ./set` (манифест + `.sig` + архивы).
2. Окружение: `BACKUP_VERIFY_KEYRING`, `BACKUP_TRUSTED_SIGN_FPRS` (свои копии), `BACKUP_PASSPHRASE_FILE`.
3. Быстрая проверка набора: `bash -c '. deploy/backup/backup-status-lib.sh; bsm_verify_signed ./set/velto-set-<TS>.manifest ./set && echo OK || echo "$BSM_REASON"'` (подпись -> sha256 каждого файла -> нет лишних файлов).
4. `DRILL_SET_MANIFEST=./set/velto-set-<TS>.manifest bash deploy/backup/restore-drill.sh` (PASS только при exit 0). Реальное восстановление: `pg_restore` из `velto-db-*.dump.gpg` только после шага 3, затем `restore-objects.sh`.

## Каденс и ретенция
Таймер каждые 20 минут (`OnCalendar=*:00/20:00`, `RandomizedDelaySec=60`, `Persistent=true`), `Type=oneshot` + `flock` в `backup-run.sh` (второй запуск при активном первом выходит с кодом 0 и ничего не делает; без `flock` отказ, `BACKUP_ALLOW_NO_FLOCK=1` только для macOS-разработки). `TimeoutStartSec=45min`. Локальная ретенция по наборам (`bk_prune_sets`): все наборы младше 48 ч, дальше первый набор каждых суток до 30 суток, остальное и «осиротевшие» архивы (без манифеста) удаляются; offsite не трогается. Пороги монитора WARN 40 / CRIT 50 мин не менялись. Бюджет возраста: T(20)+j(<=1)+D+O+U <= 60 мин, т.е. D+O+U <= ~39 мин. D измерено на синтетике (`tests/db-e2e-measure.sh`): 11 с на БД 344 МБ (из них fingerprint ~2 с), ноутбук, fsync=off; O (объекты) и U (upload + read-back) НЕ измерены на реальном канале/объёме: до замера на проде вывод «60 мин достижимо» — гипотеза.

## OPEN (Часть 4)
17. Реальный провайдер: Object Lock + put-only + read-only ключ read-back именно на нём; egress-тариф.
18. systemd (таймер, `flock` под юнитом, `ReadWritePaths` для gpg-homedir) на сервере не запускался.
19. O и U на реальных данных; решение «WAL вместо 20-минутных dump» если run > ~15 мин.
20. Заверенная доставка отпечатка ключа подписи на станцию восстановления — организационный шаг PO.

## Часть 4, дополнение (аудит 2026-11-03): rollback/replay, retention, lock
- Имя манифеста не подписано, поэтому подписан `SET_TS` (= TS в имени) и `RUN_ID`: `bsm_verify_signed` требует SET_TS == TS имени, TS архивов DB/GLOBALS/FP == SET_TS, objects не старше набора. Переименованный валидно подписанный манифест = отказ.
- Replay старого валидно подписанного набора (новые удалены): `restore-drill.sh` в set-режиме ТРЕБУЕТ `DRILL_MAX_RESTORE_POINT_AGE_MINUTES` (возраст подписанного `RESTORE_POINT_TS`; старше = FAIL) либо `DRILL_EXPECT_RUN_ID=<RUN_ID>` для осознанного исторического восстановления. Остаточный риск: удаление новых наборов на offsite предотвращается Object Lock (GOVERNANCE 30 d, put-only ключ), а исчезновение свежей точки видит монитор по `offsite_ts` из root-owned локального статуса (WARN 40 / CRIT 50 мин); подписанные данные сами по себе актуальность не доказывают.
- drill работает с приватной копией набора (0700) и перепроверяет подпись/sha256 копии (TOCTOU). `BACKUP_SIGN_PASSPHRASE_FILE`: root, регулярный файл, режим 0600/0400, иначе `sign-key-perms`. Подпись обязана быть detached (embedded-data подпись отклоняется).
- Retention выполняется `backup-run.sh` ПОСЛЕ проверенного нового набора (не в `backup.sh`); хранителем дня становится самый ранний набор, прошедший проверку манифеста/sha256; самый новый проверенный набор не удаляется; без верификатора ничего не удаляется.
- Lock занят: `backup-run.sh` завершает с кодом 75 и алертом `lock-busy` (resolve при следующем запуске, получившем lock); держатель snapshot-сессии завершается по таймауту (`FP_SNAP_MAX_SECONDS`, 7200) или при исчезновении родителя и не наследует fd 9.
