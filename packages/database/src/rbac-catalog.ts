// Single source of truth for the fixed system-role / permission catalog
// (SEC-020..024: permission keys are "modul.harakat"). RBAC is fixed system
// roles only in MVP — no custom-role authoring ([v1.1]) — so this catalog is
// the *only* way a tenant ever gets its roles and grants.
//
// Previously this list lived twice (seed.ts + bootstrap-owner.ts) and had to be
// kept in sync by hand. Both now import from here; new consumers (e.g.
// backfill-permissions.ts) must import too, never re-declare. Consumers must be
// side-effect free at import time, hence this module has no top-level env
// checks, no DB connection and no logging.
//
// Anything changed here still needs a matching update in
// apps/web/messages/{uz,ru,en}.json (AppShell.roles, keyed by role code) for
// role names, and a run of backfill-permissions.ts for already-provisioned
// tenants (seed/bootstrap only apply to fresh databases).

// 4.1 (post-simplification): trimmed from 9 to 6 system roles. SUPERVISOR
// (permissions were a near-subset of SALES_DIRECTOR — no persona in 4.2, and
// the ICP's 8-40 agents are manageable by one director), OPERATOR (phone-order
// channel — folded into SALES_DIRECTOR/OWNER taking calls directly), and
// VIEWER (no persona, no workflow depends on read-only access) were dropped
// to keep the role list unambiguous for non-technical owners. ACCOUNTANT was
// briefly dropped too (3.4) but restored per customer request. OWNER/
// SALES_DIRECTOR/SALES_AGENT role *codes* are unchanged (business logic keys
// off them — see users.service.ts, cash-sessions.service.ts) — only the
// display name changed (Admin / Director / Agent).
export const SYSTEM_ROLES: { code: string; name: string }[] = [
  { code: 'OWNER', name: 'Admin' },
  { code: 'SALES_DIRECTOR', name: 'Director' },
  { code: 'SALES_AGENT', name: 'Agent' },
  // Kuryer: the company's OWN delivery person, not an external counterparty —
  // deliberately an ordinary `User` row with a system role rather than a
  // separate entity, so couriers reuse the agent Telegram login
  // (User.telegramId + POST /auth/telegram + Mini App) with zero new auth code.
  // Replaces the removed Supplier ("yetkazib beruvchi") concept.
  { code: 'COURIER', name: 'Kuryer' },
  { code: 'WAREHOUSE', name: 'Omborchi' },
  { code: 'CASHIER', name: 'Kassir' },
  { code: 'ACCOUNTANT', name: 'Buxgalter' },
];

// RBAC catalog (SEC-020..024: "modul.harakat"). Not specified verbatim in
// the TZ — a reasonable module/action split covering MVP scope (5.3), grants
// per role loosely matching the responsibilities in 4.1.
export const PERMISSION_DEFS: { module: string; actions: string[] }[] = [
  { module: 'customers', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'catalog', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'stock', actions: ['read', 'receive', 'adjust'] },
  // `deliver` is deliberately separate from `update`: `update` guards confirm/
  // close/cancel/delete and courier assignment, so granting it to a courier
  // would let them drive or delete any order in the tenant. `deliver` is the
  // narrow "mark my delivery done" transition (CONFIRMED -> DELIVERED).
  { module: 'orders', actions: ['read', 'create', 'update', 'cancel', 'deliver'] },
  { module: 'invoices', actions: ['read'] },
  { module: 'payments', actions: ['read', 'create'] },
  { module: 'cash', actions: ['read', 'open', 'close'] },
  { module: 'routes', actions: ['read', 'create', 'update'] },
  { module: 'field', actions: ['read', 'create'] },
  { module: 'reports', actions: ['read', 'export'] },
  { module: 'users', actions: ['read', 'create', 'update', 'delete'] },
  { module: 'roles', actions: ['read'] },
  { module: 'audit', actions: ['read'] },
  { module: 'settings', actions: ['read', 'update'] },
  { module: 'integrations', actions: ['export1c'] },
];

// Roles are fixed system roles with no custom-role authoring in MVP
// (roles.service.ts) — a real tenant has no later way to grant these by hand,
// so every non-OWNER role must come out of provisioning already usable, not
// just created as an empty shell.
export const ROLE_PERMISSIONS: Record<string, string[] | 'ALL'> = {
  OWNER: 'ALL',
  SALES_DIRECTOR: [
    'customers.read', 'customers.update', 'catalog.read', 'stock.read',
    'orders.read', 'orders.update', 'orders.deliver', 'invoices.read', 'payments.read',
    'routes.read', 'routes.create', 'routes.update', 'field.read',
    'reports.read', 'reports.export', 'users.read', 'users.create',
    'users.update', 'users.delete', 'roles.read',
  ],
  SALES_AGENT: [
    'customers.read', 'catalog.read', 'stock.read', 'orders.read',
    'orders.create', 'payments.create', 'payments.read', 'invoices.read', 'routes.read', 'field.read', 'field.create',
  ],
  // Deliberately narrow: a courier only needs to find the customer, see what
  // is on the order and mark their own delivery done. `orders.deliver`, not
  // `orders.update` — the latter also guards confirm/cancel/delete and courier
  // reassignment. No create/cancel, no stock, no payments. Restricting a
  // courier to their OWN orders is enforced in the API on top of this.
  COURIER: [
    'customers.read', 'catalog.read', 'orders.read', 'orders.deliver',
  ],
  WAREHOUSE: [
    'catalog.read', 'stock.read', 'stock.receive', 'stock.adjust',
    'orders.read', 'orders.update',
    'orders.deliver', // marks CONFIRMED orders as DELIVERED
  ],
  CASHIER: [
    'customers.read', 'invoices.read', 'payments.read', 'payments.create',
    'cash.read', 'cash.open', 'cash.close',
  ],
  ACCOUNTANT: [
    'customers.read', 'invoices.read', 'payments.read', 'cash.read', 'reports.read',
    'reports.export', 'integrations.export1c',
  ],
};

/** Every permission key ("module.action") in the catalog, in declaration order. */
export const ALL_PERMISSION_KEYS: string[] = PERMISSION_DEFS.flatMap((def) =>
  def.actions.map((action) => `${def.module}.${action}`),
);

/**
 * Permission keys a system role must hold. Unknown role codes (custom roles,
 * should not exist in MVP) resolve to an empty list, never to 'ALL'.
 */
export function permissionKeysForRole(roleCode: string): string[] {
  const grant = ROLE_PERMISSIONS[roleCode];
  if (grant === 'ALL') return ALL_PERMISSION_KEYS;
  return grant ?? [];
}
