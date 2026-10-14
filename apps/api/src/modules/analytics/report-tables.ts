import { COUNTED_ORDER_STATUSES } from './report-utils';
import { formatGeneratedAt, periodMeta, type ReportTable } from './report-export';
import type { AgentPerformanceReportService } from './agent-performance.service';
import type { OverviewReportService } from './overview-report.service';
import type { SalesReportService } from './sales-report.service';

type SalesReport = Awaited<ReturnType<SalesReportService['getSalesReport']>>;
type AgentPerformanceReport = Awaited<ReturnType<AgentPerformanceReportService['getAgentPerformance']>>;
type OverviewReport = Awaited<ReturnType<OverviewReportService['getOverview']>>;

const AMOUNT_NOTE = "Summa: DELIVERED/CLOSED buyurtmalar yetkazilgan miqdor (hisob-faktura jami), qolganlari buyurtma miqdori bo'yicha.";

function baseMeta(report: { range: { from: Date; to: Date }; timeZone: string }, generatedAt: Date): [string, string][] {
  return [
    ...periodMeta(report.range, report.timeZone),
    ['Buyurtma holatlari', COUNTED_ORDER_STATUSES.join(', ')],
    ['Yaratilgan vaqt', formatGeneratedAt(generatedAt, report.timeZone)],
  ];
}

/** M11/9.2 "/reports/sales ... eksport" — one section per breakdown, the exact data of GET /reports/sales. */
export function salesReportTable(report: SalesReport, generatedAt: Date): ReportTable {
  return {
    title: 'Sotuv hisoboti',
    meta: baseMeta(report, generatedAt),
    notes: [AMOUNT_NOTE, "O'rtacha chek = Aylanma / Buyurtmalar soni"],
    sections: [
      {
        name: 'Kunlar',
        columns: [{ header: 'Sana', width: 14 }, { header: 'Aylanma', money: true, width: 18 }],
        rows: report.byDay.map((d) => [d.date, d.turnover]),
      },
      {
        name: 'Agentlar',
        columns: [{ header: 'Agent', width: 28 }, { header: 'Buyurtmalar soni', width: 18 }, { header: 'Aylanma', money: true, width: 18 }],
        rows: report.byAgent.map((a) => [a.agentName, a.orderCount, a.turnover]),
      },
      {
        name: 'Mahsulotlar',
        columns: [{ header: 'Mahsulot', width: 32 }, { header: 'Aylanma', money: true, width: 18 }],
        rows: report.topProducts.map((p) => [p.productName, p.turnover]),
      },
      {
        name: 'Jami',
        columns: [{ header: 'Ko’rsatkich', width: 24 }, { header: 'Qiymat', money: true, width: 18 }],
        rows: [
          ['Aylanma', report.summary.turnover],
          ['Buyurtmalar soni', report.summary.orderCount],
          ["O'rtacha chek", report.summary.avgCheck],
        ],
      },
    ],
  };
}

/** M11/9.2 "/reports/agents ... eksport" — one row per agent, the exact data of GET /reports/agents. */
export function agentPerformanceTable(report: AgentPerformanceReport, generatedAt: Date): ReportTable {
  return {
    title: 'Agentlar hisoboti',
    meta: baseMeta(report, generatedAt),
    notes: [
      AMOUNT_NOTE,
      'Marshrut bajarilishi % = Bajarilgan tashriflar / Rejalashtirilgan tashriflar × 100',
      'Samarali tashrif % = Buyurtma bilan tugagan tashriflar / Bajarilgan tashriflar × 100',
      "O'rtacha chek = Aylanma / Buyurtmalar soni",
    ],
    sections: [
      {
        name: 'Agentlar',
        columns: [
          { header: 'Agent', width: 28 },
          { header: 'Rejalashtirilgan tashriflar', width: 20 },
          { header: 'Bajarilgan tashriflar', width: 20 },
          { header: 'Marshrut bajarilishi %', width: 20 },
          { header: 'Samarali tashrif %', width: 20 },
          { header: 'Buyurtmalar soni', width: 16 },
          { header: 'Aylanma', money: true, width: 18 },
          { header: "O'rtacha chek", money: true, width: 16 },
        ],
        rows: report.agents.map((a) => [
          a.agentName, a.plannedVisits, a.completedVisits, a.routeCompletionPct, a.effectiveVisitPct, a.orderCount, a.turnover, a.avgCheck,
        ]),
      },
    ],
  };
}

/** M11/9.2 "/reports/overview ... eksport" — the exact data of GET /reports/overview. */
export function overviewReportTable(report: OverviewReport, generatedAt: Date): ReportTable {
  return {
    title: 'Umumiy hisobot',
    meta: baseMeta(report, generatedAt),
    notes: [
      AMOUNT_NOTE,
      "O'rtacha chek = Aylanma / Buyurtmalar soni",
      "Qarzdorlik joriy holat bo'yicha (davrga bog'liq emas); muddati o'tgan qarz % = Muddati o'tgan qarz / Jami qarzdorlik × 100",
    ],
    sections: [
      {
        name: 'Umumiy',
        columns: [{ header: 'Ko’rsatkich', width: 28 }, { header: 'Qiymat', money: true, width: 20 }],
        rows: [
          ['Aylanma', report.turnover],
          ['Buyurtmalar soni', report.orderCount],
          ["O'rtacha chek", report.avgCheck],
          ['Faol mijozlar', report.activeCustomers],
          ['Yangi mijozlar', report.newCustomers],
          ['Jami mijozlar', report.totalCustomers],
          ['Jami qarzdorlik', report.totalDebt],
          ["Muddati o'tgan qarz", report.overdueDebt],
          ["Muddati o'tgan qarz %", report.overdueDebtPct],
        ],
      },
    ],
  };
}
