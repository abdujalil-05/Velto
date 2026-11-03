'use client';

import { useTranslations } from 'next-intl';
import { Download } from 'lucide-react';
import type { OpeningKind } from '@/lib/api/opening-balances';
import { downloadCsvTemplate } from '@/lib/download-csv-template';
import { Button } from '@/components/ui/button';

// Must match the columns read by apps/api opening-row-parsers.ts (no server template endpoint exists).
const TEMPLATES: Record<OpeningKind, { file: string; columns: readonly string[] }> = {
  CUSTOMER_BALANCE: { file: 'opening-customers-template.csv', columns: ['customerCode', 'debt', 'credit', 'docRef', 'docDate'] },
  STOCK: { file: 'opening-stock-template.csv', columns: ['sku', 'warehouseName', 'qty'] },
};

export function OpeningTemplateDownload({ kind }: { kind: OpeningKind }) {
  const t = useTranslations('OpeningBalances');
  const { file, columns } = TEMPLATES[kind];
  return (
    <Button type="button" variant="outline" className="min-h-12" onClick={() => downloadCsvTemplate(file, columns)}>
      <Download className="mr-2 h-4 w-4" aria-hidden="true" />
      {t('downloadTemplate')}
    </Button>
  );
}
