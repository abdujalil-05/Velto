# План изолированного стенда пилота v0.9

> 2026-11-01. Технический план. **Ничего платного и облачного не создано.** Сервер, домен и TLS для стенда требуют отдельного разрешения PO (WORKING-AGREEMENT §6a, §8).
> Существующий хост `auto-message.uz/velto` (`deploy/README.md`) **не годится** как стенд пилота без изменений. Причины: там демо-seed с общим паролем, общий origin с другими приложениями без CSP, SMS не подключён (код сброса пароля пишется в логи), версия Node неизвестна.

## 1. Варианты

| Вариант | Что это | Изоляция | Для чего годится |
|---|---|---|---|
| L (сейчас) | Локальный стенд на машине разработчика: своя БД `velto_stand_smoke`, свой Redis-контейнер, свой `BULLMQ_PREFIX`, свои секреты | Полная от `velto_dev`, без внешнего доступа | E2E smoke на синтетике, restore drill на синтетике. Не годится для устройств, Telegram и HTTPS |
| S (нужно разрешение) | Отдельный VPS или отдельный поддомен, например `pilot.<домен>` | Отдельные PG, Redis, MinIO и секреты, отдельный бот | Ручная приёмка (`docs/qa/PILOT-MANUAL-ACCEPTANCE.md`), устройства, Telegram, затем пилот |

## 2. Требования к стенду S и способ проверки

| Требование | Как обеспечить (что уже есть в репо) | Проверка |
|---|---|---|
| Отдельные БД и Redis | Отдельный кластер PG 16 и Redis 7, свои пароли ролей; `provision-roles.sql` → `prisma migrate deploy` на **пустую** БД | `psql -l` без чужих БД; `redis-cli INFO keyspace` |
| Нет доступа к production-данным | Разные хосты и креды; дампы production на стенд не переносятся; только `bootstrap-owner.ts` + синтетический импорт | ревизия env; grep по `DATABASE_*` |
| HTTPS | nginx (`deploy/nginx.conf`) + Let's Encrypt, HSTS; **отдельный поддомен**, не общий origin | `curl -I https://...` → HSTS; SSL Labs ≥ A |
| Node ≥22.12 <27 | `.nvmrc` 22, `engines`; PM2 с явным `interpreter` | `node -v`, `pm2 describe velto-api`; boot падает без `context.source` (`json-number-guard.ts`) |
| MFA и RBAC | `MFA_ENCRYPTION_KEY` (32 байта base64), коды подключения `issue-mfa-enrollment-code.ts`, `backfill-permissions.ts --dry-run` перед запуском | журнал выдачи кодов; вывод dry-run |
| Изолированные фоновые задания | BullMQ в процессе API, свой Redis и свой `BULLMQ_PREFIX`; sweep import/export/notification | `redis-cli KEYS '<prefix>:*'` только свои ключи |
| Защищённое хранилище файлов | MinIO, приватный bucket, `deploy/minio-policy.json`, отдельные ключи | анонимный GET и листинг → 403 |
| Health checks | `GET /health/live`, `GET /health/ready` (503 при сбое зависимостей), используются в `deploy/deploy.sh` | внешний uptime-чекер на `/health/ready` |
| Мониторинг ошибок и очередей | `SENTRY_DSN` (сейчас пусто, Sentry выключен); runbooks `docs/runbooks/stuck-jobs.md`, `sync-backlog.md`, `degraded-redis.md`, `db-unavailable.md` | **пробел**: нет алерта на рост очереди и FAILED-задания. Нужно решение PO: Sentry (вендор → реестр subprocessors) или лог-алерты |
| Резервное копирование | `deploy/backup/backup.sh` (pg_dump + gpg AES256, ретенция), `restore-drill.sh` | ежедневный cron + drill на стенде, отчёт `docs/ops/restore-drill-<date>.md`; нужен `gpg` на сервере |
| SMS для сброса пароля | Eskiz не подключён: код сброса уходит в лог | для стенда: только синтетические пользователи; для пилота с реальными людьми — **блокер** (секрет в логах, TZ §16.3) или отключить сброс по SMS решением PO |

## 3. Порядок поднятия стенда S (после разрешения)

1. Сервер, поддомен, TLS. Node 22 LTS, PG 16, Redis 7, MinIO, nginx, PM2, gpg.
2. Секреты генерируются на сервере, в репо и чат не попадают (`deploy/README.md` → Runtime requirements, MFA_ENCRYPTION_KEY).
3. `provision-roles.sql` → `prisma migrate deploy` (пустая БД, без destructive-миграций) → `bootstrap-owner.ts` для синтетической компании → выдача MFA-кода.
4. Build SHA = HEAD ветки с зелёным CI. Сначала `deploy.sh`, затем проверка health gate.
5. Отдельный Telegram-бот для стенда.
6. Backup cron + первый restore drill.
7. E2E smoke (раздел 4) и ручная приёмка.

## 4. Локальный стенд L: выполнено

См. `docs/qa/E2E-SMOKE-2026-11-01.md` (протокол сквозной проверки на `velto_stand_smoke`, синтетика).
