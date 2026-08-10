import type { OrderStatus } from '@/lib/api/orders';

/** UX-002 semantics: green = done, red = cancelled, yellow = waiting on someone. */
const VARIANTS: Record<OrderStatus, 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'> = {
  DRAFT: 'outline',
  SUBMITTED: 'warning',
  CONFIRMED: 'secondary',
  SHIPPED: 'default',
  DELIVERED: 'success',
  CLOSED: 'success',
  CANCELLED: 'destructive',
};

export function orderStatusVariant(status: OrderStatus) {
  return VARIANTS[status] ?? 'secondary';
}
