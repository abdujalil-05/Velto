import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import { prisma, systemPrisma, type TenantClient } from '@velto/database';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { PaymentsService } from '../src/modules/finance/payments/payments.service';
import { orderTotalsInWindow, turnoverPerDay } from '../src/modules/analytics/report-sql';
import { uniquePhone } from './unique-phone';

/**
 * TZ §6.6 (1 order = 1 SALE invoice) + turnover rule (PO 2026-11-01): app/API-level
 * proof of migration 20261102100000_invoice_sale_order_integrity on real Postgres + RLS
 * as velto_app, through the real Nest pipeline. DB-level cases live in
 * packages/database/src/__tests__/invoice-integrity.test.ts.
 */
const PASSWORD = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
const PERMS = [
  ['orders', 'create'], ['orders', 'read'], ['orders', 'update'], ['orders', 'deliver'],
  ['payments', 'create'], ['payments', 'read'], ['payments', 'allocate'], ['customers', 'read'],
] as const;

describe('SALE invoice integrity at API level (real Postgres + RLS, velto_app)', () => {
  let app: INestApplication;
  let tenantPrisma: TenantPrismaService;
  let payments: PaymentsService;
  const http = () => request(app.getHttpServer());

  type Co = { companyId: string; token: string; userId: string; customerId: string; productId: string; packagingId: string; warehouseId: string };
  async function seed(label: string): Promise<Co> {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-sinv-${label}-${Date.now()}-${randomUUID().slice(0, 6)}`, name: `SaleInv ${label}` } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `SaleInv Co ${label}` } });
    const companyId = company.id;
    const perms = await Promise.all(PERMS.map(([module, code]) => systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } })));
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({ data: { companyId, firstName: 'S', lastName: label, phone, passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }) } });
    const ids = await tenantPrisma.run(companyId, async (tx) => {
      const role = await tx.role.create({ data: { companyId, code: 'SINV_OP', name: 'Op' } });
      await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
      const warehouse = await tx.warehouse.create({ data: { companyId, name: 'WH' } });
      const product = await tx.product.create({ data: { companyId, sku: `SI-${randomUUID().slice(0, 8)}`, name: 'P', baseUnit: 'dona', vatRate: '0' } });
      const packaging = await tx.productPackaging.create({ data: { productId: product.id, name: 'dona', qtyInBaseUnit: '1', isDefault: true } });
      const pl = await tx.priceList.create({ data: { companyId, name: 'PL', isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: pl.id, productId: product.id, price: '1000.00' } });
      await tx.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, onHand: '1000', reserved: '0' } });
      const customer = await tx.customer.create({ data: { companyId, code: `SI-${randomUUID().slice(0, 8)}`, name: 'Cu' } });
      return { customerId: customer.id, productId: product.id, packagingId: packaging.id, warehouseId: warehouse.id };
    });
    const login = await http().post('/auth/login').send({ phone, password: PASSWORD }).expect(201);
    return { companyId, token: login.body.accessToken, userId: user.id, ...ids };
  }

  const auth = (c: Co) => ({ Authorization: `Bearer ${c.token}` });
  async function confirmedOrder(c: Co, qty = 5) {
    const o = await http().post('/orders').set(auth(c)).send({ customerId: c.customerId, lines: [{ productId: c.productId, packagingId: c.packagingId, qty }] }).expect(201);
    await http().post(`/orders/${o.body.id}/confirm`).set(auth(c)).expect(201);
    return o.body.id as string;
  }
  const inTenant = <T>(c: Co, fn: (tx: TenantClient) => Promise<T>) => tenantPrisma.run(c.companyId, fn);
  const saleInvoices = (c: Co, orderId: string) => inTenant(c, (tx) => tx.invoice.findMany({ where: { orderId, kind: 'SALE' } }));
  const issues = (c: Co, orderId: string) => inTenant(c, (tx) => tx.stockMovement.count({ where: { refId: orderId, type: 'ISSUE' } }));
  const movements = (c: Co, orderId: string) => inTenant(c, (tx) => tx.stockMovement.count({ where: { refId: orderId } }));
  const level = (c: Co) => inTenant(c, async (tx) => {
    const l = await tx.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: c.productId, warehouseId: c.warehouseId } } });
    return { onHand: l.onHand.toString(), reserved: l.reserved.toString() };
  });
  const status = (c: Co, orderId: string) => inTenant(c, async (tx) => (await tx.salesOrder.findUniqueOrThrow({ where: { id: orderId } })).status);

  let A: Co;
  let B: Co;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.listen(0, '127.0.0.1');
    tenantPrisma = app.get(TenantPrismaService);
    payments = app.get(PaymentsService);
    A = await seed('a');
    B = await seed('b');
  });
  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('(1) §6.6: one delivery creates exactly one SALE invoice with the order snapshot total', async () => {
    const id = await confirmedOrder(A, 5);
    const res = await http().post(`/orders/${id}/deliver`).set(auth(A)).expect(201);
    expect(res.body.status).toBe('DELIVERED');
    const inv = await saleInvoices(A, id);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.total.toFixed(2)).toBe('5000.00');
    expect(await issues(A, id)).toBe(1);
  });

  it('(2) §10.5/§6.6: two concurrent HTTP deliver() -> one 201, other 4xx domain error (no 500), one invoice, stock issued once', async () => {
    const id = await confirmedOrder(A, 7);
    const before = await level(A);
    const res = await Promise.all([0, 1].map(() => http().post(`/orders/${id}/deliver`).set(auth(A))));
    const codes = res.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    const loser = res.find((r) => r.status !== 201)!;
    expect(loser.status).toBeGreaterThanOrEqual(400);
    expect(loser.status).toBeLessThan(500);
    expect(loser.body.code).toBeTruthy();
    expect(await saleInvoices(A, id)).toHaveLength(1);
    expect(await issues(A, id)).toBe(1);
    const after = await level(A);
    expect(Number(before.onHand) - Number(after.onHand)).toBe(7);
  });

  it('(3) §16.3: deliver is @Idempotent — same Idempotency-Key replays the stored result: no duplicate invoice/issue; a plain retry is a domain error', async () => {
    const id = await confirmedOrder(A, 3);
    const key = randomUUID();
    const first = await http().post(`/orders/${id}/deliver`).set(auth(A)).set('Idempotency-Key', key).expect(201);
    const replay = await http().post(`/orders/${id}/deliver`).set(auth(A)).set('Idempotency-Key', key);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(await saleInvoices(A, id)).toHaveLength(1);
    expect(await issues(A, id)).toBe(1);
    const plain = await http().post(`/orders/${id}/deliver`).set(auth(A));
    expect(plain.status).toBeGreaterThanOrEqual(400);
    expect(plain.status).toBeLessThan(500);
    expect(await saleInvoices(A, id)).toHaveLength(1);
  });

  it('(4) deliver on DELIVERED and on CLOSED order is rejected; no second invoice, no extra stock movement', async () => {
    const id = await confirmedOrder(A, 2);
    await http().post(`/orders/${id}/deliver`).set(auth(A)).expect(201);
    const mv = await movements(A, id);
    const again = await http().post(`/orders/${id}/deliver`).set(auth(A));
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.status).toBeLessThan(500);
    await http().post(`/orders/${id}/close`).set(auth(A)).expect(201);
    expect(await status(A, id)).toBe('CLOSED');
    const closed = await http().post(`/orders/${id}/deliver`).set(auth(A));
    expect(closed.status).toBeGreaterThanOrEqual(400);
    expect(closed.status).toBeLessThan(500);
    expect(await saleInvoices(A, id)).toHaveLength(1);
    expect(await movements(A, id)).toBe(mv);
    expect(await status(A, id)).toBe('CLOSED');
  });

  it('(5) invoice insert failure (pre-existing SALE invoice hits the unique index) rolls back the whole delivery', async () => {
    const id = await confirmedOrder(A, 4);
    const levelBefore = await level(A);
    const mvBefore = await movements(A, id);
    const invCountBefore = await inTenant(A, (tx) => tx.invoice.count({ where: { companyId: A.companyId } }));
    await inTenant(A, (tx) => tx.invoice.create({ data: { companyId: A.companyId, number: `INV-PRE-${randomUUID().slice(0, 8)}`, customerId: A.customerId, orderId: id, total: '1.00', status: 'OPEN', kind: 'SALE' } }));
    const res = await http().post(`/orders/${id}/deliver`).set(auth(A));
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'ORDER_ALREADY_INVOICED' });
    expect(await status(A, id)).toBe('CONFIRMED');
    expect(await movements(A, id)).toBe(mvBefore);
    expect(await level(A)).toEqual(levelBefore);
    expect(await inTenant(A, (tx) => tx.invoice.count({ where: { companyId: A.companyId } }))).toBe(invCountBefore + 1); // only the pre-inserted one
    expect(await inTenant(A, (tx) => tx.salesOrderLine.count({ where: { orderId: id, deliveredQty: { gt: 0 } } }))).toBe(0);
  });

  it('(6) velto_app cannot change SALE invoice createdAt/total (ORM and raw SQL); status stays updatable', async () => {
    const id = await confirmedOrder(A, 1);
    await http().post(`/orders/${id}/deliver`).set(auth(A)).expect(201);
    const [inv] = await saleInvoices(A, id);
    await expect(inTenant(A, (tx) => tx.invoice.update({ where: { id: inv!.id }, data: { createdAt: new Date('2020-01-01') } }))).rejects.toThrow();
    await expect(inTenant(A, (tx) => tx.invoice.update({ where: { id: inv!.id }, data: { total: '999999.00' } }))).rejects.toThrow();
    await expect(inTenant(A, (tx) => tx.$executeRaw`UPDATE "Invoice" SET "createdAt" = now() - interval '40 days' WHERE id = ${inv!.id}::uuid`)).rejects.toThrow();
    await expect(inTenant(A, (tx) => tx.$executeRaw`UPDATE "Invoice" SET "total" = 1 WHERE id = ${inv!.id}::uuid`)).rejects.toThrow();
    const [after] = await saleInvoices(A, id);
    expect(after!.createdAt.getTime()).toBe(inv!.createdAt.getTime());
    expect(after!.total.toString()).toBe(inv!.total.toString());
    await inTenant(A, (tx) => tx.invoice.update({ where: { id: inv!.id }, data: { status: 'CANCELLED' } }));
    expect((await saleInvoices(A, id))[0]!.status).toBe('CANCELLED');
  });

  it('(7) SEC cross-tenant: company B cannot see or deliver company A order/invoice', async () => {
    const id = await confirmedOrder(A, 2);
    const get = await http().get(`/orders/${id}`).set(auth(B));
    expect(get.status).toBe(404);
    const del = await http().post(`/orders/${id}/deliver`).set(auth(B));
    expect(del.status).toBe(404);
    expect(await status(A, id)).toBe('CONFIRMED');
    expect(await saleInvoices(A, id)).toHaveLength(0);
    await http().post(`/orders/${id}/deliver`).set(auth(A)).expect(201);
    const [inv] = await saleInvoices(A, id);
    expect(await inTenant(B, (tx) => tx.invoice.findMany({ where: { id: inv!.id } }))).toHaveLength(0);
    await expect(inTenant(B, (tx) => tx.invoice.update({ where: { id: inv!.id }, data: { status: 'CANCELLED' } }))).rejects.toThrow();
    expect((await saleInvoices(A, id))[0]!.status).toBe('OPEN');
  });

  it('(8) turnover is fixed at delivery: payment + allocation, reversal, invoice status change and CLOSE do not change it', async () => {
    const C = await seed('turn');
    const start = new Date(Date.now() - 86_400_000);
    const end = new Date(Date.now() + 86_400_000);
    const snap = () => inTenant(C, async (tx) => {
      const t = await orderTotalsInWindow(tx, start, end);
      const days = await turnoverPerDay(tx, start, end, 'Asia/Tashkent');
      return { turnover: t.turnover.toFixed(2), count: t.deliveredOrderCount, customers: t.activeCustomers, days: [...days].map(([d, v]) => [d, v.turnover.toFixed(2), v.deliveredOrderCount]) };
    });
    const id = await confirmedOrder(C, 10);
    expect(await snap()).toMatchObject({ turnover: '0.00', count: 0 });
    await http().post(`/orders/${id}/deliver`).set(auth(C)).expect(201);
    const base = await snap();
    expect(base).toMatchObject({ turnover: '10000.00', count: 1 });
    const [inv0] = await saleInvoices(C, id);

    const pay = await http().post('/payments').set(auth(C)).send({ customerId: C.customerId, amount: 4000, method: 'CASH' }).expect(201);
    expect(await snap()).toEqual(base);
    const over = await http().post('/payments').set(auth(C)).send({ customerId: C.customerId, amount: 20000, method: 'CASH' }).expect(201);
    expect(await snap()).toEqual(base);
    const user = { id: C.userId, companyId: C.companyId, firstName: 'S', lastName: 'x', roles: ['OWNER'], permissions: ['payments.create', 'payments.reverse'] };
    await inTenant(C, () => payments.reverse(pay.body.id, 'qa reversal', user as never));
    expect(await snap()).toEqual(base);
    await inTenant(C, () => payments.reverse(over.body.id, 'qa reversal', user as never));
    expect(await snap()).toEqual(base);
    await inTenant(C, (tx) => tx.invoice.update({ where: { id: inv0!.id }, data: { status: 'PAID' } }));
    expect(await snap()).toEqual(base);
    await http().post(`/orders/${id}/close`).set(auth(C)).expect(201);
    expect(await snap()).toEqual(base);
    const [inv1] = await saleInvoices(C, id);
    expect(inv1!.createdAt.getTime()).toBe(inv0!.createdAt.getTime());
    expect(inv1!.total.toString()).toBe(inv0!.total.toString());
  });
});
