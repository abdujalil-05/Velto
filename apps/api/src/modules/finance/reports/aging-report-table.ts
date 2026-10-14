import { formatGeneratedAt, type ReportTable } from '../../analytics/report-export';
import type { AgingRow } from './aging-report.service';

/** TZ §6.5 aging as an export model (XLSX + CSV): one row per indebted customer, buckets + total, same asOf/rows as GET /reports/aging. */
export function agingReportTable(
  data: { rows: AgingRow[]; asOf: string; timeZone: string },
  generatedAt: Date,
): ReportTable {
  return {
    title: 'Qarzdorlik (aging)',
    meta: [
      [`Hisobot sanasi (asOf, ${data.timeZone})`, data.asOf],
      ['Yaratilgan vaqt', formatGeneratedAt(generatedAt, data.timeZone)],
    ],
    notes: [
      "Muddat = hisob-faktura sanasi (kompaniya vaqt zonasi) + mijoz to'lov muddati (kun); muddati kelmagan = 0 va undan kam kun kechikish",
      "Qoldiq = hisob-faktura jami - asOf sanagacha qo'llangan to'lovlar",
    ],
    sections: [
      {
        name: 'Qarzdorlik',
        columns: [
          { header: 'Mijoz', width: 32 },
          { header: 'Muddati kelmagan', money: true, width: 18 },
          { header: '1-7 kun', money: true, width: 14 },
          { header: '8-30 kun', money: true, width: 14 },
          { header: '31-60 kun', money: true, width: 14 },
          { header: '60+ kun', money: true, width: 14 },
          { header: 'Jami', money: true, width: 18 },
        ],
        rows: data.rows.map((r) => [
          r.customerName, r.buckets.current, r.buckets.d1to7, r.buckets.d8to30, r.buckets.d31to60, r.buckets.d60plus, r.total,
        ]),
      },
    ],
  };
}
