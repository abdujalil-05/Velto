import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../customers/customers.service';
import { PaymentsService } from '../finance/payments/payments.service';
import { StockService } from '../stock/stock.service';
import { SalesService } from '../sales/sales.service';
import { NotificationsService } from './notifications.service';
import { OWNER_ALERT_TYPES } from './owner-alerts';
import { makeOwnerAlerts } from './test-owner-alerts';

const DEDUP_LIKE = ['stock.adjust:', 'stock.reverse:', 'payment.reverse:'];
const phone = () => `+99897${Math.floor(1e6 + Math.random() * 8e6)}`;

describe('ADR-060 OWNER alerts are not triggered by the standard sales flow (real Postgres + RLS)', () => {
  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const stock = new StockService(tenantPrisma, auditLog, makeOwnerAlerts(tenantPrisma));
  const docNumbering = new DocumentNumberingService();
  const sales = new SalesService(tenantPrisma, auditLog, customers, stock, docNumbering, new NotificationsService(tenantPrisma, new ConfigService()));
  const payments = new PaymentsService(tenantPrisma, auditLog, customers, docNumbering, makeOwnerAlerts(tenantPrisma));

  let companyId: string;
  let user: AuthenticatedUser;
  let owners: string[];
  let warehouseId: string;
  let productId: string;
  let packagingId: string;

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-oaflow-${randomUUID().slice(0, 8)}`, name: 'OA Flow' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'OA Flow Co' } })).id;
    const ownerRole = await systemPrisma.role.create({ data: { companyId, name: 'Owner', code: 'OWNER', isSystem: true } });
    const mk = async (label: string, isActive = true, roleId?: string) => {
      const u = await systemPrisma.user.create({ data: { companyId, firstName: label, lastName: 'Flow', phone: phone(), isActive } });
      if (roleId) await systemPrisma.userRole.create({ data: { userId: u.id, roleId } });
      return u;
    };
    owners = [(await mk('O1', true, ownerRole.id)).id, (await mk('O2', true, ownerRole.id)).id];
    await mk('O3inactive', false, ownerRole.id);
    const op = await mk('Op');
    user = { id: op.id, companyId, firstName: 'Op', lastName: 'Flow', roles: ['WAREHOUSE'], permissions: ['orders.update'] };

    await tenantPrisma.run(companyId, async (tx) => {
      warehouseId = (await tx.warehouse.create({ data: { companyId, name: 'Flow WH' } })).id;
      const product = await tx.product.create({ data: { companyId, sku: 'FLOW-1', name: 'Flow Product', baseUnit: 'dona', vatRate: 12 } });
      productId = product.id;
      packagingId = (await tx.productPackaging.create({ data: { productId, name: 'dona', qtyInBaseUnit: 1, isDefault: true } })).id;
      const pl = await tx.priceList.create({ data: { companyId, name: 'Default', isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: pl.id, productId, price: '10000' } });
    });
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  const alertRows = () =>
    systemPrisma.notification.findMany({
      where: { companyId, OR: [{ type: { in: [...OWNER_ALERT_TYPES] } }, ...DEDUP_LIKE.map((p) => ({ dedupKey: { startsWith: p } }))] },
    });

  it('ADR-060: create -> confirm -> deliver (RESERVE/ISSUE movements + invoice) creates zero OWNER alerts; manual ADJUST and payment reversal create exactly one per active OWNER', async () => {
    const { customer } = await tenantPrisma.run(companyId, () => customers.create({ code: `FLOW-${randomUUID().slice(0, 8)}`, name: 'Flow Customer' }, user));
    const customerId = (customer as { id: string }).id;

    await tenantPrisma.run(companyId, () => stock.receive({ productId, warehouseId, qty: 100 }, user));
    const order = await tenantPrisma.run(companyId, () => sales.create({ customerId, lines: [{ productId, packagingId, qty: 4 }] }, user));
    await tenantPrisma.run(companyId, () => sales.confirm(order.id, user));
    const delivered = await tenantPrisma.run(companyId, () => sales.deliver(order.id, user));
    expect(delivered.status).toBe('DELIVERED');

    // The flow really exercised stock + invoice paths.
    const types = (await systemPrisma.stockMovement.findMany({ where: { companyId, productId } })).map((m) => m.type);
    expect(types).toEqual(expect.arrayContaining(['RECEIVE']));
    expect(await systemPrisma.invoice.count({ where: { orderId: order.id } })).toBe(1);
    expect(await systemPrisma.stockMovement.count({ where: { companyId, refId: order.id } })).toBeGreaterThan(0);

    expect(await alertRows()).toHaveLength(0);

    // Independent critical operations in the same company.
    await tenantPrisma.run(companyId, () => stock.adjust({ productId, warehouseId, qty: -2, reason: 'damaged in flow' }, user));
    const mv = await systemPrisma.stockMovement.findFirstOrThrow({ where: { companyId, type: 'ADJUST', productId } });
    const pay = await tenantPrisma.run(companyId, () => payments.create({ customerId, amount: 50000, method: 'TRANSFER' }, user));
    await tenantPrisma.run(companyId, () => payments.reverse(pay.id, 'entered by mistake', user));
    const reversal = await systemPrisma.paymentReversal.findUniqueOrThrow({ where: { reversesPaymentId: pay.id } });

    const rows = await alertRows();
    const forAdjust = rows.filter((r) => r.dedupKey === `stock.adjust:${mv.id}`);
    const forReverse = rows.filter((r) => r.dedupKey === `payment.reverse:${reversal.id}`);
    expect(forAdjust.map((r) => r.recipientId).sort()).toEqual([...owners].sort());
    expect(forReverse.map((r) => r.recipientId).sort()).toEqual([...owners].sort());
    expect(rows).toHaveLength(owners.length * 2);
    expect(new Set(rows.map((r) => r.type))).toEqual(new Set(['stock.adjusted', 'payment.reversed']));
  });
});
