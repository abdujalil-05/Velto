import { describe, expect, it } from 'vitest';
import { ALL_PERMISSION_KEYS, PERMISSION_DEFS, SYSTEM_ROLES, permissionKeysForRole } from '../rbac-catalog';

/** F1.4 / SEC-020..024: fixed system roles; ACCOUNTANT is read/export-only, COURIER is minimal. */
describe('rbac-catalog: F1.4 role grants', () => {
  it('ACCOUNTANT grant snapshot is exact', () => {
    expect([...permissionKeysForRole('ACCOUNTANT')].sort()).toEqual(
      [
        'cash.read', 'customers.read', 'integrations.ack1c', 'integrations.export1c', 'invoices.read', 'opening.read',
        'payments.read', 'purchases.read', 'reconciliation.read', 'reports.export', 'reports.read',
      ],
    );
  });

  it('ACCOUNTANT holds no write permission except the single ADR-003c exception integrations.ack1c', () => {
    const keys = permissionKeysForRole('ACCOUNTANT');
    const forbidden = [
      'payments.create', 'cash.open', 'cash.close', 'orders.create', 'orders.update', 'orders.cancel',
      'orders.deliver', 'stock.receive', 'stock.adjust', 'stock.reverse', 'payments.reverse', 'payments.allocate', 'payments.handover', 'purchases.create', 'purchases.receive',
      'reconciliation.fix', 'opening.preview', 'opening.post', 'opening.void', 'company.export',
      'users.create', 'users.update', 'users.delete', 'settings.update',
      'catalog.create', 'catalog.update', 'catalog.delete',
      'customers.create', 'customers.update', 'customers.delete',
    ];
    for (const key of forbidden) {
      expect(ALL_PERMISSION_KEYS, `${key} must exist in the catalog`).toContain(key);
      expect(keys, key).not.toContain(key);
    }
    // Generic guard: only read/export actions (export1c is the 1C export) are allowed,
    // plus exactly one write exception (ADR-003c): integrations.ack1c.
    const allowedActions = new Set(['read', 'export', 'export1c']);
    const ADR_003C_EXCEPTIONS = ['integrations.ack1c'];
    const writes = keys.filter((key) => !allowedActions.has(key.split('.')[1]!));
    expect(writes).toEqual(ADR_003C_EXCEPTIONS);
  });

  it('ADR-003c exception: integrations.ack1c → OWNER + ACCOUNTANT only', () => {
    const holders = SYSTEM_ROLES.filter((r) => permissionKeysForRole(r.code).includes('integrations.ack1c')).map((r) => r.code);
    expect(holders.sort()).toEqual(['ACCOUNTANT', 'OWNER']);
  });

  it('F2.1: payments.reverse / stock.reverse granted only to OWNER and SALES_DIRECTOR', () => {
    for (const key of ['payments.reverse', 'stock.reverse']) {
      const holders = SYSTEM_ROLES.filter((r) => permissionKeysForRole(r.code).includes(key)).map((r) => r.code);
      expect(holders.sort(), key).toEqual(['OWNER', 'SALES_DIRECTOR']);
    }
  });

  it('F2.1: payments.allocate granted only to OWNER, SALES_DIRECTOR and CASHIER', () => {
    const holders = SYSTEM_ROLES.filter((r) => permissionKeysForRole(r.code).includes('payments.allocate')).map((r) => r.code);
    expect(holders.sort()).toEqual(['CASHIER', 'OWNER', 'SALES_DIRECTOR']);
  });

  it('F8.1: payments.handover granted only to OWNER and CASHIER, not SALES_DIRECTOR (ADR-029)', () => {
    const holders = SYSTEM_ROLES.filter((r) => permissionKeysForRole(r.code).includes('payments.handover')).map((r) => r.code);
    expect(holders.sort()).toEqual(['CASHIER', 'OWNER']);
  });

  it('F2.5: reconciliation.read → OWNER + ACCOUNTANT; reconciliation.fix → OWNER only', () => {
    const holders = (key: string) =>
      SYSTEM_ROLES.filter((r) => permissionKeysForRole(r.code).includes(key)).map((r) => r.code).sort();
    expect(holders('reconciliation.read')).toEqual(['ACCOUNTANT', 'OWNER']);
    expect(holders('reconciliation.fix')).toEqual(['OWNER']);
  });

  it('F6: opening.read → OWNER + ACCOUNTANT; opening.preview/post/void and company.export → OWNER only', () => {
    const holders = (key: string) =>
      SYSTEM_ROLES.filter((r) => permissionKeysForRole(r.code).includes(key)).map((r) => r.code).sort();
    expect(holders('opening.read')).toEqual(['ACCOUNTANT', 'OWNER']);
    expect(holders('opening.preview')).toEqual(['OWNER']);
    expect(holders('opening.post')).toEqual(['OWNER']);
    expect(holders('opening.void')).toEqual(['OWNER']);
    expect(holders('company.export')).toEqual(['OWNER']);
    for (const key of ['opening.read', 'opening.preview', 'opening.post', 'opening.void', 'company.export']) {
      expect(key.split('.'), key).toHaveLength(2);
    }
  });

  it('F3: routes.finish → OWNER, SALES_DIRECTOR, SALES_AGENT only', () => {
    const holders = SYSTEM_ROLES.filter((r) => permissionKeysForRole(r.code).includes('routes.finish')).map((r) => r.code);
    expect(holders.sort()).toEqual(['OWNER', 'SALES_AGENT', 'SALES_DIRECTOR']);
    expect(permissionKeysForRole('SALES_AGENT')).not.toContain('routes.update');
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
