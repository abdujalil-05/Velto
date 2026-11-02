# Runbook развёртывания пилота v0.9 на отдельном VPS

> **НЕ выполнять до отдельного разрешения PO.** Документ — план: на момент написания (2026-11-02, ветка `feat/approved-decisions`) сервера нет, ни один шаг не выполнялся, статусы матрицы не менялись. Требования и бюджеты: [`PILOT-SERVER-REQUIREMENTS.md`](./PILOT-SERVER-REQUIREMENTS.md). Секреты: [`PILOT-RUNTIME-SECRETS-CHECKLIST.md`](./PILOT-RUNTIME-SECRETS-CHECKLIST.md). Backup/restore: [`BACKUP-RESTORE-RUNBOOK.md`](./BACKUP-RESTORE-RUNBOOK.md). Мониторинг: [`MONITORING-ACCEPTANCE-CHECKLIST.md`](./MONITORING-ACCEPTANCE-CHECKLIST.md). Данные/ПДн: [`PILOT-DATA-INVENTORY.md`](./PILOT-DATA-INVENTORY.md). Go/No-Go: `PILOT-RELEASE-CONDITIONS.md` §D.
> Используются существующие `deploy/deploy.sh`, `deploy/ecosystem.config.js`, `deploy/nginx.conf`, `deploy/minio-policy.json`, `deploy/backup/*`, `deploy/monitoring/*`. Новые файлы-шаблоны (без секретов): `deploy/env.production.example`, `deploy/nginx-pilot-server.conf.example`. Второй системы деплоя нет.
> Существующий хост `auto-message.uz/velto` (`deploy/README.md`) этим runbook не затрагивается: его порт 3101, процесс `velto-api`, пути `/root/projects/parviz_aka/Velto` и роли `velto_app_system`/`velto_app_owner` на новом сервере **не копируются** (на новом сервере роли стандартные из `provision-roles.sql`).
> Обозначения: `<CHECKOUT>` — каталог клона, например `/home/velto/velto`; `<PILOT_DOMAIN>` — домен пилота (даёт PO); `<SHA>` — коммит с зелёным CI, утверждённый PO. Команды с `sudo` — от администратора; «как `velto`» — `sudo -iu velto`. Пароли никогда не передаются в аргументах команд и не печатаются.

## Решения и находки, влияющие на порядок (читать до шага 1)

| ID | Тема | Факт (файл:строка) | Что нужно |
|---|---|---|---|
| D-1 | S3: MinIO, SeaweedFS или S3 провайдера | образы MinIO недоступны (`PILOT-INFRA-AUDIT-2026-11-02.md` §5); матрица, строка 15 | PO |
| D-2 | deploy и runtime — один пользователь `velto` | PM2 перезапускает процессы только от владельца демона; `deploy.sh:76` | PO/Tech Lead |
| D-3 | Ключ backup и `deploy.sh` | `deploy.sh:44-50` требует `BACKUP_PASSPHRASE_FILE` в окружении пользователя, запускающего `deploy.sh` | вариант A (рекомендуется): изменить `deploy.sh` так, чтобы перед деплоем проверялся свежий backup, сделанный root-юнитом (`systemctl start velto-backup.service`); правка кода не сделана без разрешения. Вариант B (до появления реальных данных): файл-ключ группы `velto` 640 — ключ backup читается пользователем приложения, допустим только на синтетике |
| D-4 | Срок хранения файлов S3, signed URL vs поток через API (ADR-065) | `FILE-RETENTION-MATRIX.md`, `ADR-065-API-STREAM-DOWNLOADS.md` | PO/юрист |
| D-5 | SMS-провайдер на пилоте | без `SMS_API_TOKEN` сервер стартует, сброс пароля по SMS отвечает 503 `SMS_NOT_CONFIGURED`; ручное восстановление `ACCOUNT-RECOVERY-RUNBOOK.md` | PO |
| D-6 | Где хранится офлайн-копия `MFA_ENCRYPTION_KEY`, `OFFLINE_KEK_SECRET`, `backup.pass` | `deploy/README.md:141` | PO |
| F-1 MED | `API_PORT`/`API_HOST`/`TRUST_PROXY` не задаются ни `ecosystem.config.js`, ни `.env.example`; значения по умолчанию 3001 / `0.0.0.0` / `false` (`env.schema.ts:20,24,134`), а nginx и smoke ждут 3101 (`nginx.conf:46`, `deploy.sh:94`) | закрыто шаблоном `deploy/env.production.example` (код не менялся) |
| F-2 MED | `readEnvFile` (`ecosystem.config.js:24-29`) не отрезает комментарии после значения, а `source` в `deploy.sh:36` отрезает: `KEY=value # note` даёт разные значения в PM2 и в миграциях | в `.env.production.local` комментарии только отдельными строками (правило в шаблоне) |
| F-3 MED | `provision-roles.sql:38,41,44` создаёт роли с паролями-примерами, owner имеет `CREATEDB` (:51) | роли создаются заранее с реальными паролями (шаг 5); скрипт не пересоздаёт существующие |
| F-4 LOW | `env.schema.ts` в production не требует `CORS_ORIGINS` отличным от localhost, `TRUST_PROXY`, `API_HOST` | проверять по чек-листу шага 9 |
| F-5 MED | backup использует `velto_system` (BYPASSRLS) — тот же пароль, что у приложения (`backup.env.example`: `DATABASE_SYSTEM_URL`) | отдельная роль `velto_backup` (BYPASSRLS, только чтение) — решение Tech Lead, потребует проверки `backup.sh`; до этого пароль `velto_system` хранится в двух файлах |
| F-6 LOW | Next-процессы слушают все интерфейсы (`ecosystem.config.js:79-88`) | ufw + firewall провайдера (шаг 3) |
| F-7 LOW | `restore-drill.sh:38` подставляет `velto_owner` как пароль по умолчанию | drill только на отдельной БД; всегда задавать `DRILL_*_PASSWORD` |
| F-8 INFO | первый запуск: `pm2 restart` из `deploy.sh:76` не найдёт несуществующие процессы | первый раз — `pm2 start deploy/ecosystem.config.js` (шаг 11); `deploy.sh` — для последующих обновлений |

Подтверждённых critical/high ошибок в `deploy/` и env-шаблонах не найдено; существующие файлы не менялись.

## Шаги

### 1. Проверка Ubuntu и SSH
Действия: снимок провайдера «до»; `lsb_release -ds; uname -m; nproc; free -m; df -h /; timedatectl` (ожидаются 24.04, x86_64/arm64, 4 vCPU, 8 ГБ, ≥120 ГБ, NTP synchronized); `apt update && apt full-upgrade`; `apt install unattended-upgrades`. SSH: ключ админа в `~/.ssh/authorized_keys`; затем `/etc/ssh/sshd_config.d/10-velto.conf` (`PasswordAuthentication no`, `PermitRootLogin no`, `KbdInteractiveAuthentication no`, `AllowUsers <admin_user>`); `sshd -t`; **не закрывая текущую сессию** открыть вторую по ключу; `systemctl reload ssh`.
Успех: `sshd -T | grep -E 'passwordauthentication|permitrootlogin'` → `no`/`no`; вход по паролю отклоняется.
Откат: удалить `/etc/ssh/sshd_config.d/10-velto.conf`, `systemctl reload ssh` (через консоль провайдера, если сессия потеряна); снимок.

### 2. Непривилегированные пользователи
Действия: `adduser --disabled-password --gecos '' velto`; `adduser --system --no-create-home --shell /usr/sbin/nologin velto-monitor`; `install -d -m 755 /etc/velto`; без sudo для `velto`.
Успех: `id velto` (нет группы sudo); `sudo -iu velto true`.
Откат: `deluser --remove-home velto` (до появления данных).

### 3. Firewall
Действия: правила из `PILOT-SERVER-REQUIREMENTS.md` §4 (ufw), плюс firewall провайдера: 22 с IP админов, 80, 443. Проверка SSH во второй сессии до `ufw enable`.
Успех: `ufw status verbose`; с внешней машины `nmap -Pn -p 22,80,443,3100,3101,3102,5432,6379,9000,9001 <ip>`: открыты 80/443, остальное closed/filtered.
Откат: консоль провайдера → `ufw disable`.

### 4. Runtime
Действия (root): `apt install -y git gpg acl build-essential nginx certbot openssl`; Node 22 LTS из официального источника (способ установки выбирает Ops; проверка `node -v` ≥22.12 <27 до продолжения); `corepack enable`; как `velto`: `corepack prepare pnpm@11.17.0 --activate`; `npm i -g pm2@<версия, зафиксировать в протоколе>`; `pm2 startup systemd -u velto --hp /home/velto` (напечатает команду для root — выполнить); `deploy/monitoring/pm2-logrotate.sh` (как `velto`). Клон: `git clone <repo> <CHECKOUT> && git -C <CHECKOUT> checkout <SHA>` (read-only deploy key). Каталог и права: `chmod 750 <CHECKOUT>`.
Успех: `node -v`; `pnpm -v` = 11.17.0; `pm2 -v`; `git -C <CHECKOUT> rev-parse HEAD` = `<SHA>`; `pm2 conf pm2-logrotate`. Строка 23 матрицы закрывается только после `pm2 describe velto-api | grep -i 'node version'` на запущенном процессе (шаг 11).
Откат: `pm2 unstartup`, удалить `<CHECKOUT>`.

### 9a. Генерация секретов (выполнить ДО шага 5)
Действия (как `velto`, на сервере; значения не выводятся):
- `cd <CHECKOUT>; umask 077; cp deploy/env.production.example .env.production.local`
- подставить значения **без передачи секретов в argv** (`sed -e "...$(g)..."` недопустим: значения видны в `ps`). Генерация и запись — только bash-builtin (`printf` и перенаправление не создают процесса с секретом в argv); `openssl` получает лишь длину, не секрет; пароли без `/+=`. Шаблон содержит строки `KEY=REPLACE_ME` — сначала удалить их из копии, затем дописать сгенерированные (URL-строки `DATABASE_*`, `REDIS_URL`, `DATABASE_SYSTEM_URL` — по формату шаблона `deploy/env.production.example`, пароль подставляется builtin-ом):
  `g(){ openssl rand -base64 32 | tr -d '/+=\n'; }; f=.env.production.local; grep -v -E '(^S3_ACCESS_KEY|^S3_SECRET_KEY|^JWT_ACCESS_SECRET|^OFFLINE_KEK_SECRET|^MFA_ENCRYPTION_KEY)=REPLACE_ME' "$f" > "$f.new" && mv "$f.new" "$f"; { printf 'S3_ACCESS_KEY=%s\n' "$(g | cut -c1-20)"; printf 'S3_SECRET_KEY=%s\n' "$(g)"; printf 'JWT_ACCESS_SECRET=%s\n' "$(openssl rand -base64 48)"; printf 'OFFLINE_KEK_SECRET=%s\n' "$(openssl rand -base64 48)"; printf 'MFA_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)"; } >> "$f"` (`$(...)` внутри `printf` — подстановка команды в builtin, секрет не попадает в argv внешнего процесса; `umask 077` уже задан).
  Для паролей внутри URL (`velto_app`, `velto_system`, `velto_owner`, Redis): в файле заменить `REPLACE_ME` в редакторе вручную значением из `g` либо построчно тем же способом (удалить строку `KEY=...REPLACE_ME...` и дописать `printf 'DATABASE_URL=postgresql://velto_app:%s@127.0.0.1:5432/velto\n' "$(g)"` и т.д. по строкам шаблона); один и тот же пароль роли должен попасть и в `DATABASE_URL`, и в шаг 5 (читается оттуда).
- вручную (редактор, без эха): `REPLACE_ME_PILOT_DOMAIN` → `<PILOT_DOMAIN>` (CORS_ORIGINS, S3_ENDPOINT), `APP_VERSION`, `GIT_SHA`.
- `apps/web/.env.production.local`: `NEXT_PUBLIC_BASE_PATH=/velto`, `NEXT_PUBLIC_API_URL=https://<PILOT_DOMAIN>/velto/api`; `apps/miniapp/.env.production.local`: `NEXT_PUBLIC_BASE_PATH=/velto/app`, тот же `NEXT_PUBLIC_API_URL` (`deploy/README.md:19-28`; значение API URL выведено из схемы `nginx.conf:45`, подтвердить по запросам браузера). Значения вшиваются при `next build`.
- Офлайн-копии `MFA_ENCRYPTION_KEY`, `OFFLINE_KEK_SECRET` — по решению D-6. Backup-ключ и файлы `/etc/velto/*.env` — по `BACKUP-RESTORE-RUNBOOK.md`.
Успех: `stat -c '%a %U' .env.production.local` = `600 velto`; `grep -c REPLACE_ME .env.production.local` = 0; `git status --short` не показывает env-файлы (в `.gitignore:12` `.env.*.local`); валидация схемы — при первом старте API (шаг 11); без вывода значений.
Откат: удалить файл и сгенерировать заново (до первого запуска ничего зависящего нет; после — см. таблицу ротации в чек-листе секретов).

### 5. PostgreSQL и роли
Действия (root): `apt install -y postgresql postgresql-contrib`; `psql --version` (ожидается 16). `/etc/postgresql/16/main/conf.d/velto.conf` (проектная оценка, не измерено): `listen_addresses = 'localhost'`, `max_connections = 100`, `shared_buffers = 2GB`, `effective_cache_size = 5GB`, `work_mem = 16MB`, `maintenance_work_mem = 256MB`, `password_encryption = scram-sha-256`, `log_min_duration_statement = 1000`. `systemctl restart postgresql`.
Роли и БД с реальными паролями, пароли берутся из `.env.production.local` через stdin, не через argv:
- `sudo -u postgres createdb velto`
- для каждой роли: `PW=$(sed -n 's#^DATABASE_URL=postgresql://velto_app:\([^@]*\)@.*#\1#p' <CHECKOUT>/.env.production.local)`; `printf "CREATE ROLE velto_app LOGIN PASSWORD '%s';\n" "$PW" | sudo -u postgres psql -v ON_ERROR_STOP=1`; аналогично `velto_owner` (из `DATABASE_MIGRATE_URL`) и `velto_system` (из `DATABASE_SYSTEM_URL`); `unset PW`.
- затем `sudo -u postgres psql -d velto -v ON_ERROR_STOP=1 -f <CHECKOUT>/packages/database/scripts/provision-roles.sql` (скрипт идемпотентен, существующие роли не пересоздаёт, фиксирует атрибуты и права).
- `sudo -u postgres psql -d velto -c 'REVOKE CONNECT ON DATABASE velto FROM PUBLIC'`; `pg_hba.conf`: только `local`/`host 127.0.0.1/32` со `scram-sha-256`.
- `velto_owner` после скрипта имеет `CREATEDB` (:51) — для пилота снять: `ALTER ROLE velto_owner NOCREATEDB` (shadow DB нужна только `migrate dev`, не `migrate deploy`).
Успех: SQL из `deploy/README.md:156-157`: `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname ~ '^velto'` — `velto_app` (f/f), `velto_owner` (f/f), `velto_system` (f/t); `SHOW listen_addresses` = localhost; `ss -ltnp | grep 5432` только 127.0.0.1; нет ролей с паролями-примерами: `PGPASSWORD`-проверка не нужна, достаточно, что входы с паролем-примером отклонены для каждой роли: `for r in velto_app velto_owner velto_system velto_monitor; do psql "postgresql://$r:$r@127.0.0.1/velto" -c 'select 1'; done` → у всех ошибка аутентификации (`velto_monitor` — если создана на шаге 15, иначе роль не существует и ошибка тоже ожидаема; роль `velto_backup` — после решения F-5, та же проверка; пароль-пример в команде допустим — он не секрет).
Откат: до данных — `dropdb velto; DROP ROLE velto_app, velto_owner, velto_system;`. С данными — восстановление в **отдельную** БД из backup (`deploy.sh:101-107`), переключение вручную по отдельному разрешению.

### 6. Redis
Действия (root): `apt install -y redis-server`; `cp -a /etc/redis/redis.conf /etc/redis/redis.conf.orig`; в `redis.conf`: `bind 127.0.0.1 -::1`, `protected-mode yes`, `appendonly yes`, `appendfsync everysec`, `maxmemory 256mb` (проектная оценка), `maxmemory-policy noeviction`; пароль — из `.env.production.local` через stdin: `PW=$(sed -n 's#^REDIS_URL=redis://:\([^@]*\)@.*#\1#p' <CHECKOUT>/.env.production.local); printf 'requirepass %s\n' "$PW" >> /etc/redis/redis.conf; unset PW`; `chown redis:redis /etc/redis/redis.conf; chmod 640 /etc/redis/redis.conf`; `systemctl restart redis-server`.
Успех: `redis-cli ping` → `NOAUTH` (пароль обязателен); `REDISCLI_AUTH=<пароль из env-файла, не печатать> redis-cli CONFIG GET appendonly` = yes, `maxmemory-policy` = noeviction, `bind` = 127.0.0.1; `ss -ltnp | grep 6379` только 127.0.0.1.
Откат: `cp /etc/redis/redis.conf.orig /etc/redis/redis.conf; systemctl restart redis-server` (очереди пусты на старте).

### 7. Хранилище файлов (S3-совместимое, приватное) — по решению D-1
Действия (вариант MinIO; команды MinIO на этой машине не выполнялись, сверить с актуальной документацией релиза): бинарник с `dl.min.io` фиксированного релиза, проверка SHA-256; пользователь `minio` (nologin); `/var/lib/minio`; systemd-юнит `minio server /var/lib/minio --address 127.0.0.1:9000 --console-address 127.0.0.1:9001`; root-учётка MinIO — отдельный секрет, не равный ключу приложения. Бакет `velto-files`; пользователь приложения с ключами `S3_ACCESS_KEY/S3_SECRET_KEY` и политикой только на этот бакет (`s3:GetObject`, `PutObject`, `DeleteObject`, `ListBucket`; `ListBucket` нужен `headBucket` из `/health/ready`, `health.controller.ts:98`). Анонимная политика: `mc anonymous set-json <CHECKOUT>/deploy/minio-policy.json local/velto-files` (**не** `mc anonymous set download`, `deploy/README.md:246-251`). Для SeaweedFS/S3 провайдера — эквивалент: анонимно читать можно только `products/*`.
Успех (после шага 8): `curl -s -o /dev/null -w '%{http_code}' 'https://<PILOT_DOMAIN>/velto-files/?list-type=2'` = 403; `.../velto-files/products/<companyId>/<файл>` = 200; `.../velto-files/exports/1c/<companyId>/<файл>` = 403 (`deploy/README.md:255-257`); `ss -ltnp | grep -E ':(9000|9001)'` — 127.0.0.1. Ключ приложения не может создавать бакеты/пользователей.
Откат: остановить юнит; удалить бакет (только синтетические данные); политика и ключи пересоздаются.

### 8. nginx, TLS, HSTS
Действия: A-запись `<PILOT_DOMAIN>` → IP сервера (PO); `systemctl stop nginx` не требуется. `install -m 644 <CHECKOUT>/deploy/nginx.conf /etc/nginx/snippets/velto.conf`. Сначала только HTTP для ACME: временный сайт `/etc/nginx/sites-enabled/acme-tmp` (`server { listen 80; server_name <PILOT_DOMAIN>; location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; } location / { return 404; } }`), `mkdir -p /var/www/certbot; rm -f /etc/nginx/sites-enabled/default; nginx -t && systemctl reload nginx`; `certbot certonly --webroot -w /var/www/certbot -d <PILOT_DOMAIN> --deploy-hook 'systemctl reload nginx'`. Затем `install -m 644 deploy/nginx-pilot-server.conf.example /etc/nginx/sites-available/velto-pilot; sed -i 's/<PILOT_DOMAIN>/<реальный домен>/g' ...; ln -s ... /etc/nginx/sites-enabled/; rm /etc/nginx/sites-enabled/acme-tmp; nginx -t && systemctl reload nginx`. HSTS в шаблоне стартует с `max-age=300`; после проверок ниже поднять до `31536000` (HSTS запоминается браузерами, `includeSubDomains`/`preload` не включать без решения PO).
Успех: `curl -sI http://<PILOT_DOMAIN>/velto/` → 301 на https; `curl -sI https://<PILOT_DOMAIN>/velto/ | grep -i strict-transport`; `curl -s -o /dev/null -w '%{http_code}' https://<PILOT_DOMAIN>/velto/.env` и `/.env` → 404; `openssl s_client -connect <PILOT_DOMAIN>:443 </dev/null | openssl x509 -noout -dates`; `certbot renew --dry-run`.
Откат: `rm /etc/nginx/sites-enabled/velto-pilot; nginx -t && systemctl reload nginx` (сертификат остаётся).

### 9b. Установка секретов (после шагов 5–8)
Действия: сверить таблицу `PILOT-RUNTIME-SECRETS-CHECKLIST.md` §4 по каждому имени переменной; убедиться, что `API_PORT=3101`, `API_HOST=127.0.0.1`, `TRUST_PROXY=true`, `CORS_ORIGINS=https://<PILOT_DOMAIN>` (находки F-1, F-4).
Успех: S1–S7 чек-листа; boot-валидация на шаге 11.
Откат: см. чек-лист секретов §3 (ротация) и §4 (восстановление).

### 10. Миграции
Действия (как `velto`, окружение подгружается только в подоболочке, `DATABASE_MIGRATE_URL` не попадает в PM2):
`cd <CHECKOUT> && pnpm install --frozen-lockfile && pnpm --filter @velto/database exec prisma generate` затем `( set -a; . ./.env.production.local; set +a; pnpm --filter @velto/database exec prisma migrate status; pnpm --filter @velto/database exec prisma migrate deploy; pnpm --filter @velto/database exec prisma migrate status )`.
Успех: итоговый `Database schema is up to date!`; SQL (суперпользователь): все таблицы схемы public с `relrowsecurity AND relforcerowsecurity` (запрос `deploy/README.md:168-170` возвращает 0 строк); владелец объектов `velto_owner`, а не `velto_app` (запросы `README:160-166`). Ожидаемое число таблиц с RLS FORCE: 48 по `PILOT-INFRA-AUDIT-2026-11-02.md` §6 (на текущем SHA пересчитать, миграции могли добавиться).
Откат: на пустой БД — `dropdb velto` + повтор шага 5 (роли остаются) + шаг 10. С данными — автоматического отката нет; восстановить из backup в отдельную БД (`deploy.sh:101-107`). Утверждение «откат за 5 минут» допустимо только после drill на стенде (`velto-devops` §CI/CD).

### Бэкфилы до открытия API пользователям (A8, A9; строки 6 и 25 матрицы)
Выполняются только после шага 10, **каждый реальный запуск — отдельное разрешение PO**. Окружение как в шаге 10 (`DATABASE_SYSTEM_URL`). Перед реальным запуском — backup (`BACKUP-RESTORE-RUNBOOK.md`).
1. Dry-run прав: `( set -a; . ./.env.production.local; set +a; pnpm --filter @velto/database exec tsx src/backfill-permissions.ts --dry-run )` (`backfill-permissions.ts:21`; при `NODE_ENV=production` без `ALLOW_PRODUCTION_BACKFILL=1` скрипт отказывается **в том числе для dry-run**: `:151-153`; поэтому dry-run выполняется либо в окружении без `NODE_ENV=production`, либо с `NODE_ENV=production ALLOW_PRODUCTION_BACKFILL=1 ... --dry-run`, где флаг разрешает только запуск, а запись в БД выключает `--dry-run`; реальный запуск (без `--dry-run`) — только после отдельного разрешения PO, см. п. 3). Вывод сохранить в протокол, проверить PO. Для БД, созданной `bootstrap-owner.ts` текущей версии, ожидаются 0 изменений (не проверено).
2. Dry-run MFA-права reset: `... tsx src/backfill-mfa-reset-permission.ts --dry-run` (`:12`).
3. После разрешения: те же команды с `NODE_ENV=production ALLOW_PRODUCTION_BACKFILL=1` и без `--dry-run` (`backfill-permissions.ts:24-25`, `backfill-mfa-reset-permission.ts:14`).
4. Коды подключения MFA для существующих OWNER/SALES_DIRECTOR/CASHIER: `NODE_ENV=production ALLOW_PRODUCTION_MFA_ENROLLMENT_CODE=1 ... tsx src/issue-mfa-enrollment-code.ts <companyId> <userId> <reason> <operatorName>` (`issue-mfa-enrollment-code.ts:15,23`); журнал выдачи — в протокол, коды не логировать и не пересылать текстом.
Успех: повторный dry-run показывает 0 изменений; `GET` склада/movements для DIRECTOR/WAREHOUSE не даёт 403 (после запуска API).
Откат: восстановление из backup в отдельную БД либо точечное удаление выданных прав по списку из dry-run (SQL согласует Tech Lead); для кодов MFA — `reset-user-mfa.ts`.

### 11. Запуск на синтетических данных
Действия (как `velto`): `cd <CHECKOUT> && pnpm build && pm2 start deploy/ecosystem.config.js && pm2 save` (первый запуск — не `deploy.sh`, находка F-8). Две синтетические компании (реальных людей и данных нет): demo-seed в production запрещён (`seed.ts:21-22`), `bootstrap-owner.ts` тоже отказывает при `NODE_ENV=production` (`:16-19`), поэтому как `velto`: `( set -a; . ./.env.production.local; set +a; env -u NODE_ENV pnpm --filter @velto/database exec tsx src/bootstrap-owner.ts "SYNTH Tenant A" <синтетический телефон> Synth OwnerA )` и то же для `Tenant B`. Пароль и код MFA печатаются один раз — в терминал, не в файл. Импорт синтетики — через `pnpm --filter @velto/database exec tsx src/seed-load.ts` **нельзя** (dev-нагрузка); данные создаются через UI/API.
Успех: `pm2 status` — три процесса `online`; `pm2 logs velto-api --lines 30 --nostream` без `Invalid environment configuration`; `pm2 describe velto-api | grep -E 'exec mode|instances|node version'` → fork, 1, ≥22.12; `ss -ltnp | grep 3101` → 127.0.0.1; три smoke-URL из `deploy.sh:94-96` дают 200.
Откат: `pm2 delete velto-api velto-web velto-miniapp && pm2 save`; БД не трогать.

### 12. `/health/ready`
Действия: `curl -s http://127.0.0.1:3101/health/live` (процесс, зависимости не трогает, `apps/api/src/health/health.controller.ts:60`); `curl -s -w '%{http_code}' http://127.0.0.1:3101/health/ready` (`apps/api/src/health/health.controller.ts:71`; проверяет PG `SELECT 1`, Redis `PING`, S3 `HeadBucket`, 2 с каждая, `:13,96-98`); снаружи `https://<PILOT_DOMAIN>/velto/api/health/ready`. Негативная проверка в окне работ: `systemctl stop redis-server` → ready 503 с `redis: down`, API-запись заданий быстро отказывает (`QUEUE_ENQUEUE_TIMEOUT_MS` 3000, `env.schema.ts:88`); `systemctl start redis-server` → 200.
Успех: 200 и `{"status":"up","checks":{"db":"up","redis":"up","storage":"up"}}`; тело не содержит текстов ошибок/DSN (`:45`).
Откат: запустить остановленные сервисы.

### 13. Auth, MFA, изоляция компаний
Действия: порядок и ожидаемые ответы — `docs/qa/PILOT-MANUAL-ACCEPTANCE.md` §1 (M1–M4) и `docs/qa/E2E-SMOKE-2026-11-01.md` (шаги 2 и «wrong TOTP → 429»). Минимум: вход OWNER A с подключением MFA кодом из шага 11; повторный вход требует TOTP; токен A против идентификатора записи компании B → 404 и `listLeak=false`; пользователь без права → 403 + запись `auth.permission_denied` в AuditLog. На стороне БД: `psql` под `velto_app` без `SET app.current_company_id` — `SELECT count(*) FROM "Customer"` = 0 (fail-closed, CLAUDE.md «Multi-tenancy»), под `velto_app` `TRUNCATE` отклонён.
Успех: все пункты выше; M1, M4 — ручные, PO (строки 2, 5 остаются NOT_TESTED до протокола).
Откат: удалить синтетические компании нельзя «просто»; при ошибке — пересоздать БД на пустом стенде (шаги 5, 10).

### 14. Фоновые очереди
Действия: `REDISCLI_AUTH=<…> redis-cli --scan --pattern 'velto-pilot:*' | head` — ключи только с префиксом `BULLMQ_PREFIX`; запустить через UI/API синтетический импорт и экспорт 1C (`EXCEL` — `GENERATED` в бакете, SHA-256 совпадает, ACK регистра → 409, `PILOT-INFRA-AUDIT-2026-11-02.md` §5); дождаться зарегистрированных повторяемых заданий (`idempotency-cleanup-hourly`, `idempotency.module.ts:18`; reconciliation, `reconciliation.module.ts:41`); `redis-cli INFO persistence` → `aof_enabled:1`. Сбой Redis/S3 — по `docs/runbooks/degraded-redis.md`, `stuck-jobs.md`.
Успех: задания в финальном статусе, `ImportJob/ExportJob` без застрявших `QUEUED/PROCESSING`; перезапуск `pm2 restart velto-api` не дублирует планировщики.
Откат: `pm2 restart velto-api`; очередь очищать только вместе с PO (данные заданий в БД).

### 15. Мониторинг и алерты
Действия и критерии — `deploy/monitoring/README.md` («Install») и [`MONITORING-ACCEPTANCE-CHECKLIST.md`](./MONITORING-ACCEPTANCE-CHECKLIST.md): роль `velto_monitor` (`monitor-role.sql`, имя БД в файле `velto` — совпадает с шагом 5), пользователь `velto-monitor`, ACL, `velto-monitor.timer`, `velto-monitor --test-alert`, внешний HTTPS-проб `/health/ready`. Не покрыто репозиторием: Redis память/AOF, число рестартов PM2, глубина очереди, падение RLS-теста (только CI).
Успех: человек подтвердил получение реального тестового и боевого алерта; иначе мониторинг NOT PASS.
Откат: `systemctl disable --now velto-monitor.timer`; откат роли в конце `monitor-role.sql`.

### 16. Backup и restore
Действия и критерии — [`BACKUP-RESTORE-RUNBOOK.md`](./BACKUP-RESTORE-RUNBOOK.md): `/etc/velto/backup.env`, `backup.pass` (600 root), `velto-backup.timer`, offsite с ключом только на запись, restore drill в отдельную БД на сервере; отчёт `docs/ops/restore-drill-<date>.md`. Решение D-3 принять до первого `deploy.sh`.
Успех: `.gpg` + `.sha256` `-c` OK; drill PASS; сработавший алерт на искусственный сбой.
Откат: `systemctl disable --now velto-backup.timer`.

### 17. Матрица готовности
Действия: после каждого шага Ops кладёт вывод команд (без секретов) в `docs/ops/pilot-server-evidence-<date>.md` и сообщает PO; статус строки меняет PO/Tech Lead по доказательству: строки 6, 21, 23, 24, 25, 15, 26 (см. `PILOT-READINESS-MATRIX.md`). Успех: ссылка на артефакт в колонке «Доказательство». Откат: вернуть прежний статус записью с причиной.

## Проверки в репозитории (2026-11-02, локально, сервер не использовался)

| Проверка | Команда | Результат |
|---|---|---|
| Синтаксис shell | `bash -n` для `deploy/deploy.sh`, `deploy/backup/*.sh`, `deploy/monitoring/*.sh` | все 8 скриптов OK |
| shellcheck (docker `koalaman/shellcheck:stable`, `-S error`) | `shellcheck -x -S error <8 скриптов>` | rc=0; на уровне warning: SC2209, SC1090, SC2010, SC2064 (`deploy.sh` trap — намеренно), не ошибки |
| ecosystem | `node -e "require('./deploy/ecosystem.config.js')"` | 3 приложения; `velto-api` instances 1, fork, 600M; web/miniapp 600M, окружение Next — 1 ключ |
| nginx | `docker run --rm nginx:1.28-alpine nginx -t` со `deploy/nginx.conf` как snippet + `deploy/nginx-pilot-server.conf.example` (самоподписанный сертификат в scratch-каталоге вне репозитория) | `syntax is ok`, `test is successful` |
| Env-схема | `tsx` + `validateEnv`: `deploy/env.production.example` с `NODE_ENV=production`; затем со сгенерированными по шагу 9a значениями (синтетика, scratch) | шаблон отклонён (6 нарушений); сгенерированные значения приняты, `API_PORT 3101`, `API_HOST 127.0.0.1`, `TRUST_PROXY true` |
| Секреты | `gitleaks detect --no-git` по `deploy/`, `docs/release/`, `.env.example`; grep приватных ключей, токенов бота, AWS-ключей, URL с паролями | утечек не найдено; единственный пароль-пример в `deploy/` — `restore-drill.sh:38` (находка F-7) |

Не проверено: Ubuntu 24.04, версии пакетов apt, команды MinIO/certbot/pm2 startup/ufw/sshd, реальный запуск PM2, реальный TLS, поведение при cluster, нагрузка.
