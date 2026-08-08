import ExcelJS from 'exceljs';
import type { SalesReportService } from './sales-report.service';

type SalesReport = Awaited<ReturnType<SalesReportService['getSalesReport']>>;

const NUMBER_FORMAT = '#,##0.00';

/** M11/9.2 "/reports/sales ... Excel eksport" — one sheet per breakdown (day/agent/product), mirroring the JSON endpoint's shape. */
export async function buildSalesReportExcel(report: SalesReport): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const daySheet = workbook.addWorksheet('Kunlar');
  daySheet.columns = [
    { header: 'Sana', key: 'date', width: 14 },
    { header: 'Aylanma', key: 'turnover', width: 18 },
  ];
  daySheet.addRows(report.byDay.map((d) => ({ date: d.date, turnover: d.turnover.toNumber() })));
  daySheet.getColumn('turnover').numFmt = NUMBER_FORMAT;

  const agentSheet = workbook.addWorksheet('Agentlar');
  agentSheet.columns = [
    { header: 'Agent', key: 'agentName', width: 28 },
    { header: 'Buyurtmalar soni', key: 'orderCount', width: 18 },
    { header: 'Aylanma', key: 'turnover', width: 18 },
  ];
  agentSheet.addRows(report.byAgent.map((a) => ({ agentName: a.agentName, orderCount: a.orderCount, turnover: a.turnover.toNumber() })));
  agentSheet.getColumn('turnover').numFmt = NUMBER_FORMAT;

  const productSheet = workbook.addWorksheet('Mahsulotlar');
  productSheet.columns = [
    { header: 'Mahsulot', key: 'productName', width: 32 },
    { header: 'Aylanma', key: 'turnover', width: 18 },
  ];
  productSheet.addRows(report.topProducts.map((p) => ({ productName: p.productName, turnover: p.turnover.toNumber() })));
  productSheet.getColumn('turnover').numFmt = NUMBER_FORMAT;

  const summarySheet = workbook.addWorksheet('Jami');
  summarySheet.columns = [
    { header: 'Ko’rsatkich', key: 'label', width: 24 },
    { header: 'Qiymat', key: 'value', width: 18 },
  ];
  summarySheet.addRows([
    { label: 'Aylanma', value: report.summary.turnover.toNumber() },
    { label: 'Buyurtmalar soni', value: report.summary.orderCount },
    { label: "O'rtacha chek", value: report.summary.avgCheck.toNumber() },
  ]);
  summarySheet.getColumn('value').numFmt = NUMBER_FORMAT;

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
