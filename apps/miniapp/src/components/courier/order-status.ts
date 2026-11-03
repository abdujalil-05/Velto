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

/** Assigned CONFIRMED orders are not with the courier yet: the warehouse must hand them over (POST /orders/:id/handover -> SHIPPED) before deliver is accepted. */
export function isAwaitingHandover(status: OrderStatus): boolean {
  return status === 'CONFIRMED';
}

/** next-intl key (namespace Courier) of the badge label for a courier order. */
export function courierStatusLabelKey(status: OrderStatus): string {
  return isAwaitingHandover(status) ? 'awaitingHandover' : `status.${status}`;
}
