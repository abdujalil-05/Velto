import ExcelJS from 'exceljs';
import { AGING_TIME_ZONE, type AgingRow } from './aging-report.service';

const COLUMNS = [
  { header: 'Mijoz', key: 'customer', width: 32 },
  { header: 'Muddati kelmagan', key: 'current', width: 18 },
  { header: '1-7 kun', key: 'd1to7', width: 14 },
  { header: '8-30 kun', key: 'd8to30', width: 14 },
  { header: '31-60 kun', key: 'd31to60', width: 14 },
  { header: '60+ kun', key: 'd60plus', width: 14 },
  { header: 'Jami', key: 'total', width: 18 },
] as const;

/** Row 1 = report date, row 2 = headers, data from row 3. */
export const AGING_EXCEL_HEADER_ROW = 2;

/** 9.2 "/receivables ... eksport": one row per indebted customer, TZ §6.5 buckets + total, same asOf as the screen. */
export async function buildAgingReportExcel(rows: AgingRow[], asOf: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Qarzdorlik');
  sheet.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));
  sheet.addRow([`Hisobot sanasi (${AGING_TIME_ZONE})`, asOf]).font = { bold: true };
  sheet.addRow(COLUMNS.map((c) => c.header)).font = { bold: true };

  for (const row of rows) {
    sheet.addRow({
      customer: row.customerName,
      current: row.buckets.current.toNumber(),
      d1to7: row.buckets.d1to7.toNumber(),
      d8to30: row.buckets.d8to30.toNumber(),
      d31to60: row.buckets.d31to60.toNumber(),
      d60plus: row.buckets.d60plus.toNumber(),
      total: row.total.toNumber(),
    });
  }

  const numberFormat = '#,##0.00';
  for (const key of ['current', 'd1to7', 'd8to30', 'd31to60', 'd60plus', 'total'] as const) {
    sheet.getColumn(key).numFmt = numberFormat;
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
