import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { SupplierRouteNotFoundException, SupplierNotFoundException } from '../purchases-exceptions';
import { SuppliersService } from '../suppliers/suppliers.service';
import { SupplierRoutesService } from './supplier-routes.service';

describe('SupplierRoutesService (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let user: AuthenticatedUser;
  let supplierId: string;

  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const suppliers = new SuppliersService(tenantPrisma, auditLog);
  const supplierRoutes = new SupplierRoutesService(tenantPrisma, auditLog, suppliers);

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({
      data: { slug: `test-supplier-routes-${Date.now()}`, name: 'Supplier Routes Test Tenant' },
    });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Supplier Routes Test Co' } });
    companyId = company.id;

    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Ware', lastName: 'House', phone: '+998900000040' },
    });
    user = {
      id: dbUser.id,
      companyId,
      firstName: 'Ware',
      lastName: 'House',
      roles: ['WAREHOUSE_MANAGER'],
      permissions: ['purchases.read', 'purchases.create'],
    };

    await tenantPrisma.run(companyId, async (tx) => {
      const supplier = await tx.supplier.create({ data: { companyId, name: 'Bazaar Co' } });
      supplierId = supplier.id;
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('creates a route for the supplier and lists it back', async () => {
    const route = await tenantPrisma.run(companyId, () =>
      supplierRoutes.create(supplierId, { weekday: 2, name: 'Tuesday pickup' }, user),
    );
    expect(route.supplierId).toBe(supplierId);
    expect(route.isActive).toBe(true);

    const { data } = await tenantPrisma.run(companyId, () =>
      supplierRoutes.list(supplierId, { page: 1, pageSize: 25 }),
    );
    expect(data.map((r) => r.id)).toContain(route.id);
  });

  it('rejects a route for an unknown supplier', async () => {
    await expect(
      tenantPrisma.run(companyId, () => supplierRoutes.create(randomUUID(), { weekday: 1, name: 'x' }, user)),
    ).rejects.toBeInstanceOf(SupplierNotFoundException);
  });

  it('adds stops in order, assigning sequence from the current count', async () => {
    const route = await tenantPrisma.run(companyId, () =>
      supplierRoutes.create(supplierId, { weekday: 3, name: 'Wednesday pickup' }, user),
    );

    const stop1 = await tenantPrisma.run(companyId, () =>
      supplierRoutes.addStop(supplierId, route.id, { pickupAddress: 'Bazaar stall 1' }, user),
    );
    const stop2 = await tenantPrisma.run(companyId, () =>
      supplierRoutes.addStop(supplierId, route.id, { pickupAddress: 'Bazaar stall 2', latitude: 41.3, longitude: 69.24 }, user),
    );

    expect(stop1.sequence).toBe(1);
    expect(stop2.sequence).toBe(2);
  });

  it('rejects a stop on an unknown route', async () => {
    await expect(
      tenantPrisma.run(companyId, () =>
        supplierRoutes.addStop(supplierId, randomUUID(), { pickupAddress: 'nowhere' }, user),
      ),
    ).rejects.toBeInstanceOf(SupplierRouteNotFoundException);
  });
});
