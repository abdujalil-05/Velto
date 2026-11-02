# Требования к серверу закрытого пилота v0.9

> 2026-11-02, ветка `feat/approved-decisions`. Только план и проектные оценки. **Сервер не куплен и не настроен.** Числа в §3 — «проектная оценка, не измерено»: на сервере пилота они не проверялись. Порядок установки: [`PILOT-DEPLOYMENT-RUNBOOK.md`](./PILOT-DEPLOYMENT-RUNBOOK.md). Секреты: [`PILOT-RUNTIME-SECRETS-CHECKLIST.md`](./PILOT-RUNTIME-SECRETS-CHECKLIST.md). Размещение ПДн граждан Узбекистана подтверждает юрист (матрица, строка 28; `PILOT-INFRA-AUDIT-2026-11-02.md` §9).

## 1. Целевой VPS

| Параметр | Значение | Основание |
|---|---|---|
| vCPU / RAM / диск | 4 / 8 ГБ / ≥120 ГБ NVMe | решение PO; аудит §9 («100–160 ГБ»); расчёт §3 |
| ОС | Ubuntu 24.04 LTS, публичный IPv4, снапшоты провайдера | аудит §9 |
| Node.js | 22 LTS, не ниже 22.12, ниже 27 | `package.json:5-7` (`>=22.12 <27`), `.nvmrc` = 22, CI node 22 (`.github/workflows/ci.yml`). Версия Ubuntu-пакета `nodejs` может быть ниже 22 (не проверено): ставить 22 LTS из официального источника и проверять `node -v` |
| pnpm | 11.17.0 | `package.json:8` (`packageManager`) |
| PostgreSQL | 16 (в dev-compose `postgres:16-alpine`, `docker-compose.yml:5`) | `apt-cache policy postgresql` на сервере: подтвердить, что кандидат — 16 |
| Redis | 7 (`docker-compose.yml:25`) | `apt-cache policy redis-server` — подтвердить мажор |
| Процессы | PM2: `velto-api` (fork, 1 instance), `velto-web`, `velto-miniapp` | `deploy/ecosystem.config.js:63-100` |
| nginx | TLS 1.2/1.3, HTTPS, HSTS, certbot | `deploy/nginx.conf` + новый `deploy/nginx-pilot-server.conf.example` (nginx -t пройден локально, см. runbook §«Проверки в репозитории») |
| Файлы | приватное S3-совместимое хранилище (MinIO / SeaweedFS / S3 провайдера — выбор PO, строка 15) | `deploy/minio-policy.json`: анонимно только `products/*` |
| Мониторинг | внешний uptime-чекер + `deploy/monitoring/*` | `deploy/monitoring/README.md`; чек-лист `MONITORING-ACCEPTANCE-CHECKLIST.md` |
| Backup | ежедневный шифрованный (gpg) + отдельный offsite, ключ только на запись | `BACKUP-RESTORE-RUNBOOK.md`, `deploy/backup/*` |

Docker на пилоте не используется: `docker-compose.yml` — только dev (пароли-примеры `velto`/`velto12345` на строках 10-11 и 47-48, порты на 0.0.0.0, `minio/minio:latest` на строке 43), Dockerfile в репозитории нет (`PILOT-INFRA-AUDIT-2026-11-02.md` §3). Не использовать его на сервере.

## 2. PM2: один процесс API, без cluster

Причина: BullMQ-воркеры и планировщики выполняются **внутри** процесса API (`apps/api/src/common/queue/queue.module.ts:13-19`; процессоры `@Processor` в `idempotency-cleanup.processor.ts:8`, `reconciliation-schedule.processor.ts:18`, `import.processor.ts:32`, `export-1c.processor.ts:60`, `company-export.processor.ts:37`, `notification-delivery.processor.ts:8`). Плюс таймеры sweep в процессе (`export-1c-recovery.service.ts:38`, `import-recovery.service.ts:32`, `notification-delivery-sweep.service.ts:32`), кэш дашборда в памяти одного процесса (`env.schema.ts:95`: «Single process only (PM2 instances=1, ADR-051)») и повторяемые задания через `upsertJobScheduler` (`idempotency.module.ts:18`, `reconciliation.module.ts:41`). Поэтому `instances: 1, exec_mode: 'fork'` (`ecosystem.config.js:69-70`). Режим cluster не анализировался: его включение требует отдельного анализа (дубли schedulers, кэш, лимитеры отчётов `REPORT_*` на процесс) и отдельного решения; для пилота запрещён.

## 3. Бюджеты (проектная оценка, не измерено)

Исходные значения из конфигурации: `max_memory_restart` 600M на каждый из 3 процессов (`ecosystem.config.js:71,91,100`); пул Prisma 30 (app) + 5 (system) = 35 соединений на процесс API (`packages/database/src/pool-config.ts:21-22`, `env.schema.ts:92-93`); минимум пула ≥ 6×(REPORT_MAX_CONCURRENCY+DASHBOARD_MAX_CONCURRENCY)+6 = 30 при значениях по умолчанию 2+2 (`env.schema.ts:203`); `HEALTH` использует app-пул (`health.controller.ts:43`).

| Ресурс | Потребитель | Оценка | Основание |
|---|---|---|---|
| RAM, потолок процессов Node | api + web + miniapp | ≤ 1,8 ГБ (3×600 МБ) | `max_memory_restart` |
| RAM PostgreSQL | `shared_buffers` 2 ГБ (25% RAM) + backend-ы | ≈ 2,5–3 ГБ | проектная оценка; `effective_cache_size` 5 ГБ, `work_mem` 16 МБ, `maintenance_work_mem` 256 МБ |
| RAM Redis | `maxmemory` 256 МБ, `noeviction` | 0,3 ГБ | проектная оценка; при заполнении Redis отвечает ошибкой записи, ключи BullMQ не вытесняются |
| RAM S3-хранилище + nginx + OS + sshd | | ≈ 0,8–1 ГБ | проектная оценка |
| Остаток под page cache и разовые задачи (pg_dump + gpg, `pnpm build`) | | ≈ 1–1,5 ГБ | сумма выше ≈ 6,6–7,5 ГБ из 8 ГБ: запас мал. `pnpm build` (Next ×2 + Nest) на этом же VPS может не поместиться: добавить swap 2 ГБ или собирать вне сервера (решение Ops, не измерено) |
| Соединения PostgreSQL | api 30+5, monitor ≤2 (`monitor-role.sql`, `CONNECTION LIMIT 2`), backup 1–2, миграции 1, админ 2 | ≈ 45 из `max_connections = 100` (значение по умолчанию) | `.env.example` комментарий «well below max_connections (100)». Увеличивать не нужно; один процесс API |
| Соединения Redis | REDIS_CLIENT (`redis.module.ts:11`) + BullMQ (`queue.module.ts:26`) + воркеры | единицы-десятки | `maxclients` по умолчанию достаточно |
| CPU 4 vCPU | api: 1 event loop; Next ×2; PG; отчёты ≤ REPORT_MAX 2 + DASHBOARD_MAX 2 одновременно | не измерено | нагрузка F7 (строка 29) только GA; для пилота замер на стенде обязателен до допуска пользователей (runbook шаг 12) |
| Диск | ОС ≈ 10 ГБ; БД: dev-дамп 80 МБ gz для 3917 компаний-синтетики — рост пилота неизвестен; backup локально 14 дней × размер дампа (`BACKUP_RETENTION_DAYS=14`, `backup.env.example`); S3-файлы; логи nginx/PM2 | ≥120 ГБ с большим запасом | проектная оценка; срок хранения файлов S3 не решён PO (`FILE-RETENTION-MATRIX.md`) |
| Алерт на диск | `MONITOR_DISK_WARN_PERCENT=80` | | `monitor.env.example` |

Измерить на сервере после установки (команды в runbook): `free -m`, `pm2 monit`/`pm2 jlist` (память процессов), `psql -c "SHOW max_connections"`, `SELECT count(*) FROM pg_stat_activity`, `redis-cli INFO memory`, `df -h`.

## 4. Порты и сеть

| Порт | Сервис | Привязка | Снаружи |
|---|---|---|---|
| 22 | sshd | все интерфейсы | **только с IP администраторов** (`ufw allow from <ADMIN_IP> to any port 22 proto tcp`) |
| 80 | nginx (редирект на 443, ACME) | все | открыт |
| 443 | nginx (TLS) | все | открыт |
| 3100 | `velto-web` (Next) | **все интерфейсы** — без `-H` (`ecosystem.config.js:79-88`: `-H` ломает редиректы next-intl) | закрыт только ufw |
| 3101 | `velto-api` | `API_HOST=127.0.0.1` (`main.ts:39`, `env.schema.ts:24`: по умолчанию `0.0.0.0`, поэтому задать явно: `deploy/env.production.example`) | закрыт |
| 3102 | `velto-miniapp` (Next) | все интерфейсы (как 3100) | закрыт только ufw |
| 5432 | PostgreSQL | `listen_addresses = 'localhost'` | закрыт |
| 6379 | Redis | `bind 127.0.0.1 -::1`, `protected-mode yes` | закрыт |
| 9000 / 9001 | S3-хранилище / консоль | `127.0.0.1` (MinIO: `--address 127.0.0.1:9000 --console-address 127.0.0.1:9001`) | закрыт; наружу объекты `products/*` отдаёт nginx через `/velto-files/` (`nginx.conf:119`) |

3100 и 3102 слушают все интерфейсы: единственная защита — ufw `default deny incoming` и, дополнительно, firewall провайдера (security group) — открыть там только 22 (с IP админов), 80, 443.

Минимальный ufw (выполнять только по runbook шаг 3, и только после проверки, что SSH-доступ по ключу работает во второй сессии):

    ufw default deny incoming
    ufw default allow outgoing
    ufw allow from <ADMIN_IP> to any port 22 proto tcp
    ufw allow 80/tcp
    ufw allow 443/tcp
    ufw enable
    ufw status verbose

Проверка закрытости: на сервере `ss -ltnp | grep -E ':(3100|3101|3102|5432|6379|9000|9001)\b'` — 5432/6379/9000/9001/3101 только `127.0.0.1`, 3100/3102 допустимо `*` (закрыты ufw); с внешней машины `nmap -Pn -p 22,80,443,3100,3101,3102,5432,6379,9000,9001 <ip>` — открыты только 80/443 (22 — только с IP админа, с другого IP filtered). Docker на сервере не ставится, поэтому обход ufw через опубликованные порты Docker невозможен; если Docker всё же появится — ставить правила в цепочку `DOCKER-USER`.

## 5. SSH и пользователи ОС

SSH: только ключи. `/etc/ssh/sshd_config.d/10-velto.conf`: `PasswordAuthentication no`, `PermitRootLogin no`, `KbdInteractiveAuthentication no`, `PubkeyAuthentication yes`, `AllowUsers <admin_user>`; проверка `sshd -t` и **вторая открытая сессия** до `systemctl reload ssh`. Опционально `fail2ban` (пакет, не проверялся).

| Пользователь | Назначение | sudo | Доступ к секретам |
|---|---|---|---|
| `<admin_user>` | человек-администратор, SSH по ключу | да | нет доступа к содержимому секретов без необходимости |
| `velto` | владелец checkout, `.env.production.local`, PM2-демон; запускает `deploy.sh`, `prisma migrate deploy`, процессы `velto-*` | нет | `.env.production.local` (600) |
| `postgres` | PostgreSQL | — | свои данные |
| `redis` | Redis | — | свой `redis.conf` / `requirepass` |
| `root` (юнит `velto-backup.service`, sandbox) | backup + offsite | — | `/etc/velto/backup.env`, `backup.pass` (600 root) — `deploy/backup/velto-backup.service.example:7-9` |
| `velto-monitor` | `velto-monitor.service` без root | нет | `/etc/velto/monitor.env` (640 root:velto-monitor) — `deploy/monitoring/README.md` п.3b |

Отклонение от «отдельный deploy-пользователь и отдельный runtime-пользователь»: PM2 перезапускает процессы только от пользователя-владельца демона, а `deploy.sh` собирает код и вызывает `pm2 restart` в одном запуске (`deploy.sh:76`), поэтому deploy и runtime объединены в `velto`. Миграции идут ролью БД `velto_owner`, которая не попадает в окружение процессов (`ecosystem.config.js:45-46`). Это решение D-2 для PO/Tech Lead (раздел «Решения» в runbook).

Конфликт `deploy.sh` и ключа backup — см. runbook, решение D-3: `deploy.sh:44-50` требует `BACKUP_PASSPHRASE_FILE`, читаемый пользователем, который запускает `deploy.sh`.

## 6. Роли PostgreSQL

`packages/database/scripts/provision-roles.sql`: `velto_owner` (владелец БД и схемы, миграции, `CREATEDB` только для shadow DB `migrate dev`, строка 51), `velto_app` (DML, NOBYPASSRLS, строка 52), `velto_system` (BYPASSRLS, строка 53). Скрипт создаёт отсутствующие роли с паролями-примерами (`'velto_owner'` и т.д., строки 38/41/44). На пилоте роли создаются **заранее** с реальными паролями, тогда скрипт их не пересоздаёт (проверка `IF NOT EXISTS`), а только фиксирует атрибуты (runbook шаг 5). Отдельные роли: `velto_monitor` (`deploy/monitoring/monitor-role.sql`, read-only счётчики). Отдельной роли backup нет: `backup.sh` использует `DATABASE_SYSTEM_URL` (`backup.env.example`), то есть пароль `velto_system` встречается и в `.env.production.local`, и в `/etc/velto/backup.env` — см. находку F-5 в runbook.

## 7. Redis

`/etc/redis/redis.conf` (проверить после установки `redis-cli CONFIG GET`): `bind 127.0.0.1 -::1`, `protected-mode yes`, `requirepass <из /etc/velto, 600 redis>`, `appendonly yes`, `appendfsync everysec`, `maxmemory 256mb` (проектная оценка), `maxmemory-policy noeviction`, `port 6379`. Требование из кода: production отклоняет `REDIS_URL` без пароля (`env.schema.ts:179-182`) и с паролями-примерами (`:175`); `noeviction` — чтобы не терялись ключи BullMQ (`deploy/README.md:80`). Деградация без Redis: `docs/runbooks/degraded-redis.md`; `/health/ready` вернёт 503 (`health.controller.ts:97,100`).

## 8. Что не покрыто этим документом

Фактическая версия Node на выбранном хосте; стоимость и выбор провайдера (решение PO + юрист); нагрузка F7; выбор S3 (MinIO/SeaweedFS/провайдер); WAL/PITR (GA, строка 22).
