import { useTranslations } from 'next-intl';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import type { PurchaseOrderStatus } from '@/lib/api/purchase-orders';

const VARIANT_BY_STATUS: Record<PurchaseOrderStatus, BadgeProps['variant']> = {
  DRAFT: 'outline',
  ORDERED: 'warning',
  PARTIALLY_RECEIVED: 'secondary',
  RECEIVED: 'success',
  CANCELLED: 'destructive',
};

export function PurchaseOrderStatusBadge({ status }: { status: PurchaseOrderStatus }) {
  const t = useTranslations('PurchaseOrderStatus');
  return <Badge variant={VARIANT_BY_STATUS[status]}>{t(status)}</Badge>;
}
