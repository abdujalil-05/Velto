import ExcelJS from 'exceljs';
import type { CommerceMlCustomer } from './commerce-ml';

export interface SalesDocumentRow {
  number: string;
  date: Date;
  customerName: string;
  total: string;
}

export interface PaymentDocumentRow {
  number: string;
  date: Date;
  customerName: string;
  amount: string;
  method: string;
}

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
  customersSheet.addRows(params.customers.map((c) => ({ code: c.code, name: c.name, phone: c.phone ?? '' })));

  const salesSheet = workbook.addWorksheet('Sotish hujjatlari');
  salesSheet.columns = [
    { header: 'Raqam', key: 'number', width: 18 },
    { header: 'Sana', key: 'date', width: 14 },
    { header: 'Mijoz', key: 'customer', width: 32 },
    { header: 'Summa', key: 'total', width: 16 },
  ];
  salesSheet.addRows(params.salesDocuments.map((d) => ({ number: d.number, date: formatDate(d.date), customer: d.customerName, total: d.total })));

  const paymentsSheet = workbook.addWorksheet("To'lovlar");
  paymentsSheet.columns = [
    { header: 'Raqam', key: 'number', width: 18 },
    { header: 'Sana', key: 'date', width: 14 },
    { header: 'Mijoz', key: 'customer', width: 32 },
    { header: 'Summa', key: 'amount', width: 16 },
    { header: 'Usul', key: 'method', width: 12 },
  ];
  paymentsSheet.addRows(
    params.payments.map((p) => ({ number: p.number, date: formatDate(p.date), customer: p.customerName, amount: p.amount, method: p.method })),
  );

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
