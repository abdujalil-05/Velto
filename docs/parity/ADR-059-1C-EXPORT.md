# ADR-059 этап C — аудит экспорта 1С (2026-11-01)

Статус: **release blocker до sign-off бухгалтера.** Код экспорта, `mappingVersion 2` и ранее созданные файлы не менялись. Реальный импорт в 1С не выполнялся.

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

## Безопасный способ пометки (предложение, не реализовано)
Перед выгрузкой — проверка каждой строки: `discount ≠ 0` или `vatRate ≠ 0` или упаковка ≠ базовая или `round(qty × unitPrice) ≠ lineTotal` → предупреждение `UNSUPPORTED_COMBINATION` (invoice, sku, причина) в `ExportJob.errorLog.warnings` (тот же механизм, что `missingExternalCode`), видимое в UI. Строгий режим (FAILED) — решение PO. Исправление формата — только новым `mappingVersion 3` после sign-off.

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
