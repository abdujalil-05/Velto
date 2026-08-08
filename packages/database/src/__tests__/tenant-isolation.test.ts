// SEC-001..005 / VELTO-TZ.md 6.10: "Har bir yangi jadval uchun izolyatsiya
// testi majburiy" — cross-tenant leak tests must run in CI and block merge.
// This exercises both isolation strategies used in the RLS migration:
// direct-companyId tables (Customer) and parent-subquery child tables
// (RolePermission, isolated via its Role's companyId), plus the fail-closed
// default and the AuditLog append-only trigger.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma, withTenant } from '../client';

describe('tenant isolation (RLS)', () => {
  let tenantId: string;
  let companyAId: string;
  let companyBId: string;
  let permissionId: string;
  let recipientId: string;

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-isolation-${Date.now()}`, name: 'Isolation Test Tenant' },
    });
    tenantId = tenant.id;

    const [companyA, companyB] = await Promise.all([
      systemPrisma.company.create({ data: { tenantId, name: 'Isolation Test Co A' } }),
      systemPrisma.company.create({ data: { tenantId, name: 'Isolation Test Co B' } }),
    ]);
    companyAId = companyA.id;
    companyBId = companyB.id;

    const permission = await systemPrisma.permission.upsert({
      where: { module_code: { module: 'test', code: 'isolation' } },
      update: {},
      create: { module: 'test', code: 'isolation' },
    });
    permissionId = permission.id;

    await withTenant(companyAId, (tx) => tx.customer.create({ data: { companyId: companyAId, code: 'A-1', name: 'Customer A' } }));
    await withTenant(companyBId, (tx) => tx.customer.create({ data: { companyId: companyBId, code: 'B-1', name: 'Customer B' } }));

    const period = { periodFrom: new Date(), periodTo: new Date() };
    await withTenant(companyAId, (tx) =>
      tx.exportJob.create({ data: { companyId: companyAId, type: '1c', format: 'XML', status: 'PENDING', ...period } }),
    );

    await withTenant(companyAId, (tx) =>
      tx.documentCounter.create({ data: { companyId: companyAId, docType: 'SO', year: 2026, lastNumber: 1 } }),
    );

    const recipient = await systemPrisma.user.create({
      data: { companyId: companyAId, firstName: 'Notify', lastName: 'Me', phone: '+998900000097' },
    });
    recipientId = recipient.id;
    await withTenant(companyAId, (tx) =>
      tx.notification.create({
        data: {
          companyId: companyAId,
          recipientId,
          type: 'order.on_hold',
          title: { uz: 'Test', ru: 'Test', en: 'Test' },
          message: { uz: 'Test', ru: 'Test', en: 'Test' },
        },
      }),
    );

    await withTenant(companyAId, async (tx) => {
      const role = await tx.role.create({ data: { companyId: companyAId, code: 'ISO_TEST', name: 'Isolation Test Role' } });
      await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
    });
  });

  afterAll(async () => {
    // Company/Tenant are deliberately NOT deleted here: the AuditLog test
    // below creates a row that FK-restricts deletion of its Company, and the
    // log itself can never be deleted (append-only). That's the correct
    // behavior for immutable audit history (15.6, ≥3 year retention), so this
    // suite leaves a small, harmless test fixture behind rather than fighting
    // the constraint. CI runs against a throwaway database per run anyway.
    await systemPrisma.rolePermission.deleteMany({ where: { permissionId } });
    await systemPrisma.role.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.exportJob.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.documentCounter.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.notification.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.user.delete({ where: { id: recipientId } });
    await systemPrisma.customer.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await systemPrisma.permission.deleteMany({ where: { id: permissionId } });
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('a direct-companyId table (Customer) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.customer.findMany());
    const seenFromB = await withTenant(companyBId, (tx) => tx.customer.findMany());

    expect(seenFromA.map((c) => c.code)).toEqual(['A-1']);
    expect(seenFromB.map((c) => c.code)).toEqual(['B-1']);
  });

  it('a direct-companyId table (ExportJob, M12 1C export) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.exportJob.findMany());
    const seenFromB = await withTenant(companyBId, (tx) => tx.exportJob.findMany());

    expect(seenFromA).toHaveLength(1);
    expect(seenFromB).toHaveLength(0);
  });

  it('a direct-companyId table (Notification, M14) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.notification.findMany());
    const seenFromB = await withTenant(companyBId, (tx) => tx.notification.findMany());

    expect(seenFromA).toHaveLength(1);
    expect(seenFromB).toHaveLength(0);
  });

  it('a direct-companyId table (DocumentCounter, 11.2 document numbering) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) => tx.documentCounter.findMany());
    const seenFromB = await withTenant(companyBId, (tx) => tx.documentCounter.findMany());

    expect(seenFromA).toHaveLength(1);
    expect(seenFromB).toHaveLength(0);
  });

  it('a parent-subquery child table (RolePermission via Role) is scoped per tenant', async () => {
    const seenFromA = await withTenant(companyAId, (tx) =>
      tx.rolePermission.findMany({ where: { permissionId } }),
    );
    const seenFromB = await withTenant(companyBId, (tx) =>
      tx.rolePermission.findMany({ where: { permissionId } }),
    );

    expect(seenFromA).toHaveLength(1);
    expect(seenFromB).toHaveLength(0);
  });

  it('fails closed (never leaks) when no tenant context is set', async () => {
    // On a pooled connection previously used by withTenant(), Postgres
    // reverts a custom GUC to '' (not NULL) once the setting transaction
    // ends, since custom parameters have no true "unset" state — so the
    // ::uuid cast in the RLS policy can throw instead of matching zero rows.
    // Both outcomes are safe (neither leaks another tenant's rows); a test
    // that depends on which one happens would just be testing connection
    // pool timing, not the security property.
    try {
      const rows = await prisma.customer.findMany({
        where: { companyId: { in: [companyAId, companyBId] } },
      });
      expect(rows).toHaveLength(0);
    } catch (err) {
      expect(String(err)).toMatch(/uuid/i);
    }
  });

  it('AuditLog is append-only — UPDATE and DELETE are rejected even for the owning role', async () => {
    const log = await withTenant(companyAId, (tx) =>
      tx.auditLog.create({
        data: { companyId: companyAId, action: 'test.action', entity: 'Test', entityId: companyAId },
      }),
    );

    await expect(
      withTenant(companyAId, (tx) =>
        tx.$executeRaw`UPDATE "AuditLog" SET action = 'changed' WHERE id = ${log.id}::uuid`,
      ),
    ).rejects.toThrow(/append-only/i);

    await expect(
      withTenant(companyAId, (tx) => tx.$executeRaw`DELETE FROM "AuditLog" WHERE id = ${log.id}::uuid`),
    ).rejects.toThrow(/append-only/i);

    // TRUNCATE fires statement-level triggers, not row-level ones — the
    // UPDATE/DELETE guard above doesn't cover it on its own (20260730224500).
    await expect(
      withTenant(companyAId, (tx) => tx.$executeRawUnsafe('TRUNCATE TABLE "AuditLog"')),
    ).rejects.toThrow(/append-only/i);

    // No cleanup: the row is append-only by design, even for the BYPASSRLS
    // role — this one test log entry is expected to remain in dev/test data.
  });
});
