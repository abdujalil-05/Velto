# ADR-059 — аудит финансовых расчётов и HALF_UP (2026-10-31)

Решение PO: построчный HALF_UP сохраняется, бухгалтерская семантика не меняется, исторические документы не пересчитываются.

## Фактическая стратегия (backend — источник истины)
- Промежуточные вычисления: `Prisma.Decimal` (precision 20, HALF_UP); float в бизнес-расчётах API нет (исключения только для представления: XLSX `toNumber()`).
- Строка: `qty × qtyInBaseUnit × price × (1 − d/100) × (1 + v/100)`; скидка до НДС; НДС только сверху (exclusive), режима inclusive нет.
- Округление: один раз на строку до 2 знаков (`numeric(18,2)` при записи = HALF_UP для положительных; частичная доставка — `roundLineTotal`, `line-total.ts`; аналитика — SQL `ROUND(...,2)`). Итог = Σ округлённых строк, повторного округления нет.
- Частичная доставка: пересчёт по `deliveredQty`, одно округление; при полной доставке — снимок строки.
- Отрицательные значения: stock ADJUST/reversal — Decimal со знаком; reversal платежа — через статус, отрицательная сумма не пишется.
- БД: деньги 18,2, количество 18,3, % 5,2. API JSON и 1С: `Decimal.toString()` (без дополнения нулями: `"367500"`).

## Находки
| Модуль | Текущая формула | Требование ТЗ | Факт | Ожидание | Риск | Статус |
|---|---|---|---|---|---|---|
| PRICE_CHANGED details (`sales.service.ts:343`) | Σ неокруглённых строк → toFixed(2) | §6.6 одно правило | 10.04×2, НДС 12% → 22.49 | 22.48 (= сохранённый заказ) | только информационное поле | **ИСПРАВЛЕНО** (Σ округлённых строк; триггер — сравнение цены, не менялся) |
| Web payment-form (`payment-form.tsx`) | float-сумма распределений | — | 0.1+0.2 > 0.3 → ложный отказ | разрешено | UX-блокировка | **ИСПРАВЛЕНО** (BigInt, `src/lib/decimal-math.ts`) |
| Web/Mini App preview (`order-line-editor.tsx`, `offline/pricing.ts`) | float, без построчного округления | backend = истина | 3×333.335 → 1 000,00 | 1 000,01 | расхождение 1 тийин в preview | **ИСПРАВЛЕНО** (BigInt HALF_UP, Σ округлённых строк) |
| Упаковка × дробное qty (`sales.service.ts:334-336`) | lineTotal от неокруглённого baseQty, qty хранится 18,3 | §6.6 | 0.125×1.5=0.1875 → хранится 0.188, lineTotal 210.00 | 210.56 по хранимому qty, либо отказ | рассогласование qty/суммы/склада | **CONFIRMED BUG → PO** (тест `packaging-rounding.divergence.test.ts`, `it.fails`) |
| DTO денег/количества (`numeric-bounds.ts:34,44`) | JS number, без ограничения знаков | §16 | 100.005 молча → 100.01; qty 1.0005 принимается | отказ 400? | скрытое округление на входе | **SPEC AMBIGUITY → PO** |
| Mini App repeatLastOrder (`order/new/page.tsx:182`) | base qty / qtyInBaseUnit | — | 10/3 → 3.3333333333333335 отправляется | 3 знака / исходная упаковка | связано с предыдущей | **INCONSISTENCY → PO** |
| API JSON формат | `Decimal.toJSON` | §16: `"1500000.00"`, `"2.500"` | `"1500000"` | дополнение нулями | изменение контракта | **INCONSISTENCY → PO** |
| НДС по умолчанию (`products.service.ts:127`, `products-parser.ts:56`) | хардкод 12, `Company.defaultVatRate` не используется | §6.6 без хардкода | 12 | из настроек компании | новые товары | **INCONSISTENCY → PO** |
| minPrice (`schema.prisma:431`) | проверки нет, скидка до 100% | комментарий схемы / M03 | продажа ниже minPrice | отказ? | защита цены | **SPEC AMBIGUITY → PO** |
| Web CSV (`export-csv.ts` вызовы) | деньги то `"1 234,00"`, то `"1234.00"` | UX-006 | разные типы в Excel | единый формат | представление | **INCONSISTENCY → PO** |
| Mini App оплата `step="1"` | ввод тийинов заблокирован | — | — | — | UX | **SPEC AMBIGUITY → PO** |
| 1С экспорт (`export-1c.processor.ts:193-253`, mappingVersion 2) | qty, unitPrice, lineTotal; без скидки, суммы НДС, единицы; UZS хардкод | §7.6, §16 | 2×100, скидка 10%, НДС 12% → 1С видит 200, lineTotal 201.60 | по конфигурации 1С | приёмка | **EXTERNAL VALIDATION** (mapping не менялся) |
| FIFO/аванс/reversal, баланс, aging, opening, отчёты SQL=JS, CSV/XLSX отчётов | Decimal | §6.7 | совпадает | — | — | **PASS** (golden-тесты) |

## Тесты (новые)
- `apps/api/src/modules/sales/money-rounding.golden.test.ts` — 40 граничных случаев, эталоны вручную (проверены Python `decimal`).
- `apps/api/src/modules/sales/money-flow.golden.test.ts` — 7: два заказа по 5 строк → confirm → частичная доставка → invoice → 2 платежа FIFO + аванс → reversal → aging, SQL/JS отчёты, CSV/XLSX, 1С CSV/XML против БД и API JSON.
- `apps/api/src/modules/sales/packaging-rounding.divergence.test.ts` — 2 (характеристика + `it.fails`).
- `sales.service.test.ts` — PRICE_CHANGED serverTotal = итог созданного заказа.
- `apps/miniapp/src/lib/offline/pricing.test.ts`, `apps/miniapp/src/lib/format.test.ts` — preview и форматирование (не зависят от локали).
- Web тестового набора не имеет: `decimal-math.ts` покрыт только reviewer.

## Открыто
- Бухгалтер: подтверждение HALF_UP на реальных документах и импорт в конкретную конфигурацию 1С (XML без пилотного контракта не считается проверенным).
- Решения PO по пунктам «→ PO» выше. Исторические суммы не пересчитывались.
