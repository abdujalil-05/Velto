# ADR-059 этап C — аудит экспорта 1С (2026-11-01)

Статус: **release blocker до sign-off бухгалтера.** С 2026-11-01 (`0390808`, web `f5b26bd`) — строгий отказ для непредставимых документов (см. ниже); `mappingVersion 2`, формат корректных файлов и ранее созданные файлы не менялись. Реальный импорт в 1С не выполнялся.

## Текущий mapping (источник — Invoice + InvoiceLine, не SalesOrder)
| Формат | Шапка | Строка | Нет |
|---|---|---|---|
| XML (`export-1c.processor.ts` ~148–199) | Ид/Номер/Дата = Invoice.id/number/createdAt; Сумма = Invoice.total; Валюта = `UZS` (хардкод) | Товар Ид = externalCode ?? sku; ЦенаЗаЕдиницу = InvoiceLine.unitPrice; Количество = InvoiceLine.qty; Сумма = InvoiceLine.lineTotal | скидка, ставка/сумма НДС, нетто, единица |
| CSV (~207–222) | docType, Ид, number, date (TZ компании), partnerCode/Name, total = Invoice.total | sku/externalCode, qty, unitPrice, lineTotal | валюта, скидка, НДС, единица |
| Excel (`export-1c-excel.ts`) | Номер, Дата, Клиент, Сумма = Invoice.total, Ид | **строк нет** | всё построчное |

Факты: `InvoiceLine` не хранит `discountPct` (он есть только в `SalesOrderLine`); qty — в базовой единице (deliveredQty), unitPrice — цена базовой единицы без НДС; lineTotal — с НДС после скидки (HALF_UP 2dp). Σ lineTotal = Invoice.total — всегда совпадает.

## Что текущий формат не может представить корректно (подтверждено тестом)
Тест: `apps/api/src/modules/integrations/export-1c/export-1c.consistency.golden.test.ts` (5/5, характеризация).
1. Скидка/НДС: 2 × 100, скидка 10%, НДС 12% → файл `2 / 100 / 201.60`; читатель считает 200.
2. Дробное qty: 7.125 × 333.33 → файл 2659.97, qty × цена = 2374.98.
3. Упаковка: 2 коробки × 12 → файл 24 / 100, кода единицы нет, «2 коробки» не восстановимо.
4. Валюта: только XML (хардкод UZS); в CSV/Excel нет.
5. Документ: Σ(qty × цена) = 57 975.13 при сумме документа 58 827.23.
Корректно только для строк без скидки и с НДС 0%.

## Политика строгого отказа (СДЕЛАНО, 2026-11-01, решение PO)
- XML/CSV: если в периоде есть хотя бы один непредставимый документ → job `FAILED` (`UnrecoverableError`, без retry), файл не создаётся, статус не `GENERATED`. Охват — вся задача (период = один файл; исключение документов дало бы неполный файл) → пользователь сужает период.
- `errorLog`: `code = 1C_EXPORT_UNSUPPORTED_COMBINATION`, сообщения uz/ru/en, `total`, `violations[]` (invoiceId, number, sku, reasons) ≤ 100, только своей компании.
- Причины (`export-1c-representability.ts`): `DISCOUNT`, `VAT` (≠ 0), `QTY_X_PRICE_MISMATCH`, `UNIT` (qtyInBaseUnit ≠ 1), `TOTAL_MISMATCH`.
- Счета без заказа (orderless): проверяются только арифметика и НДС (скидки/упаковки в InvoiceLine нет). OPENING-счета исключены фильтром kind = SALE и ложно не отклоняются.
- Корректные документы выгружаются как прежде: `mappingVersion 2`, external IDs, checksum, audit, RBAC, idempotency, GENERATED vs ACCOUNTING_ACCEPTED без изменений.
- **EXCEL** — информационный реестр (fallback ТЗ 11.1), не импорт в 1С: не отклоняется, лист «Eslatma» это указывает, суммы = `Invoice.total` (Decimal). ACK для EXCEL → 409 `1C_EXPORT_REGISTER_NOT_ACKNOWLEDGEABLE`. Формата по умолчанию нет (решение PO 2026-11-01): `format` обязателен, иначе 400 `1C_EXPORT_FORMAT_REQUIRED`; в web формат не выбран заранее, кнопка неактивна до выбора. **mapping v2 непригоден для большинства документов с ненулевым НДС — release blocker бухгалтерской интеграции** (mapping v3 только после образцов и согласования бухгалтера, см. `1C-ACCOUNTANT-ACCEPTANCE.md`).
- Web (`export-1c/page.tsx`): таблица нарушений, метка «реестр» для EXCEL, кнопка ACK скрыта для EXCEL; i18n uz/ru/en.
- Read-only диагностика исторических выгрузок: `packages/database/src/diagnostics/export-1c-unsupported.ts [--company]`.
- Тесты: `export-1c.unsupported.test.ts`, `export-1c.consistency.golden.test.ts`, e2e `export-1c-ack-download`/`export-1c-hardening`, `packages/database/src/__tests__/export-1c-unsupported.test.ts`.
- **Следствие:** любой документ с НДС ≠ 0 (большинство реальных счетов) отклоняется mapping v2 → выгрузка XML/CSV фактически заблокирована до утверждения v3. Браузерный smoke страницы export-1c не выполнялся.

## Проект mapping v3 (DRAFT, требует реальной конфигурации 1С)
| Поле | Источник |
|---|---|
| baseQty | InvoiceLine.qty |
| unitCode | Product.baseUnit → код ОКЕИ (новый справочник mapping) |
| priceExVat | InvoiceLine.unitPrice |
| discountPct / discountAmount | SalesOrderLine (в InvoiceLine не хранится → возможно, нужна snapshot-колонка, db-rls, аддитивно) |
| netAmount | qty × price − скидка |
| vatRate / vatAmount | snapshot строки; vatAmount = net × rate (правило округления — вопрос бухгалтеру) |
| grossAmount | InvoiceLine.lineTotal |
| currency | из Company, не хардкод |
| исходная упаковка (qty, название) | справочно |

## Вопросы бухгалтеру
1. Цена в 1С — с НДС или без?
2. Скидка: % на строке, сумма или уже в цене?
3. Сумма НДС — отдельное поле или 1С считает сама; округление по строке или по документу?
4. Единица: базовая или упаковка; коды ОКЕИ?
5. Валюта/курс — только UZS?
6. Вид документа (Реализация) и ХозОперация?
7. Ключ сопоставления контрагента/номенклатуры: externalCode, ИНН?
8. Что делает 1С при расхождении строки и документа (отказ/пересчёт)?
9. Конфигурация и версия пилота (БП 3.0, УТ …)?
10. Подтверждение HALF_UP по строке на реальных документах.
