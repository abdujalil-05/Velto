import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { prisma, systemPrisma } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { FakeBullQueue } from '../../common/queue/fake-bull-queue';
import { installBigIntJson } from '../../common/serialization/bigint-json';
import { runWithTraceId } from '../../common/trace/trace-context';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../customers/customers.service';
import { PaymentsService } from '../finance/payments/payments.service';
import { StockController } from '../stock/stock.controller';
import { StockService } from '../stock/stock.service';
import type { NotificationDeliveryJobData } from './notification-delivery.constants';
import { NotificationsService } from './notifications.service';
import { OwnerAlertsService, formatTashkent } from './owner-alerts';

installBigIntJson(); // app.module.ts does this at boot; the interceptor JSON-serializes StockLevel.changeSeq (bigint)
const phone = () => `+99897${Math.floor(1e6 + Math.random() * 8e6)}`;

describe('OWNER alerts for critical operations (ADR-060a, real Postgres + RLS)', () => {
  const tenantPrisma = new TenantPrismaService();
  const auditLog = new AuditLogService();
  const queue = new FakeBullQueue();
  const notifications = new NotificationsService(tenantPrisma, new ConfigService(), queue.asQueue<NotificationDeliveryJobData>());
  const alerts = new OwnerAlertsService(notifications);
  const stock = new StockService(tenantPrisma, auditLog, alerts);
  const customers = new CustomersService(tenantPrisma, auditLog);
  const payments = new PaymentsService(tenantPrisma, auditLog, customers, new DocumentNumberingService(), alerts);

  let companyId: string;
  let otherCompanyId: string;
  let actor: AuthenticatedUser;
  let ownerLinked: string;
  let ownerUnlinked: string;
  let ownerInactive: string;
  let formerOwner: string;
  let otherOwner: string;
  let productId: string;
  let warehouseId: string;

  beforeAll(async () => {
    const mk = async (label: string) => {
      const tenant = await systemPrisma.tenant.create({ data: { slug: `test-oa-${label}-${randomUUID().slice(0, 8)}`, name: `OA ${label}` } });
      return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `OA Co ${label}` } })).id;
    };
    companyId = await mk('a');
    otherCompanyId = await mk('b');
    const ownerRole = await systemPrisma.role.create({ data: { companyId, name: 'Owner', code: 'OWNER', isSystem: true } });
    const otherOwnerRole = await systemPrisma.role.create({ data: { companyId: otherCompanyId, name: 'Owner', code: 'OWNER', isSystem: true } });
    const cashierRole = await systemPrisma.role.create({ data: { companyId, name: 'Cashier', code: 'CASHIER', isSystem: true } });
    const mkUser = async (cid: string, label: string, opts: { telegramId?: bigint; isActive?: boolean; roleIds?: string[] } = {}) => {
      const u = await systemPrisma.user.create({ data: { companyId: cid, firstName: label, lastName: 'Zed', phone: phone(), telegramId: opts.telegramId, isActive: opts.isActive ?? true } });
      for (const roleId of opts.roleIds ?? []) await systemPrisma.userRole.create({ data: { userId: u.id, roleId } });
      return u.id;
    };
    ownerLinked = await mkUser(companyId, 'OwnerLinked', { telegramId: BigInt(2_000_001), roleIds: [ownerRole.id] });
    ownerUnlinked = await mkUser(companyId, 'OwnerUnlinked', { roleIds: [ownerRole.id] });
    ownerInactive = await mkUser(companyId, 'OwnerInactive', { telegramId: BigInt(2_000_002), isActive: false, roleIds: [ownerRole.id] });
    formerOwner = await mkUser(companyId, 'Former', { telegramId: BigInt(2_000_003), roleIds: [ownerRole.id] });
    await systemPrisma.userRole.delete({ where: { userId_roleId: { userId: formerOwner, roleId: ownerRole.id } } });
    otherOwner = await mkUser(otherCompanyId, 'OtherOwner', { telegramId: BigInt(2_000_004), roleIds: [otherOwnerRole.id] });
    const actorId = await mkUser(companyId, 'Cash', { roleIds: [cashierRole.id] });
    actor = { id: actorId, companyId, firstName: 'Cash', lastName: 'Zed', roles: ['CASHIER'], permissions: [] };

    productId = (await systemPrisma.product.create({ data: { companyId, sku: 'OA-SKU-1', name: 'Alert Cola', baseUnit: 'dona' } })).id;
    warehouseId = (await systemPrisma.warehouse.create({ data: { companyId, name: 'Main WH' } })).id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  const countAll = () => systemPrisma.notification.count({ where: { companyId } });
  const onHand = async () => (await systemPrisma.stockLevel.findUnique({ where: { productId_warehouseId: { productId, warehouseId } } }))?.onHand.toString() ?? '0';

  async function newPayment(amount = 1500000) {
    const { customer } = await tenantPrisma.run(companyId, () => customers.create({ code: `OA-${randomUUID().slice(0, 8)}`, name: 'Alert Customer' }, actor));
    const customerId = (customer as { id: string }).id;
    return tenantPrisma.run(companyId, () => payments.create({ customerId, amount, method: 'TRANSFER' }, actor));
  }

  it('formatTashkent renders Asia/Tashkent (UTC+5) wall time', () => {
    expect(formatTashkent(new Date('2026-10-31T10:05:00Z'))).toBe('2026-10-31 15:05');
  });

  describe('payment reversal', () => {
    it('creates one trilingual alert per active OWNER of the company only; never for inactive/former/foreign owners', async () => {
      const p = await newPayment();
      await runWithTraceId('trace-oa-payment-1', () => tenantPrisma.run(companyId, () => payments.reverse(p.id, 'wrong customer', actor)));
      const reversal = await systemPrisma.paymentReversal.findUniqueOrThrow({ where: { reversesPaymentId: p.id } });
      const rows = await systemPrisma.notification.findMany({ where: { dedupKey: `payment.reverse:${reversal.id}` } });
      expect(rows.map((r) => r.recipientId).sort()).toEqual([ownerLinked, ownerUnlinked].sort());
      const linked = rows.find((r) => r.recipientId === ownerLinked)!;
      const unlinked = rows.find((r) => r.recipientId === ownerUnlinked)!;
      expect(linked.telegramStatus).toBe('PENDING');
      expect(unlinked.telegramStatus).toBe('SKIPPED');
      expect(unlinked.telegramLastError).toBe('TELEGRAM_NOT_LINKED');
      expect(linked).toMatchObject({ type: 'payment.reversed', entityType: 'Payment', entityId: p.id, companyId });
      for (const lang of ['uz', 'ru', 'en'] as const) {
        const msg = (linked.message as Record<string, string>)[lang]!;
        expect(msg).toContain('1500000.00 UZS');
        expect(msg).toContain(p.number);
        expect(msg).toContain('Cash Zed');
        expect(msg).toContain('wrong customer');
        expect(msg).toContain('REVERSED');
        expect(msg).not.toMatch(/\+998/);
        expect((linked.title as Record<string, string>)[lang]).toBeTruthy();
      }
      expect(queue.jobs.has(linked.id)).toBe(true); // enqueued after commit by notification id
      expect(queue.jobs.has(unlinked.id)).toBe(false);
      const audit = await systemPrisma.auditLog.findFirstOrThrow({ where: { companyId, action: 'payment.reverse', entityId: p.id } });
      expect(audit).toMatchObject({ userId: actor.id, companyId, traceId: 'trace-oa-payment-1' });
      expect(JSON.stringify(audit.newValue)).toContain('wrong customer');
    });

    it('a failing reversal (short reason / already reversed) leaves no alert', async () => {
      const p = await newPayment();
      const before = await countAll();
      await expect(tenantPrisma.run(companyId, () => payments.reverse(p.id, 'x', actor))).rejects.toThrow();
      expect(await countAll()).toBe(before);
      await tenantPrisma.run(companyId, () => payments.reverse(p.id, 'first reversal', actor));
      const afterOk = await countAll();
      await expect(tenantPrisma.run(companyId, () => payments.reverse(p.id, 'second try', actor))).rejects.toThrow();
      expect(await countAll()).toBe(afterOk);
    });

    it('forced rollback after the alert insert leaves no reversal, notification or audit', async () => {
      const p = await newPayment();
      const before = await countAll();
      await expect(
        tenantPrisma.run(companyId, async () => {
          await payments.reverse(p.id, 'will be rolled back', actor);
          throw new Error('boom after alert');
        }),
      ).rejects.toThrow('boom after alert');
      expect(await countAll()).toBe(before);
      expect(await systemPrisma.paymentReversal.count({ where: { reversesPaymentId: p.id } })).toBe(0);
      expect(await systemPrisma.auditLog.count({ where: { companyId, action: 'payment.reverse', entityId: p.id } })).toBe(0);
      expect((await systemPrisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('POSTED');
      expect(queue.jobs.size).toBeGreaterThan(0); // earlier test's jobs only; nothing for the rolled back row
    });

    it('if the alert insert itself fails, the whole reversal rolls back', async () => {
      const broken = new OwnerAlertsService({ notifyMany: async () => { throw new Error('notify down'); } } as unknown as NotificationsService);
      const svc = new PaymentsService(tenantPrisma, auditLog, customers, new DocumentNumberingService(), broken);
      const p = await newPayment();
      await expect(tenantPrisma.run(companyId, () => svc.reverse(p.id, 'alert fails', actor))).rejects.toThrow('notify down');
      expect((await systemPrisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('POSTED');
      expect(await systemPrisma.paymentReversal.count({ where: { reversesPaymentId: p.id } })).toBe(0);
    });
  });

  describe('stock', () => {
    it('adjust alerts OWNERs with product/warehouse/signed delta/unit/actor/reason; receive and reserve/release do not', async () => {
      const before = await countAll();
      await tenantPrisma.run(companyId, () => stock.receive({ productId, warehouseId, qty: 100 } as never, actor));
      await tenantPrisma.run(companyId, (tx) => stock.reserve(tx, { companyId, productId, warehouseId, qty: 5, refType: 'SalesOrder', refId: randomUUID() }));
      expect(await countAll()).toBe(before);

      await runWithTraceId('trace-oa-stock-1', () => tenantPrisma.run(companyId, () => stock.adjust({ productId, warehouseId, qty: -7, reason: 'broken pallet' }, actor)));
      const mv = await systemPrisma.stockMovement.findFirstOrThrow({ where: { companyId, type: 'ADJUST', productId }, orderBy: { createdAt: 'desc' } });
      const rows = await systemPrisma.notification.findMany({ where: { dedupKey: `stock.adjust:${mv.id}` } });
      expect(rows.map((r) => r.recipientId).sort()).toEqual([ownerLinked, ownerUnlinked].sort());
      const msg = (rows[0]!.message as Record<string, string>).en!;
      for (const part of ['Alert Cola (OA-SKU-1)', 'Main WH', '-7 dona', 'Cash Zed', 'broken pallet']) expect(msg).toContain(part);
      expect(rows[0]).toMatchObject({ type: 'stock.adjusted', entityType: 'StockMovement', entityId: mv.id });
      const audit = await systemPrisma.auditLog.findFirstOrThrow({ where: { companyId, action: 'stock.adjust', entityId: mv.id } });
      expect(audit).toMatchObject({ userId: actor.id, traceId: 'trace-oa-stock-1' });
    });

    it('reverseMovement alerts with the compensating (positive) delta', async () => {
      await tenantPrisma.run(companyId, () => stock.adjust({ productId, warehouseId, qty: 10, reason: 'found stock' }, actor));
      const orig = await systemPrisma.stockMovement.findFirstOrThrow({ where: { companyId, type: 'ADJUST', productId, qty: 10 }, orderBy: { createdAt: 'desc' } });
      // reversing +10 means -10 on hand; qty is available (>= reserved)
      const res = await tenantPrisma.run(companyId, () => stock.reverseMovement(orig.id, 'counted wrong', actor));
      const rows = await systemPrisma.notification.findMany({ where: { dedupKey: `stock.reverse:${res.movement.id}` } });
      expect(rows).toHaveLength(2);
      expect((rows[0]!.message as Record<string, string>).uz).toContain('-10 dona');
      expect(rows[0]!.type).toBe('stock.reversed');
    });

    it('forced rollback after the stock alert leaves no movement, notification or audit; failing alert insert rolls back the adjustment', async () => {
      const [h0, n0, m0] = [await onHand(), await countAll(), await systemPrisma.stockMovement.count({ where: { companyId } })];
      await expect(
        tenantPrisma.run(companyId, async () => {
          await stock.adjust({ productId, warehouseId, qty: 3, reason: 'rolled back' }, actor);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const broken = new StockService(tenantPrisma, auditLog, new OwnerAlertsService({ notifyMany: async () => { throw new Error('notify down'); } } as unknown as NotificationsService));
      await expect(tenantPrisma.run(companyId, () => broken.adjust({ productId, warehouseId, qty: 3, reason: 'alert fails' }, actor))).rejects.toThrow('notify down');
      expect(await onHand()).toBe(h0);
      expect(await countAll()).toBe(n0);
      expect(await systemPrisma.stockMovement.count({ where: { companyId } })).toBe(m0);
      expect(await systemPrisma.auditLog.count({ where: { companyId, action: 'stock.adjust', newValue: { path: ['note'], string_contains: 'rolled back' } } })).toBe(0);
    });

    it('POST /stock/adjust carries the Idempotency interceptor; the same key twice -> one movement, one notification set', async () => {
      const interceptors = Reflect.getMetadata('__interceptors__', StockController.prototype.adjust) as unknown[];
      expect(interceptors).toContain(IdempotencyInterceptor);

      const interceptor = new IdempotencyInterceptor();
      const body = { productId, warehouseId, qty: 2, reason: 'idem adjust' };
      const key = `idem-${randomUUID()}`;
      const call = () => {
        const res = { statusCode: 0, status(c: number) { this.statusCode = c; return this; } };
        const req = { method: 'POST', originalUrl: '/stock/adjust', headers: { 'idempotency-key': key }, body, user: actor };
        const ctx = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }), getHandler: () => StockController.prototype.adjust } as unknown as ExecutionContext;
        return tenantPrisma.run(companyId, async () => {
          return new Promise<unknown>((resolve, reject) =>
            interceptor.intercept(ctx, { handle: () => ({ subscribe: (o: { next: (v: unknown) => void; error: (e: unknown) => void }) => void stock.adjust(body, actor).then(o.next, o.error) }) as never }).subscribe({ next: resolve, error: reject }),
          );
        });
      };
      const m0 = await systemPrisma.stockMovement.count({ where: { companyId, note: 'idem adjust' } });
      const n0 = await countAll();
      await call();
      const n1 = await countAll();
      await call();
      expect(await systemPrisma.stockMovement.count({ where: { companyId, note: 'idem adjust' } })).toBe(m0 + 1);
      expect(n1 - n0).toBe(2);
      expect(await countAll()).toBe(n1);
    });
  });

  it('OWNER of another company gets nothing; sweep data keeps the row companyId', async () => {
    expect(await systemPrisma.notification.count({ where: { recipientId: otherOwner } })).toBe(0);
    expect(await systemPrisma.notification.count({ where: { recipientId: { in: [ownerInactive, formerOwner] } } })).toBe(0);
  });
});
