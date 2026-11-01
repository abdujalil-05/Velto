# ADR-059 — аудит финансовых расчётов и HALF_UP (2026-10-31)

Решение PO: построчный HALF_UP сохраняется, бухгалтерская семантика не меняется, исторические документы не пересчитываются.

## Фактическая стратегия (backend — источник истины)
- Промежуточные вычисления: `Prisma.Decimal` (precision 20, HALF_UP); float в бизнес-расчётах API нет (исключения только для представления: XLSX `toNumber()`).
- Строка: `qty × qtyInBaseUnit × price × (1 − d/100) × (1 + v/100)`; скидка до НДС; НДС только сверху (exclusive), режима inclusive нет.
- Округление: один раз на строку до 2 знаков (`numeric(18,2)` при записи = HALF_UP для положительных; частичная доставка — `roundLineTotal`, `line-total.ts`; аналитика — SQL `ROUND(...,2)`). Итог = Σ округлённых строк, повторного округления нет.
- Частичная доставка: пересчёт по `deliveredQty`, одно округление; при полной доставке — снимок строки.
- Отрицательные значения: stock ADJUST/reversal — Decimal со знаком; reversal платежа — через статус, отрицательная сумма не пишется.
- БД: деньги 18,2, количество 18,3, % 5,2. API JSON: деньги — строка ровно 2 знака (`"367500.00"`, B2, 2026-11-01); qty/%/коэффициенты — `Decimal.toString()`. 1С — собственный формат (см. `ADR-059-1C-EXPORT.md`).

## Находки
| Модуль | Текущая формула | Требование ТЗ | Факт | Ожидание | Риск | Статус |
|---|---|---|---|---|---|---|
| PRICE_CHANGED details (`sales.service.ts:343`) | Σ неокруглённых строк → toFixed(2) | §6.6 одно правило | 10.04×2, НДС 12% → 22.49 | 22.48 (= сохранённый заказ) | только информационное поле | **ИСПРАВЛЕНО** (Σ округлённых строк; триггер — сравнение цены, не менялся) |
| Web payment-form (`payment-form.tsx`) | float-сумма распределений | — | 0.1+0.2 > 0.3 → ложный отказ | разрешено | UX-блокировка | **ИСПРАВЛЕНО** (BigInt, `src/lib/decimal-math.ts`) |
| Web/Mini App preview (`order-line-editor.tsx`, `offline/pricing.ts`) | float, без построчного округления | backend = истина | 3×333.335 → 1 000,00 | 1 000,01 | расхождение 1 тийин в preview | **ИСПРАВЛЕНО** (BigInt HALF_UP, Σ округлённых строк) |
| Упаковка × дробное qty (`sales.service.ts:334-336`) | lineTotal от неокруглённого baseQty, qty хранится 18,3 | §6.6 | 0.125×1.5=0.1875 → хранится 0.188, lineTotal 210.00 | 210.56 по хранимому qty, либо отказ | рассогласование qty/суммы/склада | **ИСПРАВЛЕНО 2026-11-01** (ADR-059a: отказ `ORDER_QTY_PRECISION`, если qty или qty×коэффициент > 3 знаков; `order-line-guards.ts`; create/confirm/sync; коэффициенты не ограничены) |
| DTO денег/количества (`numeric-bounds.ts:34,44`) | JS number, без ограничения знаков | §16 | 100.005 молча → 100.01; qty 1.0005 принимается | отказ 400? | скрытое округление на входе | **ИСПРАВЛЕНО** (scale по сырому значению: деньги/цена/% = 2, qty/коэффициент = 3; отказ, без округления; потеря точности JSON number → 400 `JSON_NUMBER_PRECISION_LOSS`, MAX_MONEY 1e15 сохранён — см. «Точность входа JSON») |
| Mini App repeatLastOrder (`order/new/page.tsx:182`) | base qty / qtyInBaseUnit | — | 10/3 → 3.3333333333333335 отправляется | 3 знака / исходная упаковка | связано с предыдущей | **ИСПРАВЛЕНО** (`divideExact`/`repeatLineQty`: точное деление или базовая единица; старые записи очереди → подсказка, не удаляются) |
| API JSON формат | `Decimal.toJSON` | §16: `"1500000.00"`, `"2.500"` | `"1500000"` | дополнение нулями | изменение контракта | **ИСПРАВЛЕНО 2026-11-01** (B2, решение PO; `e40f980`, см. «B2» ниже) |
| НДС по умолчанию (`products.service.ts:127`, `products-parser.ts:56`) | хардкод 12, `Company.defaultVatRate` не используется | §6.6 без хардкода | 12 | из настроек компании | новые товары | **ИСПРАВЛЕНО** (ADR-059c: новый товар/импорт без ставки → `Company.defaultVatRate`; явные 0/12 сохраняются; snapshot в заказе как раньше; существующие товары/документы не менялись) |
| minPrice (`schema.prisma:431`) | проверки нет, скидка до 100% | комментарий схемы / M03 | продажа ниже minPrice | отказ? | защита цены | **ИСПРАВЛЕНО** (ADR-059b: `ORDER_PRICE_BELOW_MIN`; цена базовой единицы без НДС после скидки vs minPrice; create, confirm, assignCourier, sync; без обхода по ролям) |
| Web CSV (`export-csv.ts` вызовы) | деньги то `"1 234,00"`, то `"1234.00"` | UX-006 | разные типы в Excel | единый формат | представление | **ИСПРАВЛЕНО** (`csvDecimal`: точка, без разделителя тысяч; UI — locale-aware; защита от formula injection) |
| Mini App оплата `step="1"` | ввод тийинов заблокирован | — | — | — | UX | **ИСПРАВЛЕНО** (текстовый ввод строкой, ≤2 знака, без float) |
| 1С экспорт (`export-1c.processor.ts:193-253`, mappingVersion 2) | qty, unitPrice, lineTotal; без скидки, суммы НДС, единицы; UZS хардкод | §7.6, §16 | 2×100, скидка 10%, НДС 12% → 1С видит 200, lineTotal 201.60 | по конфигурации 1С | приёмка | **RELEASE BLOCKER** (mapping не менялся; `ADR-059-1C-EXPORT.md`, golden 5/5) |
| FIFO/аванс/reversal, баланс, aging, opening, отчёты SQL=JS, CSV/XLSX отчётов | Decimal | §6.7 | совпадает | — | — | **PASS** (golden-тесты) |

## Тесты (новые)
- `apps/api/src/modules/sales/money-rounding.golden.test.ts` — 40 граничных случаев, эталоны вручную (проверены Python `decimal`).
- `apps/api/src/modules/sales/money-flow.golden.test.ts` — 7: два заказа по 5 строк → confirm → частичная доставка → invoice → 2 платежа FIFO + аванс → reversal → aging, SQL/JS отчёты, CSV/XLSX, 1С CSV/XML против БД и API JSON.
- `apps/api/src/modules/sales/packaging-rounding.divergence.test.ts` — 2 (характеристика + `it.fails`).
- `sales.service.test.ts` — PRICE_CHANGED serverTotal = итог созданного заказа.
- `apps/miniapp/src/lib/offline/pricing.test.ts`, `apps/miniapp/src/lib/format.test.ts` — preview и форматирование (не зависят от локали).
- Web тестового набора не имеет: `decimal-math.ts` покрыт только reviewer.

## B2 — деньги в JSON ровно 2 знака (СДЕЛАНО, 2026-11-01, `e40f980`)
Решение PO: денежные поля ответа API — строка Decimal ровно с 2 знаками (`"1500000.00"`, ТЗ §16). Реализация: глобальный `MoneyResponseInterceptor` (`apps/api/src/common/serialization/money-json.ts`, регистрация в `app.module.ts`).
- Только по allowlist ключей `MONEY_RESPONSE_KEYS`: `cachedBalance, balance, advance, minPrice, price, unitPrice, unitCost, lineTotal, total, totalAmount, amount, paid, outstanding, openAmount, closeAmount, totalCollected, debtTotal, creditTotal, expectedBalance, actualBalance, diffBalance, turnover, totalDebt, overdueDebt, collected, current, d1to7, d8to30, d31to60, d60plus`. Все 19 полей схемы с такими именами — `Decimal(18,2)`. `current` форматируется только если это настоящий Decimal (не строка). `avgCheck` исключён (результат деления, > 2 знаков).
- Формат 2 знака применяется, только если у значения ≤ 2 знаков; значение никогда не округляется (> 2 знаков → как есть).
- `RAW_JSON_KEYS` (`oldValue, newValue, payload, errorLog, responseBody, entityKey, details, title, message`) — проходят без изменений.
- Не затрагиваются: qty (18,3), %, коэффициенты, ответы-ошибки, `StreamableFile` (1С/CSV/XLSX), BigInt, Date. БД не менялась.
- Idempotent replay ранее сохранённого тела тоже нормализуется (interceptor глобальный). Web и Mini App изменений не требуют (сравнение `expectedUnitPrice` на сервере через `Decimal.equals`).
- Тесты: `money-json.test.ts`; e2e order-flow / payment-allocate-rbac / payment-handover — обновлён только ожидаемый формат (`'56000'` → `'56000.00'`).

## Точность входа JSON (СДЕЛАНО, 2026-11-01, `b48dff5`)
Точка потери: body-parser `JSON.parse` → double до валидации DTO (подтверждено: `99999999999999.99` превращался в `99999999999999.98` и проходил валидацию).
- `apps/api/src/common/serialization/json-number-guard.ts`: reviver с `context.source`; если `Decimal(source) ≠ Decimal(String(value))` → 400 `JSON_NUMBER_PRECISION_LOSS`. Подключён в `bootstrap.ts` (`configureApp`); API не стартует на Node < 21 (нет `context.source`).
- Временный clamp 1e13 убран, `MAX_MONEY` 1e15 сохранён.
- Принимаются точно: `0.01`, `100.01`, `9007199254740.99`, `9999999999999.98`, `9999999999999.99`, `12345678901234.5`. Отклоняются: `100.005` (scale), `99999999999999.99` (precision). Любое |v| < 1e13 с 2 знаками всегда точно.
- Тест: `apps/api/test/json-number-precision.e2e.test.ts`.

## План совместимости (НЕ РЕАЛИЗОВАН, нужно решение PO)
Значения 1e13..1e15, не представимые точно в double (кроме `.00/.25/.50/.75`), сейчас отклоняются. Точный приём — аддитивно `number | string` для полей `@IsMoneyAmount`: finance create-payment `amount`; open/close cash session `openAmount`/`closeAmount`; purchases goods-receipt `unitCost` и purchase-order `unitPrice`; catalog product `price`/`minPrice`; price-list items `price`; те же поля в payload `/sync/push`. Без глобальной версии API.

## Открыто
- Бухгалтер: подтверждение HALF_UP на реальных документах и импорт в конкретную конфигурацию 1С (XML без пилотного контракта не считается проверенным).
- Решения PO по пунктам «→ PO» выше и по плану совместимости string-money. Исторические суммы не пересчитывались.
