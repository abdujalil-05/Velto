'use client';

import dynamic from 'next/dynamic';

interface TurnoverChartProps {
  data: { date: string; turnover: string }[];
}

/**
 * recharts is ~95kB gzipped and was statically imported here, so it landed in
 * the First Load JS of the dashboard (`/[locale]`) and `/reports` — the
 * dashboard being the first screen every user hits after login. The chart is
 * below the KPI tiles and is never interactive on first paint, so it is loaded
 * on demand instead. `ssr: false` because recharts renders off measured DOM
 * width (ResponsiveContainer) and contributes nothing useful to the HTML.
 *
 * The placeholder reserves the exact 220px the chart occupies, so deferring it
 * costs no layout shift.
 */
const TurnoverChartImpl = dynamic(() => import('./turnover-chart-impl'), {
  ssr: false,
  loading: () => <div className="h-[220px] w-full animate-pulse rounded-md bg-muted/40" />,
});

export function TurnoverChart({ data }: TurnoverChartProps) {
  return <TurnoverChartImpl data={data} />;
}
