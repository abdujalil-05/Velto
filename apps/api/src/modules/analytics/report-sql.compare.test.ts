import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { InvoiceStatus, OrderStatus, PaymentStatus, PaymentMethod, Prisma, prisma, systemPrisma, type TenantClient } from '@velto/database';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { AgingReportService, bucketFor, companyDate, daysPastDue } from '../finance/reports/aging-report.service';
import { VALID_ALLOCATION_WHERE, paymentPostedAt } from '../finance/ledger-filters';
import { invoiceDebt, invoiceDebtAsOfMany, orderTotalsInWindow, topProductsInWindow, turnoverPerAgent, turnoverPerDay } from './report-sql';
import { COUNTED_ORDER_STATUSES, DAY_MS, ORDER_AMOUNT_SELECT, localDateString, orderTotal } from './report-utils';

/** Regression: the DB-side aggregation must equal the previous in-memory (findMany + orderTotal) implementation on the same data. */
describe('report-sql == legacy JS aggregation (golden comparison)', () => {
  const tenantPrisma = new TenantPrismaService();
  const tz = 'Asia/Tashkent';
  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('orders, per-day, per-agent, top products, invoice debt', async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `cmp-${Date.now()}-${randomUUID().slice(0, 8)}`, name: 'Cmp' } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Cmp Co' } });
    const companyId = company.id;
    const win = { start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-03-31T23:59:59Z') };

    await tenantPrisma.run(companyId, async (tx) => {
      const agents = await Promise.all(
        [1, 2].map((n) => tx.user.create({ data: { companyId, firstName: `A${n}`, lastName: 'X', phone: `+99890${Math.floor(1_000_000 + Math.random() * 8_000_000)}` } })),
      );
      const wh = await tx.warehouse.create({ data: { companyId, name: 'WH' } });
      const cat = await tx.productCategory.create({ data: { companyId, name: 'C' } });
      const prods = [];
      for (const n of [1, 2]) {
        const p = await tx.product.create({ data: { companyId, categoryId: cat.id, sku: `S${n}-${randomUUID().slice(0, 6)}`, name: `P${n}`, baseUnit: 'dona', vatRate: 12 } });
        const pk = await tx.productPackaging.create({ data: { productId: p.id, name: 'dona', qtyInBaseUnit: 1, isDefault: true } });
        prods.push({ p, pk });
      }
      const custs = [];
      for (const term of [0, 7]) custs.push(await tx.customer.create({ data: { companyId, code: `C-${randomUUID().slice(0, 8)}`, name: 'Cu', paymentTermDays: term } }));

      const statuses = [OrderStatus.SUBMITTED, OrderStatus.CONFIRMED, OrderStatus.DELIVERED, OrderStatus.CLOSED, OrderStatus.DRAFT, OrderStatus.CANCELLED];
      for (let i = 0; i < 36; i += 1) {
        const status = statuses[i % statuses.length]!;
        const day = 1 + (i % 28);
        const createdAt = new Date(Date.UTC(2026, 2, day, i % 2 ? 19 : 3, 30)); // 19:30Z = next local day in Tashkent
        const lines = prods.slice(0, 1 + (i % 2)).map(({ p, pk }, j) => {
          const qty = 3 + j;
          const delivered = i % 3 === 0 ? qty : i % 3 === 1 ? 1 : 0;
          const unitPrice = new Prisma.Decimal('1234.57').plus(i * 111 + j * 7);
          return {
            productId: p.id,
            packagingId: pk.id,
            qty,
            deliveredQty: delivered,
            unitPrice,
            discountPct: i % 4 === 0 ? 7.5 : 0,
            vatRate: 12,
            lineTotal: unitPrice.times(qty).times(i % 4 === 0 ? 0.925 : 1).times(1.12).toDecimalPlaces(2),
          };
        });
        await tx.salesOrder.create({
          data: {
            companyId, number: `SO-CMP-${randomUUID()}`, customerId: custs[i % 2]!.id, agentId: i % 5 === 0 ? null : agents[i % 2]!.id,
            warehouseId: wh.id, status, createdAt,
            ...(status === OrderStatus.CANCELLED ? { cancelReason: 'x', cancelledAt: new Date(), cancelledBy: agents[0]!.id } : {}),
            lines: { create: lines },
          },
        });
      }
      // an order without lines
      await tx.salesOrder.create({ data: { companyId, number: `SO-CMP-${randomUUID()}`, customerId: custs[0]!.id, warehouseId: wh.id, status: OrderStatus.SUBMITTED, createdAt: new Date('2026-03-05T05:00:00Z') } });

      // invoices: OPEN / PARTIALLY_PAID / PAID / CANCELLED, posted + reversed + handover allocations
      const stamp = (days: number) => new Date(Date.now() - days * DAY_MS);
      const mk = async (status: InvoiceStatus, total: string, ageDays: number, customerId: string, alloc?: { amount: string; paidAgo?: number; reverse?: boolean }) => {
        const inv = await tx.invoice.create({ data: { companyId, number: `INV-CMP-${randomUUID().slice(0, 8)}`, customerId, total, status, createdAt: stamp(ageDays) } });
        if (!alloc) return;
        const pay = await tx.payment.create({
          data: { companyId, number: `PAY-CMP-${randomUUID().slice(0, 8)}`, customerId, amount: alloc.amount, method: PaymentMethod.CASH, createdAt: stamp(alloc.paidAgo ?? ageDays - 1) },
        });
        await tx.paymentAllocation.create({ data: { paymentId: pay.id, invoiceId: inv.id, amount: alloc.amount } });
        if (alloc.reverse) {
          await tx.paymentReversal.create({ data: { companyId, reversesPaymentId: pay.id, reason: 't', actorId: agents[0]!.id } });
          await tx.payment.update({ where: { id: pay.id }, data: { status: 'REVERSED' } });
        }
      };
      await mk(InvoiceStatus.OPEN, '500000', 20, custs[0]!.id);
      await mk(InvoiceStatus.PARTIALLY_PAID, '700000.50', 12, custs[1]!.id, { amount: '200000.25' });
      await mk(InvoiceStatus.PARTIALLY_PAID, '300000', 9, custs[1]!.id, { amount: '100000', reverse: true });
      await mk(InvoiceStatus.PARTIALLY_PAID, '400000', 15, custs[0]!.id, { amount: '150000', paidAgo: 0.2 });
      await mk(InvoiceStatus.PAID, '100000', 10, custs[0]!.id, { amount: '100000' });
      await mk(InvoiceStatus.CANCELLED, '900000', 8, custs[0]!.id);
      await mk(InvoiceStatus.OPEN, '50000', 3, custs[1]!.id);
    });

    await tenantPrisma.run(companyId, async (tx) => {
      // ---- legacy reference
      const orders = await tx.salesOrder.findMany({
        where: { createdAt: { gte: win.start, lte: win.end }, status: { in: COUNTED_ORDER_STATUSES } },
        select: { createdAt: true, agentId: true, customerId: true, ...ORDER_AMOUNT_SELECT, lines: { select: { ...ORDER_AMOUNT_SELECT.lines.select, productId: true } } },
      });
      const zero = new Prisma.Decimal(0);
      let turnover = zero;
      const byDay = new Map<string, Prisma.Decimal>();
      const byAgent = new Map<string, { t: Prisma.Decimal; c: number }>();
      const byProd = new Map<string, Prisma.Decimal>();
      for (const o of orders) {
        const a = orderTotal(o);
        turnover = turnover.plus(a);
        const k = localDateString(o.createdAt, tz);
        byDay.set(k, (byDay.get(k) ?? zero).plus(a));
        if (o.agentId) {
          const e = byAgent.get(o.agentId) ?? { t: zero, c: 0 };
          byAgent.set(o.agentId, { t: e.t.plus(a), c: e.c + 1 });
        }
        for (const l of o.lines) {
          const lt = orderTotal({ status: o.status, lines: [l] });
          byProd.set(l.productId, (byProd.get(l.productId) ?? zero).plus(lt));
        }
      }

      // ---- new
      const totals = await orderTotalsInWindow(tx, win.start, win.end);
      expect(totals.turnover.toFixed(2)).toBe(turnover.toFixed(2));
      expect(totals.count).toBe(orders.length);
      expect(totals.activeCustomers).toBe(new Set(orders.map((o) => o.customerId)).size);
      expect(totals.count).toBeGreaterThan(20);

      const newDay = await turnoverPerDay(tx, win.start, win.end, tz);
      expect([...newDay.keys()].sort()).toEqual([...byDay.keys()].sort());
      for (const [k, v] of byDay) expect(newDay.get(k)!.turnover.toFixed(2)).toBe(v.toFixed(2));

      const newAgent = await turnoverPerAgent(tx, win.start, win.end);
      expect(newAgent.length).toBe(byAgent.size);
      for (const r of newAgent) {
        expect(r.turnover.toFixed(2)).toBe(byAgent.get(r.agentId)!.t.toFixed(2));
        expect(r.count).toBe(byAgent.get(r.agentId)!.c);
      }

      const top = await topProductsInWindow(tx, win.start, win.end, 10);
      expect(top.length).toBe(byProd.size);
      for (const r of top) expect(r.turnover.toFixed(2)).toBe(byProd.get(r.productId)!.toFixed(2));

      // ---- debt: legacy overview (open invoices, all valid allocations) and dashboard asOf
      const now = new Date();
      const open = await tx.invoice.findMany({
        where: { status: { in: [InvoiceStatus.OPEN, InvoiceStatus.PARTIALLY_PAID] } },
        include: { allocations: { where: VALID_ALLOCATION_WHERE }, customer: { select: { paymentTermDays: true } } },
      });
      let total = zero;
      let overdue = zero;
      for (const i of open) {
        const out = i.total.minus(i.allocations.reduce((s, a) => s.plus(a.amount), zero));
        if (!out.greaterThan(0)) continue;
        total = total.plus(out);
        if (i.createdAt.getTime() + i.customer.paymentTermDays * DAY_MS < now.getTime()) overdue = overdue.plus(out);
      }
      const d = await invoiceDebt(tx, { kind: 'open', now });
      expect(d.total.toFixed(2)).toBe(total.toFixed(2));
      expect(d.overdue.toFixed(2)).toBe(overdue.toFixed(2));
      expect(total.greaterThan(0)).toBe(true);

      for (const asOf of [now, new Date(now.getTime() - DAY_MS)]) {
        const all = await legacyOverdueAsOf(tx, asOf);
        const n = await invoiceDebt(tx, { kind: 'asOf', asOf });
        expect(n.overdue.toFixed(2)).toBe(all.toFixed(2));
      }
      // one-scan multi-point variant == the single-point query, per point
      const points = [now, new Date(now.getTime() - DAY_MS), new Date(now.getTime() - 5 * DAY_MS)];
      const many = await invoiceDebtAsOfMany(tx, points);
      for (const [k, asOf] of points.entries()) {
        const single = await invoiceDebt(tx, { kind: 'asOf', asOf });
        expect(many[k]!.total.toFixed(2)).toBe(single.total.toFixed(2));
        expect(many[k]!.overdue.toFixed(2)).toBe(single.overdue.toFixed(2));
      }
    });

    // ---- aging: legacy findMany implementation vs SQL, today and a past asOf
    for (const back of [0, 4, 11]) {
      const asOf = companyDate(new Date(Date.now() - back * DAY_MS), tz);
      const { rows } = await tenantPrisma.run(companyId, async (tx) => {
        const legacy = await legacyAging(tx, asOf, tz);
        const svc = new AgingReportService(tenantPrisma);
        return { rows: { legacy, now: (await svc.getAllRows(asOf)).rows } };
      }).then((r) => ({ rows: r.rows }));
      expect(rows.now.length).toBe(rows.legacy.length);
      expect(rows.legacy.length).toBeGreaterThan(0);
      rows.legacy.forEach((l, i) => {
        const n = rows.now[i]!;
        expect(n.customerId).toBe(l.customerId);
        expect(n.total.toFixed(2)).toBe(l.total.toFixed(2));
        for (const k of ['current', 'd1to7', 'd8to30', 'd31to60', 'd60plus'] as const) expect(n.buckets[k].toFixed(2)).toBe(l.buckets[k].toFixed(2));
      });
    }
  });
});

async function legacyOverdueAsOf(tx: TenantClient, asOf: Date) {
  const invoices = await tx.invoice.findMany({
    where: { createdAt: { lte: asOf }, status: { not: InvoiceStatus.CANCELLED } },
    include: { allocations: { where: VALID_ALLOCATION_WHERE, include: { payment: { select: { createdAt: true, handoverAt: true } } } }, customer: { select: { paymentTermDays: true } } },
  });
  let t = new Prisma.Decimal(0);
  for (const i of invoices) {
    const alloc = i.allocations.filter((a) => paymentPostedAt(a.payment) <= asOf).reduce((s, a) => s.plus(a.amount), new Prisma.Decimal(0));
    const out = i.total.minus(alloc);
    if (!out.greaterThan(0)) continue;
    if (i.createdAt.getTime() + i.customer.paymentTermDays * DAY_MS < asOf.getTime()) t = t.plus(out);
  }
  return t;
}

async function legacyAging(tx: TenantClient, asOf: string, timeZone: string) {
  const invoices = await tx.invoice.findMany({
    where: { status: { not: InvoiceStatus.CANCELLED } },
    include: { allocations: { include: { payment: { select: { status: true, reversal: { select: { createdAt: true } } } } } }, customer: { select: { id: true, name: true, paymentTermDays: true } } },
  });
  const by = new Map<string, { customerId: string; name: string; total: Prisma.Decimal; buckets: Record<string, Prisma.Decimal> }>();
  for (const inv of invoices) {
    if (companyDate(inv.createdAt, timeZone) > asOf) continue;
    const allocated = inv.allocations.reduce((sum, a) => {
      if (companyDate(a.createdAt, timeZone) > asOf) return sum;
      if (a.payment.status === PaymentStatus.REVERSED && (!a.payment.reversal || companyDate(a.payment.reversal.createdAt, timeZone) <= asOf)) return sum;
      return sum.plus(a.amount);
    }, new Prisma.Decimal(0));
    const out = inv.total.minus(allocated);
    if (!out.greaterThan(0)) continue;
    const e = by.get(inv.customerId) ?? { customerId: inv.customerId, name: inv.customer.name, total: new Prisma.Decimal(0), buckets: { current: new Prisma.Decimal(0), d1to7: new Prisma.Decimal(0), d8to30: new Prisma.Decimal(0), d31to60: new Prisma.Decimal(0), d60plus: new Prisma.Decimal(0) } };
    const b = bucketFor(daysPastDue(inv.createdAt, inv.customer.paymentTermDays, asOf, timeZone));
    e.buckets[b] = e.buckets[b]!.plus(out);
    e.total = e.total.plus(out);
    by.set(inv.customerId, e);
  }
  return [...by.values()].sort((a, b) => b.total.comparedTo(a.total) || a.name.localeCompare(b.name) || a.customerId.localeCompare(b.customerId));
}
