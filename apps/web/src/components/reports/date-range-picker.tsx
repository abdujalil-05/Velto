'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface DateRangePickerProps {
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
}

export function DateRangePicker({ from, to, onFromChange, onToChange }: DateRangePickerProps) {
  const t = useTranslations('Reports');

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <Label htmlFor="reportFrom" className="text-xs">
          {t('from')}
        </Label>
        <Input id="reportFrom" type="date" value={from} onChange={(e) => onFromChange(e.target.value)} className="w-auto" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="reportTo" className="text-xs">
          {t('to')}
        </Label>
        <Input id="reportTo" type="date" value={to} onChange={(e) => onToChange(e.target.value)} className="w-auto" />
      </div>
    </div>
  );
}
