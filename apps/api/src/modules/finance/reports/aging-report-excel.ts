import ExcelJS from 'exceljs';
import type { AgingRow } from './aging-report.service';

const COLUMNS = [
  { header: 'Mijoz', key: 'customer', width: 32 },
  { header: 'Muddati kelmagan', key: 'current', width: 18 },
  { header: '1-30 kun', key: 'd1to30', width: 14 },
  { header: '31-60 kun', key: 'd31to60', width: 14 },
  { header: '61-90 kun', key: 'd61to90', width: 14 },
  { header: '90+ kun', key: 'd90plus', width: 14 },
  { header: 'Jami', key: 'total', width: 18 },
] as const;

/** 9.2 "/receivables ... eksport": one row per indebted customer, 5 aging buckets + total. */
export async function buildAgingReportExcel(rows: AgingRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Qarzdorlik');
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  sheet.getRow(1).font = { bold: true };

  for (const row of rows) {
    sheet.addRow({
      customer: row.customerName,
      current: row.buckets.current.toNumber(),
      d1to30: row.buckets.d1to30.toNumber(),
      d31to60: row.buckets.d31to60.toNumber(),
      d61to90: row.buckets.d61to90.toNumber(),
      d90plus: row.buckets.d90plus.toNumber(),
      total: row.total.toNumber(),
    });
  }

  const numberFormat = '#,##0.00';
  for (const key of ['current', 'd1to30', 'd31to60', 'd61to90', 'd90plus', 'total'] as const) {
    sheet.getColumn(key).numFmt = numberFormat;
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
