import { describe, expect, it } from 'vitest';
import { ALL_PERMISSION_KEYS, PERMISSION_DEFS, SYSTEM_ROLES, permissionKeysForRole } from '../rbac-catalog';

/** F1.4 / SEC-020..024: fixed system roles; ACCOUNTANT is read/export-only, COURIER is minimal. */
describe('rbac-catalog: F1.4 role grants', () => {
  it('ACCOUNTANT grant snapshot is exact', () => {
    expect([...permissionKeysForRole('ACCOUNTANT')].sort()).toEqual(
      [
        'cash.read', 'customers.read', 'integrations.export1c', 'invoices.read', 'payments.read',
        'purchases.read', 'reports.export', 'reports.read',
      ],
    );
  });

  it('ACCOUNTANT holds no write permission anywhere', () => {
    const keys = permissionKeysForRole('ACCOUNTANT');
    const forbidden = [
      'payments.create', 'cash.open', 'cash.close', 'orders.create', 'orders.update', 'orders.cancel',
      'orders.deliver', 'stock.receive', 'stock.adjust', 'stock.reverse', 'payments.reverse', 'purchases.create', 'purchases.receive',
      'users.create', 'users.update', 'users.delete', 'settings.update',
      'catalog.create', 'catalog.update', 'catalog.delete',
      'customers.create', 'customers.update', 'customers.delete',
    ];
    for (const key of forbidden) {
      expect(ALL_PERMISSION_KEYS, `${key} must exist in the catalog`).toContain(key);
      expect(keys, key).not.toContain(key);
    }
    // Generic guard: only read/export actions (export1c is the 1C export) are allowed.
    const allowedActions = new Set(['read', 'export', 'export1c']);
    for (const key of keys) expect(allowedActions.has(key.split('.')[1]!), key).toBe(true);
  });

  it('F2.1: payments.reverse / stock.reverse granted only to OWNER and SALES_DIRECTOR', () => {
    for (const key of ['payments.reverse', 'stock.reverse']) {
      const holders = SYSTEM_ROLES.filter((r) => permissionKeysForRole(r.code).includes(key)).map((r) => r.code);
      expect(holders.sort(), key).toEqual(['OWNER', 'SALES_DIRECTOR']);
    }
  });

  it('COURIER holds exactly 4 keys', () => {
    expect([...permissionKeysForRole('COURIER')].sort()).toEqual([
      'catalog.read', 'customers.read', 'orders.deliver', 'orders.read',
    ]);
  });

  it('SYSTEM_ROLES has no PLATFORM_ADMIN and unknown roles resolve to no keys', () => {
    expect(SYSTEM_ROLES.map((r) => r.code)).not.toContain('PLATFORM_ADMIN');
    expect(permissionKeysForRole('PLATFORM_ADMIN')).toEqual([]);
  });

  it('every role grant references only keys that exist in PERMISSION_DEFS', () => {
    const all = new Set(PERMISSION_DEFS.flatMap((d) => d.actions.map((a) => `${d.module}.${a}`)));
    for (const role of SYSTEM_ROLES) {
      for (const key of permissionKeysForRole(role.code)) expect(all.has(key), `${role.code}:${key}`).toBe(true);
    }
  });
});
