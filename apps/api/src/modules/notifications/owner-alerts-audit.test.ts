import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { runWithTraceId } from '../../common/trace/trace-context';
import { CustomersService } from '../customers/customers.service';
import { PaymentsService } from '../finance/payments/payments.service';
import { StockService } from '../stock/stock.service';
import { OwnerAlertsService } from './owner-alerts';
import { makeOwnerAlerts } from './test-owner-alerts';
import type { NotificationsService } from './notifications.service';

const phone = () => `+99897${Math.floor(1e6 + Math.random() * 8e6)}`;
const LONG_REASON = `long reason ${'x'.repeat(300)} END`; // > 200 chars: the alert clips, the audit must not

describe('ADR-060 AuditLog for payment reversal and stock adjust (real Postgres + RLS)', () => {
  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const customers = new CustomersService(tenantPrisma, auditLog);
  const stock = new StockService(tenantPrisma, auditLog, makeOwnerAlerts(tenantPrisma));
  const payments = new PaymentsService(tenantPrisma, auditLog, customers, new DocumentNumberingService(), makeOwnerAlerts(tenantPrisma));
  const brokenAlerts = new OwnerAlertsService({ notifyMany: async () => { throw new Error('notify down'); } } as unknown as NotificationsService);

  let companyId: string;
  let actor: AuthenticatedUser;
  let productId: string;
  let warehouseId: string;
  let customerId: string;

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-oaaud-${randomUUID().slice(0, 8)}`, name: 'OA Audit' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'OA Audit Co' } })).id;
    const ownerRole = await systemPrisma.role.create({ data: { companyId, name: 'Owner', code: 'OWNER', isSystem: true } });
    const owner = await systemPrisma.user.create({ data: { companyId, firstName: 'Own', lastName: 'Er', phone: phone() } });
    await systemPrisma.userRole.create({ data: { userId: owner.id, roleId: ownerRole.id } });
    const u = await systemPrisma.user.create({ data: { companyId, firstName: 'Act', lastName: 'Or', phone: phone() } });
    actor = { id: u.id, companyId, firstName: 'Act', lastName: 'Or', roles: ['CASHIER'], permissions: [] };
    productId = (await systemPrisma.product.create({ data: { companyId, sku: 'AUD-1', name: 'Audit Item', baseUnit: 'dona' } })).id;
    warehouseId = (await systemPrisma.warehouse.create({ data: { companyId, name: 'Audit WH' } })).id;
    const { customer } = await tenantPrisma.run(companyId, () => customers.create({ code: `AUD-${randomUUID().slice(0, 8)}`, name: 'Audit Customer' }, actor));
    customerId = (customer as { id: string }).id;
    await tenantPrisma.run(companyId, () => stock.receive({ productId, warehouseId, qty: 100 }, actor));
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  const newPayment = (amount: number) => tenantPrisma.run(companyId, () => payments.create({ customerId, amount, method: 'TRANSFER' }, actor));

  it('ADR-060 payment.reverse audit: actor, company, entity, full reason, server createdAt (UTC), traceId; reversal row matches', async () => {
    const p = await newPayment(123456);
    const traceId = `trace-aud-${randomUUID().slice(0, 8)}`;
    const t0 = new Date();
    await runWithTraceId(traceId, () => tenantPrisma.run(companyId, () => payments.reverse(p.id, LONG_REASON, actor)));
    const t1 = new Date();

    const audits = await systemPrisma.auditLog.findMany({ where: { companyId, action: 'payment.reverse', entityId: p.id } });
    expect(audits).toHaveLength(1);
    const a = audits[0]!;
    expect(a).toMatchObject({ userId: actor.id, companyId, action: 'payment.reverse', entity: 'Payment', entityId: p.id, traceId });
    expect((a.newValue as { reason: string }).reason).toBe(LONG_REASON); // unclipped
    expect((a.newValue as { status: string }).status).toBe('REVERSED');
    expect(a.createdAt.getTime()).toBeGreaterThanOrEqual(t0.getTime() - 1000);
    expect(a.createdAt.getTime()).toBeLessThanOrEqual(t1.getTime() + 1000);
    // stored as timestamp without tz in UTC: raw value read back as UTC equals the Date instant
    const raw = await systemPrisma.$queryRaw<{ iso: string }[]>`SELECT to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS iso FROM "AuditLog" WHERE id = ${a.id}::uuid`;
    expect(raw[0]!.iso).toBe(a.createdAt.toISOString().slice(0, 19));

    const reversal = await systemPrisma.paymentReversal.findUniqueOrThrow({ where: { reversesPaymentId: p.id } });
    expect(reversal).toMatchObject({ companyId, actorId: actor.id, reason: LONG_REASON });
    const pay = await systemPrisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(pay.amount.toString()).toBe('123456');
    expect(pay.status).toBe('REVERSED');
    expect(await systemPrisma.notification.count({ where: { dedupKey: `payment.reverse:${reversal.id}` } })).toBe(1);
  });

  it('ADR-060 stock.adjust audit: entityId is the created ADJUST movement; qty/reason full; server createdAt; traceId', async () => {
    const traceId = `trace-aud-${randomUUID().slice(0, 8)}`;
    const t0 = new Date();
    await runWithTraceId(traceId, () => tenantPrisma.run(companyId, () => stock.adjust({ productId, warehouseId, qty: -6, reason: LONG_REASON }, actor)));
    const t1 = new Date();

    const mv = await systemPrisma.stockMovement.findFirstOrThrow({ where: { companyId, type: 'ADJUST', note: LONG_REASON } });
    const audits = await systemPrisma.auditLog.findMany({ where: { companyId, action: 'stock.adjust', entityId: mv.id } });
    expect(audits).toHaveLength(1);
    const a = audits[0]!;
    expect(a).toMatchObject({ userId: actor.id, companyId, entity: 'StockMovement', entityId: mv.id, traceId });
    expect((a.newValue as { note: string; qty: string }).note).toBe(LONG_REASON);
    expect(Number((a.newValue as { qty: string }).qty)).toBe(-6);
    expect(mv.qty.toString()).toBe('-6');
    expect(mv).toMatchObject({ productId, warehouseId, companyId });
    expect(a.createdAt.getTime()).toBeGreaterThanOrEqual(t0.getTime() - 1000);
    expect(a.createdAt.getTime()).toBeLessThanOrEqual(t1.getTime() + 1000);
    const raw = await systemPrisma.$queryRaw<{ iso: string }[]>`SELECT to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS iso FROM "AuditLog" WHERE id = ${a.id}::uuid`;
    expect(raw[0]!.iso).toBe(a.createdAt.toISOString().slice(0, 19));
    expect(await systemPrisma.notification.count({ where: { dedupKey: `stock.adjust:${mv.id}` } })).toBe(1);
  });

  it('ADR-060 rollback: alert insert failure leaves no audit success row, no reversal/movement, no notification (payment)', async () => {
    const svc = new PaymentsService(tenantPrisma, auditLog, customers, new DocumentNumberingService(), brokenAlerts);
    const p = await newPayment(777);
    const [n0, a0] = [await systemPrisma.notification.count({ where: { companyId } }), await systemPrisma.auditLog.count({ where: { companyId, action: 'payment.reverse' } })];
    await expect(runWithTraceId('trace-aud-rb-pay', () => tenantPrisma.run(companyId, () => svc.reverse(p.id, 'will fail alert', actor)))).rejects.toThrow('notify down');
    expect(await systemPrisma.auditLog.count({ where: { companyId, action: 'payment.reverse', entityId: p.id } })).toBe(0);
    expect(await systemPrisma.auditLog.count({ where: { companyId, action: 'payment.reverse' } })).toBe(a0);
    expect(await systemPrisma.paymentReversal.count({ where: { reversesPaymentId: p.id } })).toBe(0);
    expect((await systemPrisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('POSTED');
    expect(await systemPrisma.notification.count({ where: { companyId } })).toBe(n0);
  });

  it('ADR-060 rollback: alert insert failure leaves no audit success row, no movement, unchanged onHand, no notification (stock)', async () => {
    const svc = new StockService(tenantPrisma, auditLog, brokenAlerts);
    const onHand = async () => (await systemPrisma.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId, warehouseId } } })).onHand.toString();
    const reason = `rollback-${randomUUID()}`;
    const [h0, m0, a0, n0] = [
      await onHand(),
      await systemPrisma.stockMovement.count({ where: { companyId } }),
      await systemPrisma.auditLog.count({ where: { companyId, action: 'stock.adjust' } }),
      await systemPrisma.notification.count({ where: { companyId } }),
    ];
    await expect(runWithTraceId('trace-aud-rb-stock', () => tenantPrisma.run(companyId, () => svc.adjust({ productId, warehouseId, qty: 5, reason }, actor)))).rejects.toThrow('notify down');
    expect(await onHand()).toBe(h0);
    expect(await systemPrisma.stockMovement.count({ where: { companyId } })).toBe(m0);
    expect(await systemPrisma.stockMovement.count({ where: { companyId, note: reason } })).toBe(0);
    expect(await systemPrisma.auditLog.count({ where: { companyId, action: 'stock.adjust' } })).toBe(a0);
    expect(await systemPrisma.notification.count({ where: { companyId } })).toBe(n0);
  });
});
