'use client';

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { useLocale, useTranslations } from 'next-intl';
import { formatDate, formatMoney } from '@/lib/format';

interface TurnoverChartProps {
  data: { date: string; turnover: string }[];
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: { value: number | string }[];
  label?: string;
  locale: string;
  unit: string;
}

function ChartTooltip({ active, payload, label, locale, unit }: ChartTooltipProps) {
  if (!active || !payload?.length || !label) return null;
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-sm shadow-md">
      <p className="text-xs text-muted-foreground">{formatDate(label, locale)}</p>
      <p className="font-medium">
        {formatMoney(payload[0]!.value)} {unit}
      </p>
    </div>
  );
}

interface AxisTickProps {
  x?: number | string;
  y?: number | string;
  payload?: { value: string };
  index?: number;
}

export function TurnoverChart({ data }: TurnoverChartProps) {
  const locale = useLocale();
  const t = useTranslations('Common');

  // Single series → no legend needed (marks-and-anatomy.md); a sparse tick
  // set keeps 30 daily points from crowding the x-axis.
  const tickIndices = new Set([0, Math.floor(data.length / 2), data.length - 1]);

  function renderTick({ x, y, payload, index }: AxisTickProps) {
    if (index === undefined || !tickIndices.has(index) || !payload) return <g />;
    const yNum = typeof y === 'string' ? Number(y) : (y ?? 0);
    // Edge ticks anchor away from the chart edge instead of centering, so
    // the label never clips off the left/right side of the container.
    const textAnchor = index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle';
    return (
      <text x={x} y={yNum + 12} textAnchor={textAnchor} className="fill-muted-foreground text-xs">
        {formatDate(payload.value, locale)}
      </text>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="turnoverFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.18} />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
        <XAxis dataKey="date" axisLine={false} tickLine={false} tickMargin={8} interval={0} tick={renderTick} />
        <Tooltip
          cursor={{ stroke: 'hsl(var(--border))' }}
          content={({ active, payload, label }) => (
            <ChartTooltip
              active={active}
              payload={payload as unknown as { value: number | string }[] | undefined}
              label={label as string | undefined}
              locale={locale}
              unit={t('somUnit')}
            />
          )}
        />
        <Area
          type="monotone"
          dataKey="turnover"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          fill="url(#turnoverFill)"
          dot={false}
          activeDot={{ r: 4, fill: 'hsl(var(--primary))', stroke: 'hsl(var(--card))', strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
