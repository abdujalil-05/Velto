import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface SimpleStatProps {
  label: string;
  value: string;
  unit?: string;
}

export function SimpleStat({ label, value, unit }: SimpleStatProps) {
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
      </CardContent>
    </Card>
  );
}
