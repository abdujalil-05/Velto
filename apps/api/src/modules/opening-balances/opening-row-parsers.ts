import type ExcelJS from 'exceljs';
import { Prisma } from '@velto/database';
import { MAX_MONEY, MAX_QUANTITY } from '../../common/validators/numeric-bounds';
import type { RowError, RowMessage } from '../import/import.constants';
import { asString, isBlankCell, type WorkbookRow } from '../import/parsers/read-workbook';
import type { OpeningCustomerRow, OpeningStockRow } from './opening-balances.constants';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAIN_DECIMAL_RE = /^\d+(\.\d+)?$/;

const m = (uz: string, ru: string, en: string): RowMessage => ({ uz, ru, en });

/**
 * Exact decimal from a cell: numbers via their shortest round-trip string,
 * text only as plain `123.45` (spaces stripped). A comma is rejected rather
 * than guessed (thousands vs decimal separator). `undefined` = blank cell;
 * `null` = present but not a positive value within `scale` decimals / below `max`.
 */
export function parsePositiveDecimal(value: ExcelJS.CellValue, scale: number, max: number): Prisma.Decimal | null | undefined {
  if (isBlankCell(value)) return undefined;
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    text = String(value);
  } else {
    const s = asString(value);
    if (s === undefined) return undefined;
    text = s.replace(/\s/g, ''); // \s includes NBSP (thousands separator in RU/UZ Excel)
    if (!PLAIN_DECIMAL_RE.test(text)) return null;
  }
  let d: Prisma.Decimal;
  try {
    d = new Prisma.Decimal(text);
  } catch {
    return null;
  }
  if (!d.isFinite() || d.lte(0) || d.decimalPlaces() > scale || d.gte(max)) return null;
  return d;
}

/** `YYYY-MM-DD` from a date cell (exceljs dates are UTC) or text `YYYY-MM-DD` / `DD.MM.YYYY`. */
export function parseDateCell(value: ExcelJS.CellValue): string | null | undefined {
  if (isBlankCell(value)) return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const s = asString(value);
  if (s === undefined) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  const [y, mo, d] = iso ? [+iso[1]!, +iso[2]!, +iso[3]!] : dotted ? [+dotted[3]!, +dotted[2]!, +dotted[1]!] : [NaN, NaN, NaN];
  if (!Number.isInteger(y)) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

function toRowErrors(byRow: Map<number, RowMessage[]>): RowError[] {
  return [...byRow.entries()]
    .sort(([a], [b]) => a - b)
    .map(([row, msgs]) => ({ row, messages: msgs.map((x) => x.uz), i18n: msgs }));
}

function addMessage(byRow: Map<number, RowMessage[]>, row: number, msg: RowMessage) {
  const list = byRow.get(row) ?? [];
  if (!list.some((x) => x.uz === msg.uz)) list.push(msg);
  byRow.set(row, list);
}

// ---------------------------------------------------------------------------
// Customers: customerCode | customerId, debt | credit, docRef, docDate
// ---------------------------------------------------------------------------

export interface RawCustomerCells {
  rowNumber: number;
  customerCode?: string;
  customerId?: string;
  debt: ExcelJS.CellValue;
  credit: ExcelJS.CellValue;
  docRef?: string;
  docDate: ExcelJS.CellValue;
}

export function readCustomerCells(rows: WorkbookRow[]): RawCustomerCells[] {
  return rows.map((r) => ({
    rowNumber: r.rowNumber,
    customerCode: asString(r.get('customerCode')),
    customerId: asString(r.get('customerId')),
    debt: r.get('debt'),
    credit: r.get('credit'),
    docRef: asString(r.get('docRef')),
    docDate: r.get('docDate'),
  }));
}

export interface CustomerLookup {
  /** live customers: code -> id, and id -> code */
  idByCode: Map<string, string>;
  codeById: Map<string, string>;
  /** customers that already have any invoice/payment outside a VOIDED opening batch (ADR-026 create-only) */
  withLedger: Set<string>;
  /** company-timezone today, YYYY-MM-DD */
  today: string;
}

export function validateCustomerRows(raw: RawCustomerCells[], lookup: CustomerLookup): { validRows: OpeningCustomerRow[]; errors: RowError[] } {
  const byRow = new Map<number, RowMessage[]>();
  const candidates: OpeningCustomerRow[] = [];

  for (const r of raw) {
    const err = (msg: RowMessage) => addMessage(byRow, r.rowNumber, msg);

    let customerId: string | undefined;
    if (!r.customerCode && !r.customerId) {
      err(m('customerCode majburiy', 'customerCode: обязательное поле', 'customerCode is required'));
    } else if (r.customerId && !UUID_RE.test(r.customerId)) {
      err(m("customerId UUID formatida bo'lishi kerak", 'customerId должен быть UUID', 'customerId must be a UUID'));
    } else {
      const byId = r.customerId ? (lookup.codeById.has(r.customerId.toLowerCase()) ? r.customerId.toLowerCase() : undefined) : undefined;
      const byCode = r.customerCode ? lookup.idByCode.get(r.customerCode) : undefined;
      if (r.customerId && r.customerCode && byId !== byCode) {
        err(m('customerId va customerCode bir mijozga mos emas', 'customerId и customerCode указывают на разных клиентов', 'customerId and customerCode do not match the same customer'));
      } else {
        customerId = byId ?? byCode;
        if (!customerId) {
          err(m(`mijoz "${r.customerCode ?? r.customerId}" topilmadi`, `клиент "${r.customerCode ?? r.customerId}" не найден`, `customer "${r.customerCode ?? r.customerId}" not found`));
        } else if (lookup.withLedger.has(customerId)) {
          err(
            m(
              `mijoz "${lookup.codeById.get(customerId)}" da allaqachon ichki hisob yoki to'lov bor (boshlang'ich qoldiq faqat yangi mijozga)`,
              `у клиента "${lookup.codeById.get(customerId)}" уже есть внутренние счета или оплаты (начальный остаток — только для клиента без проводок)`,
              `customer "${lookup.codeById.get(customerId)}" already has internal invoices or payments (opening balance is create-only)`,
            ),
          );
        }
      }
    }

    const debt = parsePositiveDecimal(r.debt, 2, MAX_MONEY);
    const credit = parsePositiveDecimal(r.credit, 2, MAX_MONEY);
    const moneyMsg = (col: string) =>
      m(`${col} musbat son bo'lishi kerak (ko'pi bilan 2 kasr, nuqta bilan)`, `${col}: положительное число (не более 2 знаков, через точку)`, `${col} must be a positive number (max 2 decimals, dot separator)`);
    if (debt === null) err(moneyMsg('debt'));
    if (credit === null) err(moneyMsg('credit'));
    if (debt === undefined && credit === undefined) err(m('debt yoki credit majburiy', 'нужно указать debt или credit', 'debt or credit is required'));
    if (debt && credit) err(m("bitta qatorda debt va credit birga bo'lmaydi", 'debt и credit не могут быть в одной строке', 'debt and credit cannot both be set on one row'));

    if (r.docRef && r.docRef.length > 100) err(m('docRef 100 belgidan oshmasligi kerak', 'docRef: не более 100 символов', 'docRef must not exceed 100 characters'));
    const docDate = parseDateCell(r.docDate);
    if (docDate === null) err(m("docDate sana bo'lishi kerak (YYYY-MM-DD yoki DD.MM.YYYY)", 'docDate: дата (YYYY-MM-DD или DD.MM.YYYY)', 'docDate must be a date (YYYY-MM-DD or DD.MM.YYYY)'));
    else if (docDate && docDate > lookup.today) err(m("docDate kelajakda bo'lishi mumkin emas", 'docDate не может быть в будущем', 'docDate cannot be in the future'));

    if (debt && !r.docRef) err(m('debt qatori uchun docRef majburiy (1C hujjat raqami)', 'для строки debt обязателен docRef (номер документа 1С)', 'docRef (1C document number) is required for a debt row'));
    if (credit && (r.docRef || docDate)) {
      err(m("credit (avans) qatorida docRef/docDate bo'lmaydi", 'в строке credit (аванс) не указываются docRef/docDate', 'a credit (advance) row has no docRef/docDate'));
    }

    if (customerId && (debt || credit) && !(debt && credit)) {
      candidates.push({
        rowNumber: r.rowNumber,
        customerId,
        customerCode: lookup.codeById.get(customerId)!,
        side: debt ? 'DEBT' : 'CREDIT',
        amount: (debt ?? credit)!.toFixed(2),
        docRef: r.docRef ?? null,
        docDate: docDate ?? null,
      });
    }
  }

  // Cross-row rules (only rows whose customer resolved).
  const byCustomer = new Map<string, OpeningCustomerRow[]>();
  for (const c of candidates) byCustomer.set(c.customerId, [...(byCustomer.get(c.customerId) ?? []), c]);
  for (const list of byCustomer.values()) {
    const code = list[0]!.customerCode;
    const debts = list.filter((x) => x.side === 'DEBT');
    const credits = list.filter((x) => x.side === 'CREDIT');
    if (debts.length > 0 && credits.length > 0) {
      for (const x of list) {
        addMessage(byRow, x.rowNumber, m(`mijoz "${code}" uchun qarz va avans aralash — bittasini qoldiring`, `у клиента "${code}" одновременно долг и аванс — оставьте одно`, `customer "${code}" has both debt and advance rows — keep one side`));
      }
    }
    if (credits.length > 1) {
      for (const x of credits) {
        addMessage(byRow, x.rowNumber, m(`mijoz "${code}" avansi faylda takrorlangan (bitta qator bo'lishi kerak)`, `аванс клиента "${code}" повторяется в файле (должна быть одна строка)`, `customer "${code}" advance is duplicated in the file (one row expected)`));
      }
    }
    const seenRefs = new Map<string, OpeningCustomerRow[]>();
    for (const x of debts) seenRefs.set(x.docRef!, [...(seenRefs.get(x.docRef!) ?? []), x]);
    for (const [ref, dup] of seenRefs) {
      if (dup.length < 2) continue;
      for (const x of dup) {
        addMessage(byRow, x.rowNumber, m(`docRef "${ref}" mijoz "${code}" uchun faylda takrorlangan`, `docRef "${ref}" клиента "${code}" повторяется в файле`, `docRef "${ref}" of customer "${code}" is duplicated in the file`));
      }
    }
  }

  return { validRows: candidates.filter((c) => !byRow.has(c.rowNumber)), errors: toRowErrors(byRow) };
}

// ---------------------------------------------------------------------------
// Stock: sku, warehouseId | warehouseName, qty
// ---------------------------------------------------------------------------

export interface RawStockCells {
  rowNumber: number;
  sku?: string;
  warehouseId?: string;
  warehouseName?: string;
  qty: ExcelJS.CellValue;
}

export function readStockCells(rows: WorkbookRow[]): RawStockCells[] {
  return rows.map((r) => ({
    rowNumber: r.rowNumber,
    sku: asString(r.get('sku')),
    warehouseId: asString(r.get('warehouseId')),
    warehouseName: asString(r.get('warehouseName')),
    qty: r.get('qty'),
  }));
}

export interface StockLookup {
  /** live products: sku -> id */
  productIdBySku: Map<string, string>;
  /** active warehouses: id -> name, and name -> ids (names are not unique) */
  warehouseNameById: Map<string, string>;
  warehouseIdsByName: Map<string, string[]>;
  /** `${productId}:${warehouseId}` pairs that already have any movement outside a VOIDED opening batch (ADR-026) */
  pairsWithMovements: Set<string>;
}

export const pairKey = (productId: string, warehouseId: string) => `${productId}:${warehouseId}`;

export function validateStockRows(raw: RawStockCells[], lookup: StockLookup): { validRows: OpeningStockRow[]; errors: RowError[] } {
  const byRow = new Map<number, RowMessage[]>();
  const candidates: OpeningStockRow[] = [];

  for (const r of raw) {
    const err = (msg: RowMessage) => addMessage(byRow, r.rowNumber, msg);

    let productId: string | undefined;
    if (!r.sku) err(m('sku majburiy', 'sku: обязательное поле', 'sku is required'));
    else {
      productId = lookup.productIdBySku.get(r.sku);
      if (!productId) err(m(`mahsulot "${r.sku}" topilmadi`, `товар "${r.sku}" не найден`, `product "${r.sku}" not found`));
    }

    let warehouseId: string | undefined;
    if (!r.warehouseId && !r.warehouseName) {
      err(m('warehouseName yoki warehouseId majburiy', 'нужно указать warehouseName или warehouseId', 'warehouseName or warehouseId is required'));
    } else if (r.warehouseId) {
      const id = r.warehouseId.toLowerCase();
      if (!UUID_RE.test(id) || !lookup.warehouseNameById.has(id)) err(m(`ombor "${r.warehouseId}" topilmadi`, `склад "${r.warehouseId}" не найден`, `warehouse "${r.warehouseId}" not found`));
      else if (r.warehouseName && lookup.warehouseNameById.get(id) !== r.warehouseName) {
        err(m('warehouseId va warehouseName bir omborga mos emas', 'warehouseId и warehouseName указывают на разные склады', 'warehouseId and warehouseName do not match the same warehouse'));
      } else warehouseId = id;
    } else {
      const ids = lookup.warehouseIdsByName.get(r.warehouseName!) ?? [];
      if (ids.length === 0) err(m(`ombor "${r.warehouseName}" topilmadi`, `склад "${r.warehouseName}" не найден`, `warehouse "${r.warehouseName}" not found`));
      else if (ids.length > 1) {
        err(m(`"${r.warehouseName}" nomli ombor bir nechta — warehouseId ishlating`, `складов с именем "${r.warehouseName}" несколько — укажите warehouseId`, `several warehouses are named "${r.warehouseName}" — use warehouseId`));
      } else warehouseId = ids[0];
    }

    const qty = parsePositiveDecimal(r.qty, 3, MAX_QUANTITY);
    if (qty === undefined) err(m('qty majburiy', 'qty: обязательное поле', 'qty is required'));
    else if (qty === null) err(m("qty musbat son bo'lishi kerak (ko'pi bilan 3 kasr, nuqta bilan)", 'qty: положительное число (не более 3 знаков, через точку)', 'qty must be a positive number (max 3 decimals, dot separator)'));

    if (productId && warehouseId && lookup.pairsWithMovements.has(pairKey(productId, warehouseId))) {
      err(
        m(
          `"${r.sku}" / "${lookup.warehouseNameById.get(warehouseId)}" juftligida allaqachon ombor harakati bor (boshlang'ich qoldiq faqat yangi juftlikka)`,
          `по паре "${r.sku}" / "${lookup.warehouseNameById.get(warehouseId)}" уже есть движения (начальный остаток — только для пары без движений)`,
          `pair "${r.sku}" / "${lookup.warehouseNameById.get(warehouseId)}" already has stock movements (opening stock is create-only)`,
        ),
      );
    }

    if (productId && warehouseId && qty) {
      candidates.push({ rowNumber: r.rowNumber, productId, sku: r.sku!, warehouseId, warehouseName: lookup.warehouseNameById.get(warehouseId)!, qty: qty.toFixed(3) });
    }
  }

  const byPair = new Map<string, OpeningStockRow[]>();
  for (const c of candidates) byPair.set(pairKey(c.productId, c.warehouseId), [...(byPair.get(pairKey(c.productId, c.warehouseId)) ?? []), c]);
  for (const dup of byPair.values()) {
    if (dup.length < 2) continue;
    for (const x of dup) {
      addMessage(byRow, x.rowNumber, m(`"${x.sku}" / "${x.warehouseName}" juftligi faylda takrorlangan`, `пара "${x.sku}" / "${x.warehouseName}" повторяется в файле`, `pair "${x.sku}" / "${x.warehouseName}" is duplicated in the file`));
    }
  }

  return { validRows: candidates.filter((c) => !byRow.has(c.rowNumber)), errors: toRowErrors(byRow) };
}
