import ExcelJS from 'exceljs';
import type { OverviewReportService } from './overview-report.service';

type OverviewReport = Awaited<ReturnType<OverviewReportService['getOverview']>>;

/** M11/9.2 "/reports/overview ... Excel eksport" — single-row summary sheet, same fields as the JSON endpoint. */
export async function buildOverviewReportExcel(report: OverviewReport): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Umumiy');
  sheet.columns = [
    { header: 'Ko’rsatkich', key: 'label', width: 28 },
    { header: 'Qiymat', key: 'value', width: 20 },
  ];
  sheet.getRow(1).font = { bold: true };

  sheet.addRows([
    { label: 'Aylanma', value: report.turnover.toNumber() },
    { label: 'Buyurtmalar soni', value: report.orderCount },
    { label: "O'rtacha chek", value: report.avgCheck.toNumber() },
    { label: 'Faol mijozlar', value: report.activeCustomers },
    { label: 'Yangi mijozlar', value: report.newCustomers },
    { label: 'Jami mijozlar', value: report.totalCustomers },
    { label: 'Jami qarzdorlik', value: report.totalDebt.toNumber() },
    { label: "Muddati o'tgan qarz", value: report.overdueDebt.toNumber() },
    { label: "Muddati o'tgan qarz %", value: report.overdueDebtPct },
  ]);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
