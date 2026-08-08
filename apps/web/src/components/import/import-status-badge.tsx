import { useTranslations } from 'next-intl';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import type { ImportStatus } from '@/lib/api/imports';

const VARIANT_BY_STATUS: Record<ImportStatus, BadgeProps['variant']> = {
  PENDING: 'warning',
  PROCESSING: 'secondary',
  DONE: 'success',
  FAILED: 'destructive',
};

export function ImportStatusBadge({ status }: { status: ImportStatus }) {
  const t = useTranslations('Import.importStatus');
  return <Badge variant={VARIANT_BY_STATUS[status]}>{t(status)}</Badge>;
}
