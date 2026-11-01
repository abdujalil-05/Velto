# Условия релиза: закрытый пилот (v0.9) и v1.0 GA

> Состояние на 2026-11-01, ветка `feat/approved-decisions`. Источники: `docs/STATUS.md`, TZ v5.0 §16 и §16.5, `docs/PLAN.md` (раздел v0.9/v1.0 gates), `docs/release/SIGNOFF-v0.9.md` и `SIGNOFF-v1.0.md`.
> Зелёный CI **не** подтверждает эксплуатационную готовность (TZ §16.5, Definition of release: проваленный ручной тест не перекрывается покрытием unit-тестами).

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
