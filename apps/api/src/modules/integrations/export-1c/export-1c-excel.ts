import ExcelJS from 'exceljs';
import { sanitizeCell } from '../../../common/export/spreadsheet-safety';
import type { CommerceMlCustomer } from './commerce-ml';
import { EXPORT_1C_ID_COLUMN } from './export-1c.constants';

export interface SalesDocumentRow {
  /** Velto Invoice UUID (ADR-024). */
  id: string;
  number: string;
  date: Date;
  customerName: string;
  total: string;
}

export interface PaymentDocumentRow {
  /** Velto Payment UUID (ADR-024). */
  id: string;
  number: string;
  date: Date;
  customerName: string;
  amount: string;
  method: string;
}

export const EXPORT_1C_REGISTER_NOTICE = "AXBOROT REYESTRI — 1C ga buxgalteriya importi uchun fayl EMAS. Faqat hujjat jami summalari (Invoice.total); qatorlar, QQS, chegirma, birlik yo'q.";
export const EXPORT_1C_REGISTER_NOTICE_RU = 'ИНФОРМАЦИОННЫЙ РЕЕСТР — не файл для бухгалтерского импорта в 1С. Только итоги документов; без строк, НДС, скидок и единиц.';

const safe = (v: string): string => String(sanitizeCell(v));

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 11.1: "Excel muqobili" — the same three record types as the CommerceML file (kontragentlar, sotish hujjatlari, to'lovlar), one sheet each. */
export async function buildExport1cWorkbook(params: {
  customers: CommerceMlCustomer[];
  salesDocuments: SalesDocumentRow[];
  payments: PaymentDocumentRow[];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const customersSheet = workbook.addWorksheet('Kontragentlar');
  customersSheet.columns = [
    { header: 'Kod', key: 'code', width: 16 },
    { header: 'Nomi', key: 'name', width: 32 },
    { header: 'Telefon', key: 'phone', width: 18 },
  ];
  customersSheet.addRows(params.customers.map((c) => ({ code: safe(c.code), name: safe(c.name), phone: safe(c.phone ?? '') })));

  const salesSheet = workbook.addWorksheet('Sotish hujjatlari');
  salesSheet.columns = [
    { header: 'Raqam', key: 'number', width: 18 },
    { header: 'Sana', key: 'date', width: 14 },
    { header: 'Mijoz', key: 'customer', width: 32 },
    { header: 'Summa', key: 'total', width: 16 },
    { header: EXPORT_1C_ID_COLUMN, key: 'id', width: 38 },
  ];
  salesSheet.addRows(params.salesDocuments.map((d) => ({ number: safe(d.number), date: formatDate(d.date), customer: safe(d.customerName), total: d.total, id: d.id })));

  const paymentsSheet = workbook.addWorksheet("To'lovlar");
  paymentsSheet.columns = [
    { header: 'Raqam', key: 'number', width: 18 },
    { header: 'Sana', key: 'date', width: 14 },
    { header: 'Mijoz', key: 'customer', width: 32 },
    { header: 'Summa', key: 'amount', width: 16 },
    { header: 'Usul', key: 'method', width: 12 },
    { header: EXPORT_1C_ID_COLUMN, key: 'id', width: 38 },
  ];
  paymentsSheet.addRows(
    params.payments.map((p) => ({ number: safe(p.number), date: formatDate(p.date), customer: safe(p.customerName), amount: p.amount, method: safe(p.method), id: p.id })),
  );

  // ADR-059: this workbook is an informational register (header totals = Invoice.total, no lines/VAT/discount), NOT an accounting import file.
  const noticeSheet = workbook.addWorksheet('Eslatma');
  noticeSheet.columns = [{ header: EXPORT_1C_REGISTER_NOTICE, key: 'text', width: 110 }];
  noticeSheet.addRow({ text: EXPORT_1C_REGISTER_NOTICE_RU });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
