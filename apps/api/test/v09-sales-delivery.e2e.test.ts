import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import { Prisma, prisma, systemPrisma } from '@velto/database';
import { permissionKeysForRole } from '../../../packages/database/src/rbac-catalog';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { uniquePhone } from './unique-phone';
import { loginWithMfa } from './mfa-login';

/**
 * v0.9 sales -> delivery -> money E2E over real HTTP, real Postgres + RLS, all 7 system roles, two tenants.
 * Flow: agent /sync/push order -> director confirm (reserve) -> warehouse assign-courier (SHIPPED, no ISSUE/Invoice)
 * -> courier deliver -> Invoice + ISSUE only now -> agent payment (PENDING_HANDOVER) -> cashier accept -> balance/reports.
 * TZ §6.3-6.6 (order/stock/invoice/payment), §8.5 (offline idempotency, price conflict), §16.1/16.3 (P0, RBAC, isolation).
 */
describe('E2E v0.9 sales -> delivery -> payment (7 roles, 2 tenants)', () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });
  let app: INestApplication;
  const tp = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const http = () => request(app.getHttpServer());
  const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

  const ROLES = ['OWNER', 'SALES_DIRECTOR', 'SALES_AGENT', 'WAREHOUSE', 'COURIER', 'CASHIER', 'ACCOUNTANT'] as const;
  type RoleCode = (typeof ROLES)[number];
  interface Actor { token: string; userId: string }
  interface Prod { id: string; packagingId: string }
  interface Co {
    id: string;
    roles: Record<string, string>;
    a: Record<RoleCode, Actor>;
    courier2: Actor;
    P: Prod; // 1000 in stock @ 10000, VAT 12
    LOW: Prod; // 5 in stock
    STALE: Prod; // price mutated by scenario 8
    wh: string;
  }
  let A: Co;
  let B: Co;
  const UNIT = '10000.00';
  const LINE_10 = '112000.00'; // 10 x 10000 x 1.12

  const bearer = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });
  const post = (path: string, a: Actor, body: object = {}, key: string = randomUUID()) =>
    http().post(path).set(bearer(a)).set('Idempotency-Key', key).send(body);
  const get = (path: string, a: Actor) => http().get(path).set(bearer(a));

  async function addUser(co: { id: string; roles: Record<string, string> }, roleCode: string, tag: string): Promise<Actor> {
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: { companyId: co.id, firstName: tag, lastName: `V09${roleCode}`, phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${co.id}, true)`;
      await tx.userRole.create({ data: { userId: user.id, roleId: co.roles[roleCode]! } });
    });
    return { token: (await loginWithMfa(app, phone, password)).accessToken, userId: user.id };
  }

  async function setupCompany(label: string): Promise<Co> {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-v09-${label}-${Date.now()}-${randomUUID().slice(0, 6)}`, name: `V09 ${label}` } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `V09 ${label} Co` } });
    const id = company.id;
    const roles: Record<string, string> = {};
    for (const roleCode of ROLES) {
      const permissionIds: string[] = [];
      for (const key of permissionKeysForRole(roleCode)) {
        const [module, code] = key.split('.');
        permissionIds.push((await systemPrisma.permission.upsert({ where: { module_code: { module: module!, code: code! } }, update: {}, create: { module: module!, code: code! } })).id);
      }
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${id}, true)`;
        const role = await tx.role.create({ data: { companyId: id, code: roleCode, name: roleCode, isSystem: true } });
        await tx.rolePermission.createMany({ data: permissionIds.map((permissionId) => ({ roleId: role.id, permissionId })) });
        roles[roleCode] = role.id;
      });
    }
    const prods: Record<string, Prod> = {};
    let wh = '';
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${id}, true)`;
      wh = (await tx.warehouse.create({ data: { companyId: id, name: `WH ${label}` } })).id;
      const pl = await tx.priceList.create({ data: { companyId: id, name: `PL ${label}`, isDefault: true } });
      for (const [key, onHand] of [['P', '1000'], ['LOW', '5'], ['STALE', '1000']] as const) {
        const p = await tx.product.create({ data: { companyId: id, sku: `V09-${label}-${key}-${Date.now()}`, name: `V09 ${key}`, baseUnit: 'dona', vatRate: '12' } });
        const pk = await tx.productPackaging.create({ data: { productId: p.id, name: 'dona', qtyInBaseUnit: '1', isDefault: true } });
        await tx.priceListItem.create({ data: { priceListId: pl.id, productId: p.id, price: UNIT } });
        await tx.stockLevel.create({ data: { productId: p.id, warehouseId: wh, onHand, reserved: '0' } });
        prods[key] = { id: p.id, packagingId: pk.id };
      }
    });
    const a = {} as Record<RoleCode, Actor>;
    for (const r of ROLES) a[r] = await addUser({ id, roles }, r, r);
    const courier2 = await addUser({ id, roles }, 'COURIER', 'Courier2');
    return { id, roles, a, courier2, P: prods.P!, LOW: prods.LOW!, STALE: prods.STALE!, wh };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.listen(0, '127.0.0.1');
    A = await setupCompany('A');
    B = await setupCompany('B');
  });
  afterAll(async () => {
    await app.close();
  });

  // ---- data helpers -------------------------------------------------------------------------------------------
  const newCustomer = (co: Co) =>
    tp.run(co.id, async () => (await tp.client.customer.create({ data: { companyId: co.id, code: `V09-C-${randomUUID().slice(0, 8)}`, name: 'V09 Customer' } })).id);
  const syncDoc = (cust: string, prod: Prod, qty: number, expectedUnitPrice?: string, clientId = randomUUID()) => ({
    type: 'order',
    clientId,
    payload: { customerId: cust, clientId, lines: [{ productId: prod.id, packagingId: prod.packagingId, qty, ...(expectedUnitPrice && { expectedUnitPrice }) }] },
  });
  const push = (a: Actor, documents: unknown[]) => http().post('/sync/push').set(bearer(a)).send({ documents });
  /** Mini App path: order created through /sync/push as the agent. */
  async function agentOrder(co: Co, cust: string, qty = 10, prod: Prod = co.P): Promise<string> {
    const res = await push(co.a.SALES_AGENT, [syncDoc(cust, prod, qty, UNIT)]).expect(201);
    expect(res.body.results[0].status, JSON.stringify(res.body)).toBe('ACCEPTED');
    return res.body.results[0].id as string;
  }
  const confirm = (co: Co, id: string, key?: string) => post(`/orders/${id}/confirm`, co.a.SALES_DIRECTOR, {}, key);
  const assign = (co: Co, id: string, courier: Actor = co.a.COURIER, key?: string) =>
    post(`/orders/${id}/assign-courier`, co.a.WAREHOUSE, { courierId: courier.userId }, key);
  const confirmed = async (co: Co, cust: string, qty = 10) => {
    const id = await agentOrder(co, cust, qty);
    await confirm(co, id).expect(201);
    return id;
  };
  const shipped = async (co: Co, cust: string, qty = 10) => {
    const id = await confirmed(co, cust, qty);
    await assign(co, id).expect(201);
    return id;
  };
  const stock = (co: Co, prod: Prod = co.P) =>
    tp.run(co.id, async () => {
      const s = await tp.client.stockLevel.findFirstOrThrow({ where: { productId: prod.id, warehouseId: co.wh } });
      return { onHand: s.onHand.toString(), reserved: s.reserved.toString() };
    });
  const mv = (co: Co, id: string, type: 'RESERVE' | 'RELEASE' | 'ISSUE') => tp.run(co.id, () => tp.client.stockMovement.count({ where: { refId: id, type } }));
  const invoicesOf = (co: Co, orderId: string) => tp.run(co.id, () => tp.client.invoice.findMany({ where: { orderId } }));
  const orderRow = (co: Co, id: string) => tp.run(co.id, () => tp.client.salesOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } }));
  const ordersByClientId = (co: Co, clientId: string) => tp.run(co.id, () => tp.client.salesOrder.findMany({ where: { clientId } }));
  const balanceOf = async (co: Co, cust: string) => D((await get(`/customers/${cust}`, co.a.CASHIER).expect(200)).body.balance).toFixed(2);

  // ---- 1. critical path -------------------------------------------------------------------------------------------
  describe('1. critical path (§6.3-6.6, §16.1 E2E order->confirm->issue->invoice->payment->report)', () => {
    let cust: string;
    let orderId: string;
    const flow: { paymentId?: string } = {};
    it('agent /sync/push => ACCEPTED SUBMITTED order, server-priced 112000.00, no reserve yet', async () => {
      cust = await newCustomer(A);
      const before = await stock(A);
      orderId = await agentOrder(A, cust);
      const o = await orderRow(A, orderId);
      expect(o.status).toBe('SUBMITTED');
      expect(o.lines[0]!.lineTotal.toFixed(2)).toBe(LINE_10);
      expect(await stock(A)).toEqual(before);
      expect(await mv(A, orderId, 'RESERVE')).toBe(0);
    });
    it('director confirm => CONFIRMED, reserved +10, exactly 1 RESERVE, no ISSUE/Invoice', async () => {
      const before = await stock(A);
      const res = await confirm(A, orderId);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.status).toBe('CONFIRMED');
      const s = await stock(A);
      expect(D(s.reserved).minus(before.reserved).toString()).toBe('10');
      expect(s.onHand).toBe(before.onHand);
      expect(await mv(A, orderId, 'RESERVE')).toBe(1);
      expect(await mv(A, orderId, 'ISSUE')).toBe(0);
    });
    it('warehouse assign-courier => SHIPPED, courier set, still no ISSUE, no Invoice, onHand untouched', async () => {
      const before = await stock(A);
      const res = await assign(A, orderId);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.status).toBe('SHIPPED');
      expect((await orderRow(A, orderId)).courierId).toBe(A.a.COURIER.userId);
      expect(await mv(A, orderId, 'ISSUE')).toBe(0);
      expect(await invoicesOf(A, orderId)).toHaveLength(0);
      expect(await stock(A)).toEqual(before);
    });
    it('courier deliver (full) => DELIVERED; Invoice 112000.00 only now; ISSUE once; reserve consumed, onHand -10', async () => {
      const before = await stock(A);
      const res = await post(`/orders/${orderId}/deliver`, A.a.COURIER);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.status).toBe('DELIVERED');
      const inv = await invoicesOf(A, orderId);
      expect(inv).toHaveLength(1);
      expect(inv[0]!.total.toFixed(2)).toBe(LINE_10);
      expect(inv[0]!.kind).toBe('SALE');
      expect(await mv(A, orderId, 'ISSUE')).toBe(1);
      const s = await stock(A);
      expect(D(before.onHand).minus(s.onHand).toString()).toBe('10');
      expect(D(before.reserved).minus(s.reserved).toString()).toBe('10');
      expect(await balanceOf(A, cust)).toBe(LINE_10);
    });
    it('agent payment 50000 => PENDING_HANDOVER, balance unchanged; cashier accepts => POSTED, balance 62000.00', async () => {
      const clientId = randomUUID();
      const pay = await http().post('/payments').set(bearer(A.a.SALES_AGENT)).send({ customerId: cust, amount: '50000.00', method: 'CASH', clientId });
      expect(pay.status, JSON.stringify(pay.body)).toBe(201);
      expect(pay.body.status).toBe('PENDING_HANDOVER');
      flow.paymentId = pay.body.id;
      expect(await balanceOf(A, cust)).toBe(LINE_10);
      await http().post('/cash-sessions/open').set(bearer(A.a.CASHIER)).send({ openAmount: '0.00' }).expect(201); // CASH handover needs an open session
      const acc = await post(`/payments/${flow.paymentId}/handover/accept`, A.a.CASHIER);
      expect(acc.status, JSON.stringify(acc.body)).toBeLessThan(300);
      expect((await get(`/payments/${flow.paymentId}`, A.a.CASHIER).expect(200)).body.status).toBe('POSTED');
      expect(await balanceOf(A, cust)).toBe('62000.00');
    });
    it('cashier payment 62000 (FIFO) => balance 0.00, invoice PAID; re-sending same clientId is a replay (1 payment)', async () => {
      const clientId = randomUUID();
      const body = { customerId: cust, amount: '62000.00', method: 'TRANSFER', clientId };
      const first = await http().post('/payments').set(bearer(A.a.CASHIER)).send(body);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const second = await http().post('/payments').set(bearer(A.a.CASHIER)).send(body);
      expect(second.body.id).toBe(first.body.id);
      expect(await tp.run(A.id, () => tp.client.payment.count({ where: { clientId } }))).toBe(1);
      expect(await balanceOf(A, cust)).toBe('0.00');
      expect((await invoicesOf(A, orderId))[0]!.status).toBe('PAID');
    });
    it('reports reflect the numbers: /reports/sales turnover 112000, aging shows debt; invoice visible via HTTP; B sees nothing', async () => {
      const sales = await get('/reports/sales', A.a.SALES_DIRECTOR).expect(200);
      expect(D(sales.body.summary.turnover).toFixed(2)).toBe(LINE_10);
      expect(sales.body.summary.orderCount).toBe(1);
      // a second delivered, unpaid order => aging row = its full total
      const cust2 = await newCustomer(A);
      const o2 = await shipped(A, cust2, 4); // 4 x 10000 x 1.12 = 44800
      await post(`/orders/${o2}/deliver`, A.a.COURIER).expect(201);
      const aging = await get('/reports/aging', A.a.ACCOUNTANT).expect(200);
      const row = (aging.body.data as { customerId: string; total: string }[]).find((r) => r.customerId === cust2);
      expect(D(row!.total).toFixed(2)).toBe('44800.00');
      expect((aging.body.data as { customerId: string }[]).some((r) => r.customerId === cust)).toBe(false); // fully paid
      const invs = await get('/invoices', A.a.ACCOUNTANT).expect(200);
      expect(JSON.stringify(invs.body)).toContain((await invoicesOf(A, orderId))[0]!.id);
      const bSales = await get('/reports/sales', B.a.SALES_DIRECTOR).expect(200);
      expect(D(bSales.body.summary.turnover).toFixed(2)).toBe('0.00');
      expect((await get('/reports/aging', B.a.ACCOUNTANT).expect(200)).body.data).toHaveLength(0);
    });
  });

  // ---- 2. cancel -------------------------------------------------------------------------------------------------
  describe('2. director cancel (ADR-044 reason, reserve released once)', () => {
    it('confirmed => cancel with reason: CANCELLED, reserve released once; repeat cancel is a no-op', async () => {
      const cust = await newCustomer(A);
      const before = await stock(A);
      const id = await confirmed(A, cust);
      expect(D((await stock(A)).reserved).minus(before.reserved).toString()).toBe('10');
      const res = await post(`/orders/${id}/cancel`, A.a.SALES_DIRECTOR, { reason: 'customer refused' });
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect((await orderRow(A, id)).status).toBe('CANCELLED');
      expect(await stock(A)).toEqual(before);
      expect(await mv(A, id, 'RELEASE')).toBe(1);
      const again = await post(`/orders/${id}/cancel`, A.a.SALES_DIRECTOR, { reason: 'customer refused' });
      expect(again.status, JSON.stringify(again.body)).toBeLessThan(300);
      expect(await mv(A, id, 'RELEASE')).toBe(1);
      expect(await stock(A)).toEqual(before);
      expect(await invoicesOf(A, id)).toHaveLength(0);
    });
    it('cancel without reason => 400, order stays CONFIRMED; SHIPPED cannot be cancelled (must return to warehouse)', async () => {
      const cust = await newCustomer(A);
      const id = await confirmed(A, cust);
      await post(`/orders/${id}/cancel`, A.a.SALES_DIRECTOR, {}).expect(400);
      expect((await orderRow(A, id)).status).toBe('CONFIRMED');
      await assign(A, id).expect(201);
      const r = await post(`/orders/${id}/cancel`, A.a.SALES_DIRECTOR, { reason: 'too late' });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect((await orderRow(A, id)).status).toBe('SHIPPED');
    });
  });

  // ---- 3. retry / idempotency -----------------------------------------------------------------------------------
  describe('3. retries (§8.5 triple resend = 1 doc; idempotent confirm/assign/deliver)', () => {
    it('same /sync/push clientId twice => 2nd DUPLICATE, same id, one order, one reservation after confirm', async () => {
      const cust = await newCustomer(A);
      const doc = syncDoc(cust, A.P, 10, UNIT);
      const first = await push(A.a.SALES_AGENT, [doc]).expect(201);
      const second = await push(A.a.SALES_AGENT, [doc]).expect(201);
      expect(first.body.results[0].status).toBe('ACCEPTED');
      expect(second.body.results[0].status).toBe('DUPLICATE');
      expect(second.body.results[0].id).toBe(first.body.results[0].id);
      expect(await ordersByClientId(A, doc.clientId)).toHaveLength(1);
      const id = first.body.results[0].id as string;
      const before = await stock(A);
      await confirm(A, id).expect(201);
      expect(D((await stock(A)).reserved).minus(before.reserved).toString()).toBe('10');
      expect(await mv(A, id, 'RESERVE')).toBe(1);
    });
    it('parallel same-clientId push => exactly one order', async () => {
      const cust = await newCustomer(A);
      const doc = syncDoc(cust, A.P, 1, UNIT);
      const rs = await Promise.all(Array.from({ length: 5 }, () => push(A.a.SALES_AGENT, [doc])));
      const statuses = rs.map((r) => r.body.results?.[0]?.status);
      expect(statuses.filter((s) => s === 'ACCEPTED')).toHaveLength(1);
      expect(statuses.every((s) => s === 'ACCEPTED' || s === 'DUPLICATE' || s === 'RETRY')).toBe(true);
      expect(await ordersByClientId(A, doc.clientId)).toHaveLength(1);
    });
    it('confirm: same Idempotency-Key replays; parallel confirms with different keys reserve once (no double RESERVE)', async () => {
      const cust = await newCustomer(A);
      const id = await agentOrder(A, cust);
      const before = await stock(A);
      const key = randomUUID();
      const r1 = await confirm(A, id, key);
      const r2 = await confirm(A, id, key);
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(r1.status);
      expect(r2.body.status).toBe('CONFIRMED');
      await Promise.all([confirm(A, id), confirm(A, id)]);
      expect(await mv(A, id, 'RESERVE')).toBe(1);
      expect(D((await stock(A)).reserved).minus(before.reserved).toString()).toBe('10');
    });
    it('assign-courier repeat (same key, new key, parallel) => stays SHIPPED, no ISSUE, no Invoice', async () => {
      const cust = await newCustomer(A);
      const id = await confirmed(A, cust);
      const key = randomUUID();
      expect((await assign(A, id, A.a.COURIER, key)).status).toBe(201);
      expect((await assign(A, id, A.a.COURIER, key)).status).toBe(201);
      await Promise.all([assign(A, id), assign(A, id)]);
      const o = await orderRow(A, id);
      expect(o.status).toBe('SHIPPED');
      expect(o.courierId).toBe(A.a.COURIER.userId);
      expect(await mv(A, id, 'ISSUE')).toBe(0);
      expect(await invoicesOf(A, id)).toHaveLength(0);
    });
    it('deliver repeat (same key replay, new key, parallel) => exactly 1 ISSUE, 1 Invoice, stock moved once', async () => {
      const cust = await newCustomer(A);
      const id = await shipped(A, cust);
      const before = await stock(A);
      const key = randomUUID();
      const r1 = await post(`/orders/${id}/deliver`, A.a.COURIER, {}, key);
      expect(r1.status).toBe(201);
      const r2 = await post(`/orders/${id}/deliver`, A.a.COURIER, {}, key);
      expect(r2.status).toBe(201);
      const r3 = await post(`/orders/${id}/deliver`, A.a.COURIER);
      expect(r3.status).toBeGreaterThanOrEqual(400); // new key on an already DELIVERED order must not re-issue
      await Promise.all([post(`/orders/${id}/deliver`, A.a.COURIER), post(`/orders/${id}/deliver`, A.a.COURIER)]);
      expect(await mv(A, id, 'ISSUE')).toBe(1);
      expect(await invoicesOf(A, id)).toHaveLength(1);
      expect(D(before.onHand).minus((await stock(A)).onHand).toString()).toBe('10');
      expect(await balanceOf(A, cust)).toBe(LINE_10);
    });
    it('parallel deliver with distinct keys from the start (no prior serial call) => 1 ISSUE, 1 Invoice', async () => {
      const cust = await newCustomer(A);
      const id = await shipped(A, cust);
      const rs = await Promise.all(Array.from({ length: 4 }, () => post(`/orders/${id}/deliver`, A.a.COURIER)));
      expect(rs.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
      expect(rs.every((r) => r.status < 500)).toBe(true);
      expect(await mv(A, id, 'ISSUE')).toBe(1);
      expect(await invoicesOf(A, id)).toHaveLength(1);
    });
  });

  // ---- 4. partial delivery -------------------------------------------------------------------------------------
  describe('4. partial delivery by WAREHOUSE (F2.4): delivered issued, remainder released, invoice for delivered', () => {
    it('6 of 10 => ISSUE, remainder 4 released, invoice 67200.00, balance 67200.00; courier is refused', async () => {
      const cust = await newCustomer(A);
      const id = await shipped(A, cust);
      const before = await stock(A);
      const lineId = (await orderRow(A, id)).lines[0]!.id;
      const body = { lines: [{ lineId, deliveredQty: '6' }] };
      const denied = await post(`/orders/${id}/deliver`, A.a.COURIER, body);
      expect(denied.status).toBe(403);
      expect(await invoicesOf(A, id)).toHaveLength(0);
      const res = await post(`/orders/${id}/deliver`, A.a.WAREHOUSE, body);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.status).toBe('DELIVERED');
      const o = await orderRow(A, id);
      expect(o.lines[0]!.deliveredQty.toString()).toBe('6');
      const s = await stock(A);
      expect(D(before.onHand).minus(s.onHand).toString()).toBe('6');
      expect(D(before.reserved).minus(s.reserved).toString()).toBe('10'); // 6 consumed + 4 released
      expect(await mv(A, id, 'ISSUE')).toBe(1);
      expect(await mv(A, id, 'RELEASE')).toBe(1);
      const inv = await invoicesOf(A, id);
      expect(inv).toHaveLength(1);
      expect(inv[0]!.total.toFixed(2)).toBe('67200.00'); // 6 x 10000 x 1.12
      expect(await balanceOf(A, cust)).toBe('67200.00');
    });
  });

  // ---- 5. insufficient stock --------------------------------------------------------------------------------
  describe('5. insufficient stock on confirm => 409, no partial reservation (§16.1 atomic reserve)', () => {
    it('line 1 fits, line 2 does not => 409; nothing reserved on either product; order stays SUBMITTED', async () => {
      const cust = await newCustomer(A);
      const doc = {
        type: 'order',
        clientId: randomUUID(),
        payload: {
          customerId: cust,
          clientId: '',
          lines: [
            { productId: A.P.id, packagingId: A.P.packagingId, qty: 2 },
            { productId: A.LOW.id, packagingId: A.LOW.packagingId, qty: 10 },
          ],
        },
      };
      doc.payload.clientId = doc.clientId;
      const pushed = await push(A.a.SALES_AGENT, [doc]).expect(201);
      expect(pushed.body.results[0].status, JSON.stringify(pushed.body)).toBe('ACCEPTED');
      const id = pushed.body.results[0].id as string;
      const [pBefore, lowBefore] = [await stock(A), await stock(A, A.LOW)];
      const res = await confirm(A, id);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(await stock(A)).toEqual(pBefore);
      expect(await stock(A, A.LOW)).toEqual(lowBefore);
      expect(await mv(A, id, 'RESERVE')).toBe(0);
      expect((await orderRow(A, id)).status).toBe('SUBMITTED');
    });
    it('2 parallel confirms of 2 orders each wanting 4 of LOW(5) => exactly one wins, reserved 4 (no oversell)', async () => {
      const cust = await newCustomer(A);
      const ids = [await agentOrder(A, cust, 4, A.LOW), await agentOrder(A, cust, 4, A.LOW)];
      const before = await stock(A, A.LOW);
      const rs = await Promise.all(ids.map((i) => confirm(A, i)));
      expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
      const s = await stock(A, A.LOW);
      expect(D(s.reserved).minus(before.reserved).toString()).toBe('4');
      expect(D(s.onHand).minus(s.reserved).greaterThanOrEqualTo(0)).toBe(true);
    });
  });

  // ---- 6. forbidden roles ---------------------------------------------------------------------------------------
  describe('6. RBAC: one 403 per role for steps it must not do (§16.3), state unchanged', () => {
    let cust: string;
    let sub: string;
    let conf: string;
    let ship: string;
    beforeAll(async () => {
      cust = await newCustomer(A);
      sub = await agentOrder(A, cust);
      conf = await confirmed(A, cust);
      ship = await shipped(A, cust);
    });
    const status = async (id: string) => (await orderRow(A, id)).status;
    const row: [RoleCode, string, (a: Actor) => request.Test, () => string, string][] = [
      ['SALES_AGENT', 'confirm', (a) => post(`/orders/${sub}/confirm`, a), () => sub, 'SUBMITTED'],
      ['SALES_AGENT', 'assign-courier', (a) => post(`/orders/${conf}/assign-courier`, a, { courierId: A.a.COURIER.userId }), () => conf, 'CONFIRMED'],
      ['SALES_AGENT', 'deliver', (a) => post(`/orders/${ship}/deliver`, a), () => ship, 'SHIPPED'],
      ['COURIER', 'confirm', (a) => post(`/orders/${sub}/confirm`, a), () => sub, 'SUBMITTED'],
      ['COURIER', 'create order', (a) => post('/orders', a, { customerId: cust, lines: [] }), () => sub, 'SUBMITTED'],
      ['COURIER', 'create payment', (a) => post('/payments', a, { customerId: cust, amount: '1.00', method: 'CASH' }), () => sub, 'SUBMITTED'],
      ['WAREHOUSE', 'confirm', (a) => post(`/orders/${sub}/confirm`, a), () => sub, 'SUBMITTED'],
      ['WAREHOUSE', 'cancel', (a) => post(`/orders/${conf}/cancel`, a, { reason: 'nope nope' }), () => conf, 'CONFIRMED'],
      ['WAREHOUSE', 'create payment', (a) => post('/payments', a, { customerId: cust, amount: '1.00', method: 'CASH' }), () => sub, 'SUBMITTED'],
      ['CASHIER', 'confirm', (a) => post(`/orders/${sub}/confirm`, a), () => sub, 'SUBMITTED'],
      ['CASHIER', 'assign-courier', (a) => post(`/orders/${conf}/assign-courier`, a, { courierId: A.a.COURIER.userId }), () => conf, 'CONFIRMED'],
      ['CASHIER', 'deliver', (a) => post(`/orders/${ship}/deliver`, a), () => ship, 'SHIPPED'],
      ['CASHIER', 'create order', (a) => post('/orders', a, { customerId: cust, lines: [] }), () => sub, 'SUBMITTED'],
      ['ACCOUNTANT', 'confirm', (a) => post(`/orders/${sub}/confirm`, a), () => sub, 'SUBMITTED'],
      ['ACCOUNTANT', 'assign-courier', (a) => post(`/orders/${conf}/assign-courier`, a, { courierId: A.a.COURIER.userId }), () => conf, 'CONFIRMED'],
      ['ACCOUNTANT', 'deliver', (a) => post(`/orders/${ship}/deliver`, a), () => ship, 'SHIPPED'],
      ['ACCOUNTANT', 'cancel', (a) => post(`/orders/${conf}/cancel`, a, { reason: 'nope nope' }), () => conf, 'CONFIRMED'],
      ['ACCOUNTANT', 'create payment', (a) => post('/payments', a, { customerId: cust, amount: '1.00', method: 'CASH' }), () => sub, 'SUBMITTED'],
      ['SALES_DIRECTOR', 'create order', (a) => post('/orders', a, { customerId: cust, lines: [] }), () => sub, 'SUBMITTED'],
      ['SALES_DIRECTOR', 'create payment', (a) => post('/payments', a, { customerId: cust, amount: '1.00', method: 'CASH' }), () => sub, 'SUBMITTED'],
    ];
    it.each(row)('%s cannot %s => 403', async (role, _step, fn, orderOf, expected) => {
      const res = await fn(A.a[role]);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(await status(orderOf())).toBe(expected);
    });
    it('SALES_DIRECTOR cannot accept cash handover (payments.handover is OWNER/CASHIER only) => 403, payment stays PENDING_HANDOVER', async () => {
      const pay = await http().post('/payments').set(bearer(A.a.SALES_AGENT)).send({ customerId: cust, amount: '1000.00', method: 'CASH' }).expect(201);
      await post(`/payments/${pay.body.id}/handover/accept`, A.a.SALES_DIRECTOR).expect(403);
      await post(`/payments/${pay.body.id}/handover/accept`, A.a.SALES_AGENT).expect(403);
      expect((await get(`/payments/${pay.body.id}`, A.a.CASHIER).expect(200)).body.status).toBe('PENDING_HANDOVER');
    });
    it('courier cannot deliver an order assigned to another courier => 403 (SEC-023)', async () => {
      const res = await post(`/orders/${ship}/deliver`, A.courier2);
      expect(res.status).toBe(403);
      expect(await status(ship)).toBe('SHIPPED');
    });
  });

  // ---- 7. cross-tenant -----------------------------------------------------------------------------------------
  describe('7. cross-tenant: B cannot read/act on A order, payment, courier (§16.3)', () => {
    let cust: string;
    let ordC: string;
    let ordS: string;
    let payId: string;
    beforeAll(async () => {
      cust = await newCustomer(A);
      ordC = await confirmed(A, cust);
      ordS = await shipped(A, cust);
      payId = (await http().post('/payments').set(bearer(A.a.SALES_AGENT)).send({ customerId: cust, amount: '500.00', method: 'CASH' }).expect(201)).body.id;
    });
    const hidden = (s: number) => expect([403, 404]).toContain(s);
    it('reads by ID swap (order, payment, customer, balance) => 403/404, no A data in body', async () => {
      for (const [path, a] of [
        [`/orders/${ordC}`, B.a.SALES_DIRECTOR],
        [`/payments/${payId}`, B.a.CASHIER],
        [`/customers/${cust}`, B.a.CASHIER],
        [`/customers/${cust}/balance`, B.a.ACCOUNTANT],
      ] as const) {
        const r = await get(path, a);
        hidden(r.status);
        expect(JSON.stringify(r.body)).not.toContain(cust);
      }
      const list = await get('/orders', B.a.SALES_DIRECTOR).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(ordC);
    });
    it('B actors cannot confirm/assign/deliver/cancel/handover on A resources; A state unchanged', async () => {
      const sub = await agentOrder(A, cust);
      hidden((await post(`/orders/${sub}/confirm`, B.a.SALES_DIRECTOR)).status);
      hidden((await post(`/orders/${ordC}/assign-courier`, B.a.WAREHOUSE, { courierId: B.a.COURIER.userId })).status);
      hidden((await post(`/orders/${ordS}/deliver`, B.a.COURIER)).status);
      hidden((await post(`/orders/${ordS}/deliver`, B.a.WAREHOUSE)).status);
      hidden((await post(`/orders/${ordC}/cancel`, B.a.SALES_DIRECTOR, { reason: 'cross tenant' })).status);
      hidden((await post(`/payments/${payId}/handover/accept`, B.a.CASHIER)).status);
      expect((await orderRow(A, sub)).status).toBe('SUBMITTED');
      expect((await orderRow(A, ordC)).status).toBe('CONFIRMED');
      expect((await orderRow(A, ordS)).status).toBe('SHIPPED');
      expect(await invoicesOf(A, ordS)).toHaveLength(0);
      expect((await get(`/payments/${payId}`, A.a.CASHIER).expect(200)).body.status).toBe('PENDING_HANDOVER');
    });
    it('a courier of the other tenant is not assignable (A order <- B courier, B order <- A courier)', async () => {
      const bCust = await newCustomer(B);
      const bOrder = await confirmed(B, bCust);
      const r1 = await post(`/orders/${ordC}/assign-courier`, A.a.WAREHOUSE, { courierId: B.a.COURIER.userId });
      expect(r1.status).toBeGreaterThanOrEqual(400);
      expect(r1.status).toBeLessThan(500);
      const r2 = await post(`/orders/${bOrder}/assign-courier`, B.a.WAREHOUSE, { courierId: A.a.COURIER.userId });
      expect(r2.status).toBeGreaterThanOrEqual(400);
      expect(r2.status).toBeLessThan(500);
      expect((await orderRow(A, ordC)).courierId).toBeNull();
      expect((await orderRow(B, bOrder)).courierId).toBeNull();
      const couriers = await get('/orders/assignable-couriers', B.a.WAREHOUSE).expect(200);
      expect(JSON.stringify(couriers.body)).not.toContain(A.a.COURIER.userId);
    });
    it('B cannot push an order for an A customer (sync) => not ACCEPTED, no order', async () => {
      const doc = syncDoc(cust, B.P, 1, UNIT);
      const r = await push(B.a.SALES_AGENT, [doc]);
      expect(r.status < 500).toBe(true);
      expect(r.body.results?.[0]?.status).not.toBe('ACCEPTED');
      expect(await ordersByClientId(A, doc.clientId)).toHaveLength(0);
      expect(await ordersByClientId(B, doc.clientId)).toHaveLength(0);
    });
  });

  // ---- 8. stale price ------------------------------------------------------------------------------------------
  describe('8. stale price (§8.5): server price changed after offline draft => CONFLICT/PRICE_CHANGED, value never silently changed', () => {
    it('conflict creates no order/reserve; resubmit with the accepted new price + same clientId => ACCEPTED once, then DUPLICATE', async () => {
      const cust = await newCustomer(A);
      await tp.run(A.id, () =>
        tp.client.priceListItem.updateMany({ where: { productId: A.STALE.id }, data: { price: '11000.00' } }),
      );
      const doc = syncDoc(cust, A.STALE, 2, UNIT);
      const stale = await push(A.a.SALES_AGENT, [doc]).expect(201);
      const r = stale.body.results[0];
      expect(r.status, JSON.stringify(r)).toBe('CONFLICT');
      expect(r.error.code).toBe('PRICE_CHANGED');
      expect(r.error.details.lines[0]).toMatchObject({ expectedUnitPrice: UNIT, serverUnitPrice: '11000.00' });
      expect(await ordersByClientId(A, doc.clientId)).toHaveLength(0);
      const fixed = { ...doc, payload: { ...doc.payload, lines: [{ ...doc.payload.lines[0]!, expectedUnitPrice: '11000.00' }] } };
      const ok = await push(A.a.SALES_AGENT, [fixed]).expect(201);
      expect(ok.body.results[0].status, JSON.stringify(ok.body)).toBe('ACCEPTED');
      const again = await push(A.a.SALES_AGENT, [fixed]).expect(201);
      expect(again.body.results[0].status).toBe('DUPLICATE');
      const orders = await ordersByClientId(A, doc.clientId);
      expect(orders).toHaveLength(1);
      const o = await orderRow(A, orders[0]!.id);
      expect(o.lines[0]!.unitPrice.toFixed(2)).toBe('11000.00');
      expect(o.lines[0]!.lineTotal.toFixed(2)).toBe('24640.00'); // 2 x 11000 x 1.12
    });
  });

  // ---- 9. reconciliation ---------------------------------------------------------------------------------------
  describe('9. financial reconciliation (§6.5): Σ invoices − Σ POSTED payments == Σ customer balance', () => {
    const totals = (co: Co) =>
      tp.run(co.id, async () => {
        const inv = await tp.client.invoice.findMany({ where: { status: { not: 'CANCELLED' } }, select: { total: true, customerId: true } });
        const pays = await tp.client.payment.findMany({ where: { status: 'POSTED' }, select: { amount: true, customerId: true } });
        return { inv, pays, custIds: [...new Set([...inv.map((i) => i.customerId), ...pays.map((p) => p.customerId)])] };
      });
    it('A: per-customer and overall sum(invoices) − sum(payments) equals API balances; B untouched by A flows', async () => {
      const t = await totals(A);
      expect(t.inv.length).toBeGreaterThan(0);
      let apiSum = D(0);
      for (const c of t.custIds) {
        const inv = t.inv.filter((i) => i.customerId === c).reduce((s, i) => s.plus(i.total), D(0));
        const pay = t.pays.filter((p) => p.customerId === c).reduce((s, p) => s.plus(p.amount), D(0));
        const bal = await balanceOf(A, c);
        expect(bal).toBe(inv.minus(pay).toFixed(2));
        apiSum = apiSum.plus(bal);
      }
      const invTotal = t.inv.reduce((s, i) => s.plus(i.total), D(0));
      const payTotal = t.pays.reduce((s, p) => s.plus(p.amount), D(0));
      expect(apiSum.toFixed(2)).toBe(invTotal.minus(payTotal).toFixed(2));
      const aging = await get('/reports/aging?pageSize=100', A.a.ACCOUNTANT).expect(200);
      const agingSum = (aging.body.data as { total: string }[]).reduce((s, r) => s.plus(r.total), D(0));
      expect(agingSum.toFixed(2)).toBe(apiSum.toFixed(2));
      const b = await totals(B);
      for (const c of b.custIds) expect(await balanceOf(B, c)).toBe(
        b.inv.filter((i) => i.customerId === c).reduce((s, i) => s.plus(i.total), D(0)).minus(b.pays.filter((p) => p.customerId === c).reduce((s, p) => s.plus(p.amount), D(0))).toFixed(2),
      );
      expect(b.inv.every((i) => !t.inv.includes(i))).toBe(true);
    });
  });
});
