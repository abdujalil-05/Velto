'use client';

import { Download } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

interface ExportCsvButtonProps {
  onExport: () => void;
  disabled?: boolean;
}

/** 9.1 ("har ro'yxatda ... Excel eksport — bir xil joyda") — placed next to search/filter on every list screen. */
export function ExportCsvButton({ onExport, disabled }: ExportCsvButtonProps) {
  const t = useTranslations('Common');
  return (
    <Button variant="outline" size="sm" onClick={onExport} disabled={disabled}>
      <Download className="mr-2 h-4 w-4" />
      {t('export')}
    </Button>
  );
}
