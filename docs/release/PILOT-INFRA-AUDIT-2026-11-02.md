# Аудит инфраструктуры закрытого пилота v0.9

> 2026-11-02, ветка `feat/approved-decisions`, база `0eac6bc`. Только факты. Реальный сервер не трогался; всё ниже выполнено локально на синтетических данных (`velto_dev`, демо-тенанты).

## 1. CI для `0eac6bc`

Run `41428945051`: **success**. test: success (api 1285/1285, database 143 + 3 skip, miniapp 207/207; lint, typecheck, build в том же job); `pnpm audit --prod --audit-level=high`: прошёл (7 moderate, неблокирующие); SAST (Semgrep): success; Secret scan (gitleaks): success. PR #1 остаётся Draft.

## 2. Offline Security: итог

Строка 32 матрицы (PASS, Chrome E2E 8/8) принята PO как завершённая техническая проверка. Повторно не запускалась. Границы проверки (статусы не меняются):
- тестовый Web login ≠ реальный Telegram login (строки 3, 4, 26: BLOCKED_EXTERNAL);
- сверка через API ≠ полная ручная проверка Web UI (строка 7: NOT_TESTED);
- реальные Android/iPhone не проверены (строка 17: BLOCKED_EXTERNAL).

## 3. Что есть / чего нет

| Область | Статус | Факт |
|---|---|---|
| Docker | PARTIAL | `docker-compose.yml` только dev (порты на 0.0.0.0, пароли-примеры, `minio:latest` без pin). Dockerfile нет; production — PM2 |
| deploy.sh | PARTIAL | env → **зашифрованный backup** → install → generate → migrate → build → pm2 → smoke. Нет zero-downtime и авто-отката |
| Node.js | PASS (код) | `engines >=22.12 <27`, CI node 22, `.nvmrc` 22. Boot guard `assertJsonSourceSupport` (`json-number-guard.ts:52`) бросает до `listen` (fail-closed); теперь есть негативный тест. На сервере не проверено |
| PM2 | PARTIAL | fork, 1 instance (BullMQ in-process → кластер запрещён), `max_memory_restart 600M`. Нет `interpreter`, logrotate, backoff |
| PostgreSQL | PARTIAL | роли owner/app/system, RLS FORCE (48 таблиц подтверждены после restore). TLS/shm/pool для prod не задокументированы |
| Redis | MISSING (prod) | dev без пароля/AOF/noeviction. Теперь production отклоняет `REDIS_URL` без пароля; AOF + `noeviction` описаны в README, не проверены |
| S3 | PARTIAL | `@aws-sdk/client-s3`, провайдер-независимо; см. §5 |
| HTTPS/nginx | PARTIAL | `nginx.conf` — сниппет, TLS/HSTS/certbot зависят от внешнего 443-блока хоста |
| Health | PASS | `/health/live`; `/health/ready` (DB, Redis, storage → 503) |
| Monitoring / error tracking / alerting | MISSING | `SENTRY_DSN` пуст, uptime/алертов нет; ошибка backup → только exit≠0 |
| Логи | PARTIAL | traceId, AuditLog append-only (DB trigger). Нет JSON-формата, redaction-конфига, ротации |
| Secrets | PASS (код) | `.env.production.local` chmod 600, вне git; см. §4 |

## 4. Исправлено в этой сессии (reviewer PASS, security-auditor PASS)

1. **HIGH** `env.schema.ts`: production принимал публичные `JWT_ACCESS_SECRET` (`change-me-…`, `ci-only-…`) → подделка токена любого тенанта. Теперь отклоняются; также S3-ключи-примеры, пароли-примеры в `DATABASE_URL`/`DATABASE_SYSTEM_URL`/`REDIS_URL`, Redis без пароля и плейсхолдер `MFA_ENCRYPTION_KEY`. Хелперы — `common/config/secret-placeholders.ts`.
2. **HIGH** `deploy/minio-policy.json`: анонимный `GetObject` на весь bucket → выгрузки 1С, экспорт компании, импорты читались анонимно (на реальном S3: HTTP 200). Теперь только `products/*`.
3. **MED** `sms.service.ts`: без `SMS_API_TOKEN` код сброса пароля и телефон писались в лог PM2 в production. Теперь только общий warning + `SMS_NOT_CONFIGURED` (503); ответ сброса пароля не меняется (нет enumeration).
4. **MED** `ecosystem.config.js`: production подмешивал dev `.env`. Теперь читается только `.env.production.local`; пароль backup удаляется из env процессов.
5. **MED** `deploy.sh`: перед миграцией писал **незашифрованный** `.sql` в `/root`. Теперь вызывает `backup.sh` (gpg, проверка, `.sha256`), требует `BACKUP_PASSPHRASE_FILE` вне репозитория; подсказка отката восстанавливает в **отдельную** БД (без `--clean` по prod).
6. `backup.sh`: найден реальный дефект: проверка `gpg | pg_restore -l` под `pipefail` падала по SIGPIPE на настоящем дампе, т.е. скрипт не мог успешно отработать. Исправлено потоковой проверкой без незашифрованного файла на диске. Добавлен `.sha256`.
7. `restore-drill.sh`: в режиме `DUMP_FILE` сравнение с источником → явный SKIP/внутренний инвариант вместо ложного FAIL.

Открыто (LOW, решение PO): в production без `SMS_API_TOKEN` сервер стартует, сброс пароля по SMS молча не доставляется. Сделать токен обязательным при boot, только если на пилоте есть SMS-провайдер.

## 5. S3-совместимое хранилище

Образы MinIO недоступны (Docker Hub denied, quay.io без манифеста, bitnami not found). Проверка выполнена на **SeaweedFS** (реальный S3-gateway, не эмулятор) с реальными `Export1cProcessor`/`StorageService`/download/ack и Postgres RLS:
EXCEL GENERATED (9113 B) · SHA-256 скачанного = `fileHash` · анонимный GET/LIST 403 · компания B → 404, traversal отклонён · ACK EXCEL → 409, статус не меняется · S3 недоступен → job QUEUED→FAILED с errorLog, без частичного состояния; после восстановления retry → GENERATED, один объект.

Не проверено / GAP: MinIO-специфичная политика (`mc anonymous set-json`); **signed URL отсутствуют** (скачивание идёт потоком через API с проверкой прав; ТЗ требует signed URL + срок: нужно ADR или presigner); **нет очистки старых файлов** (нужен срок хранения от PO/юриста + lifecycle rule); при недоступном S3 скачивание отдаёт сырой 500 (LOW). Строка 15 остаётся BLOCKED_EXTERNAL до решения PO: принимается ли SeaweedFS или нужен MinIO/S3 стенда.

## 6. Backup / restore

| Проверка | Результат |
|---|---|
| `backup.sh` с gpg (AES256) на `velto_dev` | OK: 10 с, 80 МБ `.gpg`, `.sha256 -c` OK |
| Повреждённый `.gpg` | проверка rc=1 (fail-closed) |
| Restore в изолированную `velto_restore_drill_gpg_20261102` | restore 29 с, drill 35 с; PASS: RLS FORCE 48, row counts 49, суммы аллокаций, AuditLog 41687 + append-only trigger, tenant isolation |
| Сверка (отдельный drill, openssl) | совпали: Company 3917, Customer 170523, StockMovement 350265 (Σqty 7844797.685), Payment 46920 (Σ306811948.41), Invoice 168816 (Σ667133031.42), Σ cachedBalance 126882642.51, grants md5 |
| 2 FAIL drill | не дефект restore: `velto_dev` сам отстаёт на 2 миграции; drift StockLevel 274 строк есть и в источнике (dev-данные) |
| Offsite, cron/timer, разделение доступа, алерт | **не настроено** (нет сервера) |

Строки 20/21 не меняются: 21 остаётся NOT_TESTED (нет offsite, нет запуска на стенде пилота). Удалить учебные БД (не выполнялось):
`psql postgresql://velto:velto@localhost:5433/postgres -c 'DROP DATABASE velto_restore_drill_20261102' -c 'DROP DATABASE velto_restore_drill_gpg_20261102'`

## 7. SEC-010, SEC-011, восстановление (Master TZ v5.0)

- SEC-010 (потеря backup): PARTIAL — шифрование + checksum + drill есть; offsite с отдельными учётными данными, расписание и алерт отсутствуют.
- SEC-011 (потеря телефона агента): закрыт кодом строки 32 (per-user ключ, offline logout); на реальных устройствах не проверен (строка 17).
- RPO пилота ≤24 ч (NFR-REL-002): достаточно ежедневного `backup.sh` после настройки на сервере. RPO ≤15 мин (GA): WAL/PITR только план (строка 22). RTO ≤4 ч: локально 35–57 с на 76–80 МБ; на объёме production не измерен.

## 8. Матрица: разбивка (счёт не меняется: PASS 13 · FAIL 0 · BLOCKED_EXTERNAL 9 · NOT_TESTED 10)

- **Готово технически (PASS):** 1, 8–14, 16, 20, 27, 31, 32.
- **Нужен реальный сервер:** 15 (S3 стенда), 21 (backup+offsite), 23 (Node/PM2), 24 (secrets), 25 (backfill dry-run), 6 (коды MFA).
- **Нужна ручная проверка / устройства / Telegram:** 2, 3, 4, 5, 7, 17, 26.
- **Зависит от бухгалтера:** 18, 19.
- **Юрист/PO:** 28; подписи: 30.
- **Только v1.0 GA:** 22, 29.

## 9. Требования к серверу (для закупки, не измерения)

Один VPS для пилота (api + web + miniapp + Postgres 16 + Redis 7 + S3): 4 vCPU, 8 ГБ RAM, 100–160 ГБ NVMe SSD, Ubuntu 24.04 LTS, публичный IPv4, снапшоты. Ориентир стоимости: порядка 20–60 USD/мес у местного или международного провайдера. Плюс отдельное offsite-хранилище для backup (другой провайдер/аккаунт, ключ только на запись, без права удаления). Размещение персональных данных граждан Узбекистана — требование локализации (Закон «О персональных данных», ст. 27¹): выбор хостинга подтверждает юрист (строка 28).

## 10. Что нужно от PO (секреты в чат не передавать)

1. Сервер: выбор хостинга (с учётом локализации), SSH-доступ по ключу для Ops (не пароль).
2. Домен + DNS A-запись; HTTPS через certbot на сервере.
3. S3: MinIO на сервере (бинарник `dl.min.io`, pinned release) или S3 провайдера; решение по строке 15 (принять ли SeaweedFS-прогон).
4. Secrets: генерируются **на сервере** (`openssl rand -base64 48`/`-base64 32`) прямо в `.env.production.local` (chmod 600, владелец — пользователь PM2) и `/etc/velto/backup.pass` (chmod 600, root); пароль backup дополнительно храните офлайн в менеджере паролей PO, отдельно от сервера.
5. Offsite backup: второй аккаунт/bucket с ключом только на запись.
6. Тестовый Telegram bot (токен вносится на сервере через `.env.production.local`, не в чат).
7. Реальные Android и iPhone для строк 3, 4, 17.
8. Конфигурация 1С и контакт бухгалтера (строки 18, 19).
9. Решения: срок хранения файлов S3; signed URL vs потоковое скачивание через API (ADR); обязателен ли SMS-провайдер на пилоте.
