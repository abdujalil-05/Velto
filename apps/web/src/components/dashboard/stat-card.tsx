import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { formatPercentChange } from '@/lib/format';

interface StatCardProps {
  label: string;
  value: string;
  unit?: string;
  changePct: number | null;
  /** UX-002: for "overdue debt", a rise is bad (destructive), not good — invert the usual up=green mapping. */
  invertTrend?: boolean;
}

export function StatCard({ label, value, unit, changePct, invertTrend }: StatCardProps) {
  const t = useTranslations('Dashboard');
  const isUp = changePct !== null && changePct > 0;
  const isDown = changePct !== null && changePct < 0;
  const good = invertTrend ? isDown : isUp;
  const bad = invertTrend ? isUp : isDown;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-semibold">{value}</span>
          {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
        </div>
        <div
          className={cn(
            'mt-1 flex items-center gap-1 text-xs font-medium',
            good && 'text-success',
            bad && 'text-destructive',
            !good && !bad && 'text-muted-foreground',
          )}
        >
          {isUp && <ArrowUp className="h-3 w-3" />}
          {isDown && <ArrowDown className="h-3 w-3" />}
          {!isUp && !isDown && <Minus className="h-3 w-3" />}
          <span>{formatPercentChange(changePct)}</span>
          <span className="text-muted-foreground">{t('vsYesterday')}</span>
        </div>
      </CardContent>
    </Card>
  );
}
