import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { prisma, systemPrisma } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../customers/customers.service';
import { NotificationsService } from '../notifications/notifications.service';
import { makeOwnerAlerts } from '../notifications/test-owner-alerts';
import { StockService } from '../stock/stock.service';
import { SalesService } from './sales.service';

/**
 * ADR-059 PO question (resolved by ADR-059a: reject): packaging qty 0.125 × qtyInBaseUnit 1.5 = 0.1875 base units.
 * SalesOrderLine.qty is Decimal(18,3): it used to be STORED as 0.188 while lineTotal came from
 * the UNROUNDED 0.1875 (210.00 vs 0.188 × 1000 × 1.12 = 210.56). Now rejected before any write.
 */
describe('ADR-059 PO question: packaging factor makes base qty finer than 3dp', () => {
  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const stock = new StockService(tenantPrisma, auditLog, makeOwnerAlerts(tenantPrisma));
  const sales = new SalesService(tenantPrisma, auditLog, customers, stock, new DocumentNumberingService(), new NotificationsService(tenantPrisma, new ConfigService()));

  let companyId: string;
  let user: AuthenticatedUser;
  let productId: string;
  let packagingId: string;
  let customerId: string;

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-pkg-div-${Date.now()}`, name: 'Pkg Divergence Tenant' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Pkg Divergence Co' } })).id;
    const dbUser = await systemPrisma.user.create({ data: { companyId, firstName: 'Op', lastName: 'Pkg', phone: '+998900000771' } });
    user = { id: dbUser.id, companyId, firstName: 'Op', lastName: 'Pkg', roles: ['WAREHOUSE'], permissions: ['orders.update'] };
    await tenantPrisma.run(companyId, async (tx) => {
      const product = await tx.product.create({ data: { companyId, sku: 'PKG-DIV-1', name: 'Pkg Div', baseUnit: 'kg', vatRate: 12 } });
      productId = product.id;
      packagingId = (await tx.productPackaging.create({ data: { productId, name: 'bag 1.5kg', qtyInBaseUnit: '1.5', isDefault: true } })).id;
      const priceList = await tx.priceList.create({ data: { companyId, name: 'Default', isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: priceList.id, productId, price: '1000.00' } });
    });
    const warehouse = await tenantPrisma.run(companyId, (tx) => tx.warehouse.create({ data: { companyId, name: 'WH' } }));
    await tenantPrisma.run(companyId, () => stock.receive({ productId, warehouseId: warehouse.id, qty: 100 }, user));
    customerId = ((await tenantPrisma.run(companyId, () => customers.create({ code: `PKG-${Date.now()}`, name: 'Pkg Cust' }, user))).customer as { id: string }).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  // ADR-059a (PO 2026-11-01): resolved by rejecting, never rounding, a base qty finer than 3 dp.
  it('ADR-059a: 0.125 × 1.5 = 0.1875 base units is rejected (ORDER_QTY_PRECISION), nothing written', async () => {
    const before = await tenantPrisma.run(companyId, (tx) => tx.salesOrder.count());
    const err = await tenantPrisma
      .run(companyId, () => sales.create({ customerId, lines: [{ productId, packagingId, qty: 0.125 }] }, user))
      .then(() => null, (e: unknown) => e as { getStatus(): number; getResponse(): { code: string; details: Record<string, unknown> } });
    expect(err?.getStatus()).toBe(400);
    expect(err?.getResponse().code).toBe('ORDER_QTY_PRECISION');
    expect(err?.getResponse().details).toMatchObject({ qty: '0.125', qtyInBaseUnit: '1.5', baseQty: '0.1875' });
    expect(await tenantPrisma.run(companyId, (tx) => tx.salesOrder.count())).toBe(before);
  });
});
