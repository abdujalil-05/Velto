import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import type { PurchaseOrderStatus } from '@/lib/api/purchases';

const VARIANT: Record<PurchaseOrderStatus, 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'> = {
  DRAFT: 'outline',
  ORDERED: 'secondary',
  PARTIALLY_RECEIVED: 'warning',
  RECEIVED: 'success',
  CANCELLED: 'destructive',
};

export function PoStatusBadge({ status }: { status: PurchaseOrderStatus }) {
  const t = useTranslations('Purchases.status');
  return <Badge variant={VARIANT[status]}>{t(status)}</Badge>;
}
