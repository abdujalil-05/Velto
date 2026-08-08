import ExcelJS from 'exceljs';
import type { AgentPerformanceReportService } from './agent-performance.service';

type AgentPerformanceReport = Awaited<ReturnType<AgentPerformanceReportService['getAgentPerformance']>>;

/** M11/9.2 "/reports/agents ... Excel eksport" — one row per agent, same columns as the JSON endpoint. */
export async function buildAgentPerformanceExcel(report: AgentPerformanceReport): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Agentlar');
  sheet.columns = [
    { header: 'Agent', key: 'agentName', width: 28 },
    { header: 'Rejalashtirilgan tashriflar', key: 'plannedVisits', width: 20 },
    { header: 'Bajarilgan tashriflar', key: 'completedVisits', width: 20 },
    { header: 'Marshrut bajarilishi %', key: 'routeCompletionPct', width: 20 },
    { header: 'Samarali tashrif %', key: 'effectiveVisitPct', width: 20 },
    { header: 'Buyurtmalar soni', key: 'orderCount', width: 16 },
    { header: 'Aylanma', key: 'turnover', width: 18 },
    { header: "O'rtacha chek", key: 'avgCheck', width: 16 },
  ];
  sheet.getRow(1).font = { bold: true };

  sheet.addRows(
    report.agents.map((a) => ({
      agentName: a.agentName,
      plannedVisits: a.plannedVisits,
      completedVisits: a.completedVisits,
      routeCompletionPct: a.routeCompletionPct,
      effectiveVisitPct: a.effectiveVisitPct,
      orderCount: a.orderCount,
      turnover: a.turnover.toNumber(),
      avgCheck: a.avgCheck.toNumber(),
    })),
  );

  const numberFormat = '#,##0.00';
  for (const key of ['turnover', 'avgCheck'] as const) {
    sheet.getColumn(key).numFmt = numberFormat;
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
