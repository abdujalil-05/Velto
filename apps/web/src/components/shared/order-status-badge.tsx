import { useTranslations } from 'next-intl';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import type { OrderStatus } from '@/lib/api/customers';

// UX-002: semantic color per order lifecycle stage (8.7).
const VARIANT_BY_STATUS: Record<OrderStatus, BadgeProps['variant']> = {
  DRAFT: 'outline',
  SUBMITTED: 'warning',
  CONFIRMED: 'secondary',
  SHIPPED: 'secondary',
  DELIVERED: 'success',
  CLOSED: 'secondary',
  CANCELLED: 'destructive',
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const t = useTranslations('OrderStatus');
  return <Badge variant={VARIANT_BY_STATUS[status]}>{t(status)}</Badge>;
}
