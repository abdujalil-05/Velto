# Monitoring: чек-лист приёмки (пилот v0.9)

Статус 2026-11-02: **NOT PASS (NOT TESTED)**. Код проверок покрыт стаб-тестами (`deploy/monitoring/tests/run-tests.sh`), на сервере ничего не запускалось; мониторинг не принят, пока ответственный человек не подтвердит получение тестового алерта. Ничего не развёрнуто, ни один алерт не доставлялся. Используются только существующие средства: `deploy/monitoring/velto-monitor.sh` (+ `.timer`, каждые 5 мин) и `deploy/backup/backup-run.sh`. Новая система не вводится.

**Критерий PASS для каждой строки:** реальный алерт, вызванный безопасным искусственным сбоем на стенде, **доставлен** на отдельный аварийный канал и подтверждён человеком + пришло RECOVERED. «Скрипт отработал», `--dry-run` или код в репозитории PASS не дают. Аварийный канал: отдельный ops-бот (НЕ бот приложения `TELEGRAM_BOT_TOKEN`) и отдельный чат (`OPS_TG_BOT_TOKEN`/`OPS_TG_CHAT_ID`, `monitor.env.example:2-3`), НЕ бизнес-чат Telegram. Подтверждение: время получения + кто получил (в протокол, без токенов/chat id).

Условные обозначения: ЕСТЬ = покрыто кодом (проверить на стенде); GAP = не покрыто.

## Матрица

| # | Что | Покрытие (файл:строка) | Порог | Как проверить на стенде (безопасно) | Статус |
|---|---|---|---|---|---|
| 1 | Внешний uptime (снаружи VPS) | Локально: `public_https` (curl публичного URL, `velto-monitor.sh`) — не заменяет внешнюю пробу. Внешняя проба: README «Added for the pilot» (интервал 1 мин, алерт после 2 неудач). Провайдер не выбран | недоступно > 5 мин | Настроить внешний uptime-сервис на `/velto/api/health/ready`; тест: `nginx` stop 6–10 мин на окне работ → алерт у ответственного | NOT TESTED |
| 2 | API `/health/live` и `/health/ready` | ЕСТЬ: `velto-monitor.sh:104-110` (только ready, PASS лишь при HTTP 200 + тело контракта `status:up,checks.db:up`); `health.controller.ts:60` (live — ничего не проверяет), `:93` (ready: PG, Redis, S3, по 2 с, 503) | любой не-200 / иное тело | `pm2 stop velto-api` на 6–10 мин (окно работ) → FAIL `health_ready: http 502/000`; `pm2 start` → RECOVERED. `/health/live` отдельно не мониториться (нет смысла, покрыт ready) | NOT TESTED |
| 3 | PostgreSQL | Косвенно через ready (`db`) `:107`; `db_connections` — только значение, **порога нет** (`:170`) | ready: 503 при отказе; соединения: GAP порог | Остановить PG на стенде 6–10 мин → `health_ready` FAIL. Порог соединений — GAP (минимально: добавить после замера нагрузки; в скрипт не добавлялось) | NOT TESTED |
| 4 | Redis | `health_redis` (тело ready) + прямая проверка `redis` (PING, read-only ACL-пользователь, README) | нет PONG / ready 503 | `systemctl stop redis` на стенде → FAIL `redis`/`health_redis`; деградация: BACKUP-RESTORE-RUNBOOK, раздел A | NOT TESTED |
| 5 | S3 | `health_storage` (HeadBucket, учётные данные) + `s3_anon_denied` (анонимный HEAD должен вернуть 401/403) | ready 503; анонимный доступ 2xx/3xx | Заблокировать порт S3 на стенде → FAIL `health_storage`; для anon-проверки временно указать публичный URL → FAIL | NOT TESTED |
| 6 | Диск и память | `disk:<path>` (WARN ≥ 80 %, CRIT ≥ 90 %), `memory` (MemAvailable < 10 %) — `velto-monitor.sh`; inode — GAP | как указано | `MONITOR_DISK_WARN_PERCENT=1` во временном `--env` → WARN/FAIL; не наполнять prod-диск | NOT TESTED |
| 7 | TLS: срок сертификата | `tls`: WARN < 21 дн, CRIT < 7 дн (`MONITOR_TLS_WARN_DAYS`/`MONITOR_TLS_CRIT_DAYS`) | < 21 / < 7 дн | Временно `MONITOR_TLS_WARN_DAYS=9999` во временном `--env` → WARN → вернуть → RECOVERED. Без `MONITOR_TLS_HOST` = SKIP | NOT TESTED |
| 8 | Backup: свежесть и offsite | `backup`/`backup_offsite` по файлу-аттестации `MONITOR_BACKUP_STATUS_FILE` (поля `ts`, `result`, `offsite_ts`, `offsite_result`; backup > 65 мин, offsite > 1560 мин — настраиваются); немедленный алерт из `backup-run.sh` | result≠ok; возраст выше порога; файл отсутствует | (а) `backup-run.sh` с неверным `BACKUP_PASSPHRASE_FILE` → алерт + RECOVERED; (б) подменить `MONITOR_BACKUP_STATUS_FILE` на копию с старым `ts` → FAIL `backup`; (в) `offsite_result=error` → FAIL `backup_offsite`. Формат файла должен совпасть с реально записываемым root-юнитом бэкапа — сверить на стенде | NOT TESTED |
| 9 | Зависшие задачи ImportJob/ExportJob/Notification | ЕСТЬ: `velto-monitor.sh:159-169`, пороги `MONITOR_JOB_STUCK_MINUTES=30`, `MONITOR_NOTIF_STUCK_MINUTES=30`, failed ≥ 5 за 60 мин; роль `monitor-role.sql` (только счётчики) | stuck > 30 мин; failed ≥ 5/ч | На тестовой БД стенда вставить/перевести тестовую запись `ImportJob` в `PROCESSING` с `updatedAt` на 40 мин назад (от имени админа БД, с тестовым tenant) → FAIL `jobs_stuck`; откатить запись → RECOVERED. На prod-данных не делать | NOT TESTED |
| 10 | BullMQ failed / backlog | `queue:<имя>`: `ZCARD <prefix>:<q>:failed` ≥ 10, `LLEN <prefix>:<q>:wait` ≥ 100 для 6 очередей `apps/api`; read-only Redis ACL, только счётчики (README) | failed ≥ 10, wait ≥ 100 | На стенде добавить заведомо падающие задания → FAIL `queue:*`; stalled/active — GAP | NOT TESTED |
| 11 | PM2: online, рестарты | `pm2` по снимку `pm2-status-export.sh` (cron от пользователя PM2, без sudo): stale > 10 мин, не `online`, рестарты +3 за прогон. Ротация логов `pm2-logrotate.sh` — не запущена | как указано | `pm2 stop velto-api` (окно работ) → FAIL `pm2`; цикл `pm2 restart` ×3 → FAIL spike | NOT TESTED |
| 12 | 5xx от API | ЕСТЬ: `velto-monitor.sh:124-128` (последние 2000 строк nginx, префикс `/velto/api/`) | ≥ 5 и ≥ 5 % | Не генерировать 5xx на prod. На стенде: временно остановить API и дёрнуть URL 6+ раз → FAIL `api_5xx` | NOT TESTED |
| 13 | Работоспособность самого канала | `--test-alert` (сообщение «TEST ALERT - NOT A REAL INCIDENT»); отдельный бот проверяется кодом: совпадение с `TELEGRAM_BOT_TOKEN`/чатом бизнеса → Telegram отключён + CRIT `alert_channel`; запасные каналы: webhook/email (`monitor.env.example`) | — | `velto-monitor --test-alert` → **ответственный человек подтверждает получение** (время, кто). Мониторинг НЕ принят, пока подтверждения нет | NOT TESTED |
| 14 | Нет ПДн/финансовых данных в алертах | Проверено по шаблонам (ниже) | — | Проверить на стенде: прочитать реально пришедшие сообщения всех пунктов выше; в протокол «ПДн не обнаружено» | см. ниже |

## Шаблоны сообщений: проверка на отсутствие ПДн (факты по коду)
- `velto-monitor.sh:60` TEST: метка хоста + время.
- `:77` `[host] ALERT(sev) <имя инцидента>: <текст>`; текст от вызывающего, ≤ 300 символов, управляющие символы вырезаны (`:69`). Единственный вызывающий — `backup-run.sh:42`: `VELTO-BACKUP-FAILED host=… step=… exit=… ts=…` — имя хоста, имя шага, код, время; вывод команд в алерт не попадает (`backup-run.sh:38,65`).
- `:92` `RECOVERED <имя>`; `:188,192` строки `имя: деталь`, где деталь — только числа/статусы: `http 200`, `age 5h`, `45%`, `import=0 export=0 notif=0`, `NNd left`, `bad/total (pct%)`, `invalid numeric env: <имена переменных>` (значения не печатаются).
- URL, телефоны, суммы, имена клиентов, токены, строки логов в шаблонах отсутствуют. Токен бота идёт на `api.telegram.org` через stdin-конфиг curl, не в argv (`:53-54`).
- Остаточный риск: ad-hoc `--alert` принимает произвольный текст от вызывающего — вызывающие обязаны передавать только структурированные поля; код-ревью каждого нового вызова. Telegram — зарубежный вендор: факт отправки (имя хоста, статус) уходит за пределы страны; решение о допустимости — специалист (см. PILOT-DATA-INVENTORY.md).
- На стенде: PASS по этому пункту только после просмотра реальных сообщений.

## Порядок приёмки (выполняет пользователь на стенде)
1. Установить по `deploy/monitoring/README.md` (шаги 1–5; пользователь `velto-monitor`, ACL, state-dir до старта).
2. `velto-monitor --dry-run` → все проверки считаются, ничего не отправляется; затем `velto-monitor --test-alert` → подтверждение человеком.
3. Пройти строки 2–9, 12 в окне работ с заранее предупреждённым получателем; для каждой записать: время сбоя, время доставки, получатель, время RECOVERED.
4. Строку 1 — после выбора внешней пробы; 10, 11 — остаются GAP до решения (см. ниже).
5. Итог по матрице обновляется владельцем матрицы только после доказанной доставки; этот чек-лист статусы матрицы не меняет.

## GAP и решения PO
- Внешний uptime (п. 1): выбор провайдера и допустимость (проба видит только публичный URL).
- Второй аварийный канал (email/SMS) на случай недоступности Telegram (п. 13).
- BullMQ failed/stalled (п. 10) и пороги `db_connections` (п. 3): требуют метрик из приложения/замера нагрузки; не реализовано.
- PM2 рестарты (п. 11): выдать монитору ограниченный доступ или ручная проверка.
- Error tracking: `@sentry/node` подключён в коде (`apps/api/src/main.ts:5,25-28`), включается только при непустом `SENTRY_DSN`; DSN пуст и включать нельзя без решения по ПДн/размещению (README.md «Sentry»).
