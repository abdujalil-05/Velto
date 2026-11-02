# Условия релиза: закрытый пилот (v0.9) и v1.0 GA

> Состояние на 2026-11-01, ветка `feat/approved-decisions`. Источники: `docs/STATUS.md`, TZ v5.0 §16 и §16.5, `docs/PLAN.md` (раздел v0.9/v1.0 gates), `docs/release/SIGNOFF-v0.9.md` и `SIGNOFF-v1.0.md`.
> Зелёный CI **не** подтверждает эксплуатационную готовность (TZ §16.5, Definition of release: проваленный ручной тест не перекрывается покрытием unit-тестами).
> Статусы условий (PASS / FAIL / BLOCKED_EXTERNAL / NOT_TESTED) с доказательствами: [`PILOT-READINESS-MATRIX.md`](./PILOT-READINESS-MATRIX.md).

## A. BLOCKER для закрытого пилота (v0.9)

| # | Условие | Сейчас | Кто закрывает | Доказательство |
|---|---|---|---|---|
| A1 | ADR-058: четыре ручных сценария MFA | ОТКРЫТО | PO | `docs/parity/ADR-058-MANUAL-CHECKLIST.md` |
| A2 | ADR-061: проверки в браузере (restore, фильтр удалённых, блокеры удаления, gate для movements) | ОТКРЫТО (проверены только API и e2e) | PO + QA | протокол в `docs/qa/` |
| A3 | Excel/MinIO: экспорт EXCEL реально сгенерирован в MinIO, в UI нет ACK, API отвечает 409 `1C_EXPORT_REGISTER_NOT_ACKNOWLEDGEABLE` | ОТКРЫТО в UI (MinIO не поднимался) | QA | скриншоты + jobId |
| A4 | Реальная конфигурация 1С пилота и mapping v3 | BLOCKER: v2 не подходит для большинства документов с НДС≠0 | Бухгалтер + PO | реальные образцы, решение по v3, реальный импорт |
| A5 | Подтверждение бухгалтера: HALF_UP и ставки НДС | ОТКРЫТО | Бухгалтер клиента | `docs/parity/1C-ACCOUNTANT-ACCEPTANCE.md` |
| A6 | Offline device matrix на устройствах пилота (TZ §16.2: 20 офлайн-заказов, обрыв связи, перезапуск, конфликт) | ОТКРЫТО | Field Ops + QA | `docs/OFFLINE-DEVICE-MATRIX.md` |
| A7 | Ежедневный backup и restore drill на стенде пилота | Drill проведён только локально (2026-10-19, dev-данные); `backup.sh` не запускался (нет gpg) | Ops | новый `docs/ops/restore-drill-<date>.md` |
| A8 | Коды для подключения MFA у существующих привилегированных пользователей (OWNER/SALES_DIRECTOR/CASHIER) | ОТКРЫТО | Ops + OWNER | `issue-mfa-enrollment-code.ts`, журнал выдачи |
| A9 | Permission backfill: dry-run → проверка → план отката → отдельное разрешение → реальный запуск → API (без этого DIRECTOR/WAREHOUSE получают 403 на movements, MFA reset) | ОТКРЫТО | PO разрешает, Ops выполняет | вывод dry-run и запуска |
| A10 | Production Node.js и secrets: Node ≥22.12 <27 (рекомендуется 22 LTS), PM2 запускает именно этот node; secrets из `deploy/README.md` (Runtime requirements), включая `MFA_ENCRYPTION_KEY` | Версия на сервере **неизвестна** | Ops | `node -v`, `pm2 describe velto-api` |
| A11 | Подписи v0.9 (3): Product, Accounting, Security, у каждой дата, build SHA и артефакт | все UNSIGNED | PO, бухгалтер, Security | `docs/release/SIGNOFF-v0.9.md` |
| A12 | Идемпотентность платежей: тот же clientId с другим содержимым → 409 | см. запись в STATUS (P0 2026-11-01) | Dev | CI на актуальном SHA |
| A13 | Реальная проверка Telegram Bot API (owner alerts, вход через initData) | ОТКРЫТО | QA | лог/скриншот |

## B. BLOCKER только для v1.0 GA

| # | Условие | Сейчас |
|---|---|---|
| B1 | Нагрузочные показатели F7 (TZ §12.1/§12.5) на стабильном стенде, похожем на production; dashboard hit p95 <300 ms | Локально не достигнуто (warm hit p95 710 ms); причина 12-секундного окна не доказана |
| B2 | RPO ≤15 мин (WAL/PITR) и RTO ≤4 ч, измеренные на данных production-объёма | только план (`docs/ops/wal-pitr-plan.md`) |
| B3 | Полная матрица подписей §16.5 (8 строк: Legal, Business, Accounting с 30 документами, Inventory, Security с pentest, Offline, Operations, CS) | `docs/release/SIGNOFF-v1.0.md`, все UNSIGNED |
| B4 | Семь Moderate dependency advisories (qs, file-type, @nestjs/core ≤11.1.17, next-intl <4.9.2, uuid, minimatch): миграция на Nest 11 / next-intl 4 **или** оформленное принятие риска | открыто; для пилота достаточно записи в `docs/security/risk-acceptance.md` (0 critical, 0 high) |
| B5 | Все P0 из §16.1–16.3 подтверждены на поддерживаемом развёртывании, без моков | частично |
| B6 | Отчёт по профилю нагрузки §12.5 с несколькими тенантами (квота семафора отчётов) | не измерено |

## C. Можно отложить (не блокирует)

- LOW из STATUS: `perf-metrics.ts:41` (только при включённом флаге), счётчик Telegram replay до tx, `failMfaAttempt` GET+DEL не атомарен, вывод tab/ZWJ в alert.
- UI для оператора повторного импорта (сейчас CLI `retry-import-job.ts`; CLI не аутентифицирует оператора).
- `shm_size` у Docker Postgres (касается только локального стенда).
- Exactly-once для Telegram (by design: at-least-once).
- Иконки PWA и TTL (влияют на UX, а не на корректность).

## D. Go/No-Go: карточки условий пилота (дополнение 2026-11-02)

Этот раздел заменяет отдельный чек-лист Go/No-Go (дубликат не создаётся). Статусы здесь — копия `PILOT-READINESS-MATRIX.md` на 2026-11-02 и **не меняются** этим документом; меняет их PO/Tech Lead по доказательству. «Нет строки» — условие вне 33 строк матрицы, статус «не начато». Шаги — `PILOT-DEPLOYMENT-RUNBOOK.md`; бюджеты — `PILOT-SERVER-REQUIREMENTS.md`; секреты — `PILOT-RUNTIME-SECRETS-CHECKLIST.md`; backup — `BACKUP-RESTORE-RUNBOOK.md`; мониторинг — `MONITORING-ACCEPTANCE-CHECKLIST.md`; данные — `PILOT-DATA-INVENTORY.md`.

| ID | Условие (A#/строка матрицы) | Статус сейчас | Ответственный | Зависимости | Точные действия | Критерий PASS | Доказательство | PO нужен |
|---|---|---|---|---|---|---|---|---|
| G1 | Сервер, домен, DNS, SSH-доступ; размещение ПДн (нет строки; 28) | не начато | PO + юрист | выбор провайдера по локализации (Закон о ПДн, аудит §9) | купить VPS 4/8/120 NVMe; A-запись; SSH-ключ Ops | `sshd -T`: пароль и root-вход `no`; вход по ключу | вывод runbook шагов 1–3 | да |
| G2 | Node ≥22.12 <27, PM2 именно им (A10; 23) | BLOCKED_EXTERNAL | Ops | G1 | runbook шаг 4, 11 | `node -v`, `pm2 describe velto-api`: fork, 1 instance, node 22.x | вывод в `docs/ops/pilot-server-evidence-<date>.md` | нет |
| G3 | PostgreSQL: роли, RLS, закрытый порт (нет строки; часть 24) | не начато | Ops | G1, секреты 9a | шаги 5, 10 | `velto_app` NOBYPASSRLS, `velto_system` BYPASSRLS, 0 таблиц без RLS FORCE, 5432 только 127.0.0.1 | SQL-вывод `deploy/README.md:156-170` | нет |
| G4 | Redis: пароль, AOF, noeviction, localhost (нет строки; часть 24) | не начато | Ops | G1 | шаг 6 | `appendonly yes`, `noeviction`, NOAUTH без пароля, 6379 только 127.0.0.1 | вывод `CONFIG GET` | нет |
| G5 | S3: приватный бакет, EXCEL в бакете, ACK 409 (A3; 15, 16) | BLOCKED_EXTERNAL | Ops + QA + PO | G1, решение D-1 | шаг 7, шаг 14 | анонимно list/exports 403, `products/*` 200, EXCEL GENERATED, SHA-256 совпадает, ACK 409 | curl-коды, jobId, скриншот UI | да (D-1, D-4) |
| G6 | nginx, HTTPS, HSTS (нет строки; GAP S8/S11 чек-листа секретов) | не начато | Ops | G1, DNS | шаг 8 | 301 на https, HSTS в ответе, `/.env` 404, сертификат валиден, `certbot renew --dry-run` | curl/openssl вывод | нет |
| G7 | Secrets на сервере (A10; 24) | NOT_TESTED | Ops | G1 | шаги 9a, 9b | 0 `REPLACE_ME`, права 600, boot без ошибки валидации, `/etc/velto/*` 600 | `stat`-вывод без значений, `pm2 logs` без `Invalid environment configuration` | да (D-6: офлайн-копии) |
| G8 | Запуск на синтетике и `/health/ready` (нет строки; часть 23) | не начато | Ops | G2–G7 | шаги 11, 12 | 3 процесса online, ready 200 с db/redis/storage up, Redis стоп → 503 | вывод curl, `pm2 status` | нет |
| G9 | Auth, MFA, изоляция A/B на сервере (A1; 1, 2, 5, 9) | 1 и 9 PASS (локально); 2 и 5 NOT_TESTED | Ops + QA | G8 | шаг 13 | токен A→запись B 404; 403 + аудит; вход OWNER с TOTP | протокол `docs/qa/` | да (ручные M1, M4) |
| G10 | Telegram: MFA M2, M3, вход Mini App, owner alerts (A1, A13; 3, 4, 26) | BLOCKED_EXTERNAL | PO + QA | G8, бот и устройство | `PILOT-MANUAL-ACCEPTANCE.md` §1 M2–M3, §4; `setWebhook` с `secret_token` | 403 `MFA_WEB_LOGIN_REQUIRED`; реальный вход по initData; alert доставлен | скриншот/лог | да |
| G11 | Очереди на сервере (нет строки) | не начато | Ops + QA | G8 | шаг 14 | задания в финальном статусе, ключи только с `BULLMQ_PREFIX`, AOF включён | вывод scan/INFO, jobId | нет |
| G12 | Permission backfill (A9; 25) | NOT_TESTED | PO разрешает, Ops выполняет | G3, G8 | runbook «Бэкфилы» п.1–3 | dry-run проверен PO; после запуска повторный dry-run = 0; DIRECTOR/WAREHOUSE без 403 на movements | вывод dry-run и запуска | да (отдельное разрешение) |
| G13 | Коды подключения MFA OWNER/SALES_DIRECTOR/CASHIER (A8; 6) | NOT_TESTED | Ops + OWNER | G12 | «Бэкфилы» п.4 | у каждого привилегированного пользователя выдан код, журнал выдачи | журнал без кодов | да |
| G14 | Backup, offsite, restore drill на стенде (A7; 20 PASS локально, 21) | 21 NOT_TESTED | Ops | G3, G1, D-3, решение offsite | шаг 16 | `.gpg` + `.sha256 -c` OK; offsite ключом только на запись; drill в отдельную БД PASS; алерт на искусственный сбой получен | `docs/ops/restore-drill-<date>.md` | да (offsite-аккаунт, D-3) |
| G15 | Мониторинг и реальный алерт (нет строки; аудит «MISSING») | не начато | Ops | G6, G8 | шаг 15 | `--test-alert` и боевой алерт подтверждены человеком; внешний uptime-проб на `/health/ready` | скриншоты, чек-лист мониторинга | да (получатель алертов) |
| G16 | Данные и право: инвентарь, реестр вендоров, DPA, уведомление, incident response, срок хранения файлов (28) | NOT_TESTED | PO + юрист | G1 | заполнить `PILOT-DATA-INVENTORY.md`, `FILE-RETENTION-MATRIX.md`; юр. заключение по хостингу и Sentry/SMS/Telegram | подписанное заключение юриста | документ + дата | да |
| G17 | ADR-058: четыре ручных сценария MFA (A1; 2–5) | 2, 5 NOT_TESTED; 3, 4 BLOCKED_EXTERNAL | PO | G9, G10 | `docs/parity/ADR-058-MANUAL-CHECKLIST.md` | результат M1–M4 заполнен | скриншоты | да |
| G18 | ADR-061 в браузере (A2; 7) | NOT_TESTED | PO + QA | G8 | `PILOT-MANUAL-ACCEPTANCE.md` §2 | restore, фильтр удалённых, блокеры, gate movements пройдены | протокол `docs/qa/` | да |
| G19 | 1С: конфигурация, mapping v3, HALF_UP/НДС (A4, A5; 18, 19) | BLOCKED_EXTERNAL | Бухгалтер + PO | образцы клиента | `ACCOUNTANT-PILOT-PACK.md`, `1C-ACCOUNTANT-ACCEPTANCE.md` | подпись бухгалтера, реальный импорт | подписанный акт | да |
| G20 | Offline на устройствах пилота (A6; 17) | BLOCKED_EXTERNAL | Field Ops + QA | G10, устройства Android/iPhone | `docs/OFFLINE-DEVICE-MATRIX.md`, §5–6 ручной приёмки | 20 офлайн-заказов, обрыв, перезапуск, конфликт | матрица заполнена | да |
| G21 | CI зелёный на SHA деплоя, идемпотентность платежей (A12; 10, 11) | PASS (CI 41446748626 на `9dfc0dc`; после него только docs-коммит `e1e98e5`; CI обязан быть зелёным на точном SHA, утверждённом к деплою) | Dev | — | перед деплоем: CI на утверждённом `<SHA>` | success: test, Semgrep, gitleaks | run ID | нет |
| G22 | SMS-провайдер или отключение сброса по SMS (нет строки; D-5) | открыто | PO | — | решить: подключить Eskiz (токен) или принять ручное восстановление | решение записано | запись в STATUS | да |
| G23 | Подписи v0.9 (A11; 30) | BLOCKED_EXTERNAL | PO, бухгалтер, Security | G1–G22 | `SIGNOFF-v0.9.md` | 3 подписи с датой, SHA, артефактом | файл | да |

Нагрузка F7 (строка 29) и RPO 15 мин (строка 22) — только GA (B1, B2); для пилота замеры ресурсов (`PILOT-SERVER-REQUIREMENTS.md` §3) снимаются на шаге 12 как справочные.

**Блокеры ДО РЕАЛЬНЫХ ДАННЫХ** (не блокируют стенд на синтетических данных, но реальные данные клиента загружать нельзя, пока не закрыты): (1) D-3 вариант A — `deploy.sh` не должен требовать `BACKUP_PASSPHRASE_FILE`, читаемый пользователем PM2 (`velto`); (2) F-5 — отдельная read-only роль `velto_backup` вместо `velto_system` для backup; (3) отчёты restore drill на реальных данных пишутся в `DRILL_REPORT_DIR` вне репозитория. Код для D-3/F-5 этим документом не меняется.

**Решение Go принимает PO** только при PASS всех карточек G1–G23; любой FAIL или NOT_TESTED среди них = No-Go. Скорость отката: ссылки на откат — в соответствующих шагах runbook; «откат за 5 минут» допустим только после drill на стенде.
