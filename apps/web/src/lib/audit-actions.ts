/**
 * Maps raw `AuditLog.action` values written by `apps/api` (grep `action: '...'` under
 * `apps/api/src/modules/**`, plus `auth.login`/`auth.login.telegram` in
 * `apps/api/src/modules/auth/auth.service.ts`) to a `messages/{locale}.json` key under
 * `Audit.actions`. Keep this list in sync when a new audit-log call is added on the API side.
 */
const KNOWN_AUDIT_ACTIONS = new Set<string>([
  'auth.login',
  'auth.login.telegram',
  'auth.refresh',
  'auth.telegram_linked',
  'auth.login_failed',
  'auth.permission_denied',
  'auth.password_reset_requested',
  'auth.password_reset_completed',
  'user.create',
  'user.update',
  'user.deactivate',
  'user.activate',
  'user.delete',
  'user.soft_delete',
  'customer.create',
  'customer.update',
  'customer.block',
  'customer.unblock',
  'customer.delete',
  'customer.import',
  'outlet.create',
  'outlet.update',
  'outlet.delete',
  'company.update',
  'purchaseOrder.create',
  'purchaseOrder.submit',
  'purchaseOrder.receive',
  'purchaseOrder.cancel',
  'supplier.create',
  'supplier.update',
  'supplier.delete',
  'order.create',
  'order.confirm',
  'order.deliver',
  'order.close',
  'order.cancel',
  'product.create',
  'product.update',
  'product.delete',
  'product.image.update',
  'product.import',
  'category.create',
  'priceList.create',
  'priceList.items.upsert',
  'visit.create',
  'route.finish',
  'route.create',
  'route.update',
  'payment.create',
  'cash.open',
  'cash.close',
  'stock.receive',
  'stock.adjust',
  'warehouse.create',
  'warehouse.deactivate',
]);

/** Returns the `Audit.actions.*` message key for a raw AuditLog.action string. */
export function auditActionMessageKey(action: string): string {
  return KNOWN_AUDIT_ACTIONS.has(action) ? action.replace(/\./g, '_') : 'unknown';
}
