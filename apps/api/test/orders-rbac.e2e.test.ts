import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import { prisma, systemPrisma } from '@velto/database';
import { permissionKeysForRole } from '../../../packages/database/src/rbac-catalog';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { uniquePhone } from './unique-phone';
import { loginWithMfa } from './mfa-login';

// Race-safe: parallel test files share the global Permission rows (upsert is not atomic).
async function ensurePermission(module: string, code: string) {
  await systemPrisma.permission.createMany({ data: [{ module, code }], skipDuplicates: true });
  return systemPrisma.permission.findUniqueOrThrow({ where: { module_code: { module, code } } });
}

/**
 * Order RBAC split over real HTTP (SEC-054, §16.3 "unauthorised => 403 + audit"):
 * orders.update (confirm/close/DELETE), orders.cancel, orders.assignCourier
 * (assign-courier, GET assignable-couriers), orders.dispatch (handover), orders.returnToWarehouse, orders.deliver.
 * Real seeded system roles of the catalog (permissionKeysForRole), real Postgres + RLS.
 */
describe('E2E orders RBAC split (orders.update / cancel / assignCourier / deliver)', () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
  let app: INestApplication;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const http = () => request(app.getHttpServer());

  interface Actor { token: string; userId: string; phone: string }
  interface Co {
    id: string;
    productId: string;
    packagingId: string;
    warehouseId: string;
    customerId: string;
    roles: Record<string, string>;
    actors: Record<string, Actor>;
  }
  let A: Co;
  let B: Co;
  let courier2A: Actor; // second active courier in A
  let inactiveCourierA: string;
  let nonCourierA: string; // active user without COURIER role (warehouse) -> id in A.actors.WAREHOUSE
  let bCourierId: string;

  const ROLE_CODES = ['SALES_DIRECTOR', 'WAREHOUSE', 'SALES_AGENT', 'COURIER'];
  const bearer = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });

  async function addUser(co: Co, roleCode: string, tag: string, opts: { login?: boolean; active?: boolean } = {}): Promise<Actor> {
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: {
        companyId: co.id,
        firstName: `${tag}`,
        lastName: `Rbac${roleCode}`,
        phone,
        isActive: opts.active ?? true,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${co.id}, true)`;
      await tx.userRole.create({ data: { userId: user.id, roleId: co.roles[roleCode]! } });
    });
    const token = opts.login === false ? '' : (await loginWithMfa(app, phone, password)).accessToken;
    return { token, userId: user.id, phone };
  }

  async function setupCompany(label: string): Promise<Co> {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-ordrbac-${label}-${Date.now()}`, name: `ORDRBAC ${label}` } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `ORDRBAC ${label} Co` } });
    const co: Co = { id: company.id, productId: '', packagingId: '', warehouseId: '', customerId: '', roles: {}, actors: {} };
    for (const roleCode of ROLE_CODES) {
      const permissionIds: string[] = [];
      for (const key of permissionKeysForRole(roleCode)) {
        const [module, code] = key.split('.');
        const p = await ensurePermission(module!, code!);
        permissionIds.push(p.id);
      }
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${co.id}, true)`;
        const role = await tx.role.create({ data: { companyId: co.id, code: roleCode, name: roleCode, isSystem: true } });
        await tx.rolePermission.createMany({ data: permissionIds.map((permissionId) => ({ roleId: role.id, permissionId })) });
        co.roles[roleCode] = role.id;
      });
    }
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${co.id}, true)`;
      const wh = await tx.warehouse.create({ data: { companyId: co.id, name: `WH ${label}` } });
      const product = await tx.product.create({ data: { companyId: co.id, sku: `ORB-${label}-${Date.now()}`, name: 'Rbac Product', baseUnit: 'dona', vatRate: '12' } });
      const pack = await tx.productPackaging.create({ data: { productId: product.id, name: 'dona', qtyInBaseUnit: '1', isDefault: true } });
      const pl = await tx.priceList.create({ data: { companyId: co.id, name: `PL ${label}`, isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: pl.id, productId: product.id, price: '10000.00' } });
      await tx.stockLevel.create({ data: { productId: product.id, warehouseId: wh.id, onHand: '1000', reserved: '0' } });
      const cust = await tx.customer.create({ data: { companyId: co.id, code: `ORB-C-${label}-${Date.now()}`, name: 'Rbac Customer' } });
      co.productId = product.id;
      co.packagingId = pack.id;
      co.warehouseId = wh.id;
      co.customerId = cust.id;
    });
    for (const roleCode of ROLE_CODES) co.actors[roleCode] = await addUser(co, roleCode, roleCode);
    return co;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.listen(0, '127.0.0.1');
    A = await setupCompany('A');
    B = await setupCompany('B');
    courier2A = await addUser(A, 'COURIER', 'Courier2');
    inactiveCourierA = (await addUser(A, 'COURIER', 'Inactive', { login: false, active: false })).userId;
    nonCourierA = A.actors.WAREHOUSE!.userId;
    bCourierId = B.actors.COURIER!.userId;
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string, a: Actor, body: object = {}, traceId?: string) => {
    let r = http().post(path).set(bearer(a)).set('Idempotency-Key', randomUUID());
    if (traceId) r = r.set('x-request-id', traceId);
    return r.send(body);
  };
  const del = (path: string, a: Actor, traceId?: string) => {
    let r = http().delete(path).set(bearer(a));
    if (traceId) r = r.set('x-request-id', traceId);
    return r;
  };
  const get = (path: string, a: Actor) => http().get(path).set(bearer(a));

  const newOrder = async (co: Co, qty = 10): Promise<string> => {
    const actor = co.actors.SALES_AGENT!; // directors do not hold orders.create
    const res = await post('/orders', actor, { customerId: co.customerId, lines: [{ productId: co.productId, packagingId: co.packagingId, qty }] }).expect(201);
    return res.body.id as string;
  };
  const confirmed = async (co: Co, qty = 10): Promise<string> => {
    const id = await newOrder(co, qty);
    await post(`/orders/${id}/confirm`, co.actors.SALES_DIRECTOR!).expect(201);
    return id;
  };
  const snapshot = (co: Co, id: string) =>
    tenantPrisma.run(co.id, async () => {
      const o = await tenantPrisma.client.salesOrder.findUniqueOrThrow({ where: { id } });
      return { status: o.status, courierId: o.courierId, updatedAt: o.updatedAt.toISOString() };
    });
  const reserved = (co: Co) =>
    tenantPrisma.run(co.id, async () => (await tenantPrisma.client.stockLevel.findFirstOrThrow({ where: { productId: co.productId, warehouseId: co.warehouseId } })).reserved.toString());
  const movements = (co: Co, id: string, type: 'RESERVE' | 'RELEASE' | 'ISSUE') =>
    tenantPrisma.run(co.id, () => tenantPrisma.client.stockMovement.count({ where: { refId: id, type } }));
  const invoices = (co: Co, id: string) => tenantPrisma.run(co.id, () => tenantPrisma.client.invoice.count({ where: { orderId: id } }));
  const denied = (co: Co, traceId: string) =>
    tenantPrisma.run(co.id, () => tenantPrisma.client.auditLog.findMany({ where: { action: 'auth.permission_denied', traceId } }));

  /** Fires `fn` as `actor`, expects 403 + exactly one permission-denied audit row with the right permission, order untouched. */
  async function expectDenied(co: Co, roleCode: string, orderId: string | null, permission: string, fn: (traceId: string) => request.Test) {
    const before = orderId ? await snapshot(co, orderId) : null;
    const traceId = `trace-ordrbac-${randomUUID()}`;
    const res = await fn(traceId);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const rows = await denied(co, traceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(co.actors[roleCode]!.userId);
    expect(rows[0]!.newValue).toMatchObject({ permission });
    if (orderId) expect(await snapshot(co, orderId)).toEqual(before);
  }

  describe('1. role matrix', () => {
    it('WAREHOUSE => 403 + audit on confirm, close, DELETE, cancel (order unchanged)', async () => {
      const wh = A.actors.WAREHOUSE!;
      const submitted = await newOrder(A);
      await expectDenied(A, 'WAREHOUSE', submitted, 'orders.update', (t) => post(`/orders/${submitted}/confirm`, wh, {}, t));
      await expectDenied(A, 'WAREHOUSE', submitted, 'orders.update', (t) => post(`/orders/${submitted}/close`, wh, {}, t));
      await expectDenied(A, 'WAREHOUSE', submitted, 'orders.update', (t) => del(`/orders/${submitted}`, wh, t));
      await expectDenied(A, 'WAREHOUSE', submitted, 'orders.cancel', (t) => post(`/orders/${submitted}/cancel`, wh, { reason: 'not allowed' }, t));
      const conf = await confirmed(A);
      await expectDenied(A, 'WAREHOUSE', conf, 'orders.cancel', (t) => post(`/orders/${conf}/cancel`, wh, { reason: 'not allowed' }, t));
    });

    it('WAREHOUSE assign-courier (stays CONFIRMED) => handover (SHIPPED, no ISSUE, no invoice) => return-to-warehouse => 2xx', async () => {
      const wh = A.actors.WAREHOUSE!;
      const id = await confirmed(A);
      const res = await post(`/orders/${id}/assign-courier`, wh, { courierId: A.actors.COURIER!.userId });
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect(res.body.status).toBe('CONFIRMED');
      expect(res.body.courierId).toBe(A.actors.COURIER!.userId);
      const ho = await post(`/orders/${id}/handover`, wh, { note: 'ramp 1' });
      expect(ho.status, JSON.stringify(ho.body)).toBe(201);
      expect(ho.body.status).toBe('SHIPPED');
      expect(await movements(A, id, 'ISSUE')).toBe(0);
      expect(await invoices(A, id)).toBe(0);
      const back = await post(`/orders/${id}/return-to-warehouse`, wh, { reason: 'customer closed' });
      expect(back.status, JSON.stringify(back.body)).toBeLessThan(300);
      expect(back.body.status).toBe('CONFIRMED');
      expect((await snapshot(A, id)).courierId).toBeNull();
    });

    it.each(['SALES_AGENT', 'COURIER'])('%s => 403 + audit on assign-courier, handover, return-to-warehouse, assignable-couriers, cancel, confirm', async (roleCode) => {
      const actor = A.actors[roleCode]!;
      const courierId = A.actors.COURIER!.userId;
      const assigned = await confirmed(A);
      await post(`/orders/${assigned}/assign-courier`, A.actors.WAREHOUSE!, { courierId }).expect(201);
      const shipped = await confirmed(A);
      await post(`/orders/${shipped}/assign-courier`, A.actors.WAREHOUSE!, { courierId }).expect(201);
      await post(`/orders/${shipped}/handover`, A.actors.WAREHOUSE!).expect(201);
      const conf = await confirmed(A);
      const sub = await newOrder(A);
      await expectDenied(A, roleCode, conf, 'orders.assignCourier', (t) => post(`/orders/${conf}/assign-courier`, actor, { courierId }, t));
      await expectDenied(A, roleCode, assigned, 'orders.dispatch', (t) => post(`/orders/${assigned}/handover`, actor, {}, t));
      await expectDenied(A, roleCode, shipped, 'orders.returnToWarehouse', (t) => post(`/orders/${shipped}/return-to-warehouse`, actor, { reason: 'nope nope' }, t));
      await expectDenied(A, roleCode, null, 'orders.assignCourier', (t) => get('/orders/assignable-couriers', actor).set('x-request-id', t));
      await expectDenied(A, roleCode, conf, 'orders.cancel', (t) => post(`/orders/${conf}/cancel`, actor, { reason: 'not allowed' }, t));
      await expectDenied(A, roleCode, sub, 'orders.update', (t) => post(`/orders/${sub}/confirm`, actor, {}, t));
    });

    it('SALES_DIRECTOR: cancel OK (reserve released once), assign OK, handover 403 (SoD), return-to-warehouse OK', async () => {
      const dir = A.actors.SALES_DIRECTOR!;
      const id = await confirmed(A);
      const assigned = await post(`/orders/${id}/assign-courier`, dir, { courierId: A.actors.COURIER!.userId });
      expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
      expect(assigned.body.status).toBe('CONFIRMED');
      await expectDenied(A, 'SALES_DIRECTOR', id, 'orders.dispatch', (t) => post(`/orders/${id}/handover`, dir, {}, t));
      await post(`/orders/${id}/handover`, A.actors.WAREHOUSE!).expect(201);
      const back = await post(`/orders/${id}/return-to-warehouse`, dir, { reason: 'director recall' });
      expect(back.status, JSON.stringify(back.body)).toBe(201);
      expect(back.body.status).toBe('CONFIRMED');
      expect((await snapshot(A, id)).courierId).toBeNull();
      const id2 = await confirmed(A);
      const cancelled = await post(`/orders/${id2}/cancel`, dir, { reason: 'director cancel' });
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(201);
      expect(cancelled.body.status).toBe('CANCELLED');
    });
  });

  describe('2. GET /orders/assignable-couriers', () => {
    it('static route wins over /:id; only id/firstName/lastName; active COURIERs of own company only', async () => {
      const res = await get('/orders/assignable-couriers', A.actors.WAREHOUSE!);
      expect(res.status, JSON.stringify(res.body)).toBe(200); // not 400 from ParseUUIDPipe
      expect(Array.isArray(res.body)).toBe(true);
      const ids = (res.body as { id: string }[]).map((u) => u.id);
      expect(ids).toEqual(expect.arrayContaining([A.actors.COURIER!.userId, courier2A.userId]));
      expect(ids).not.toContain(inactiveCourierA);
      expect(ids).not.toContain(nonCourierA);
      expect(ids).not.toContain(A.actors.SALES_AGENT!.userId);
      expect(ids).not.toContain(bCourierId);
      expect(ids).toHaveLength(2);
      for (const u of res.body as object[]) expect(Object.keys(u).sort()).toEqual(['firstName', 'id', 'lastName']);
    });

    it('company B sees only its own courier', async () => {
      const res = await get('/orders/assignable-couriers', B.actors.WAREHOUSE!).expect(200);
      expect((res.body as { id: string }[]).map((u) => u.id)).toEqual([bCourierId]);
    });
  });

  describe('3. cross-tenant (IDOR)', () => {
    it("company B warehouse assigning A's order => 404, no change", async () => {
      const id = await confirmed(A);
      const before = await snapshot(A, id);
      const res = await post(`/orders/${id}/assign-courier`, B.actors.WAREHOUSE!, { courierId: bCourierId });
      expect(res.status).toBe(404);
      expect(await snapshot(A, id)).toEqual(before);
    });

    it("company B order with A's courier => 404 COURIER_NOT_FOUND, no change", async () => {
      const id = await confirmed(B);
      const before = await snapshot(B, id);
      const res = await post(`/orders/${id}/assign-courier`, B.actors.WAREHOUSE!, { courierId: A.actors.COURIER!.userId });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('COURIER_NOT_FOUND');
      expect(await snapshot(B, id)).toEqual(before);
    });

    it("company B warehouse/director handover + return-to-warehouse on A's SHIPPED order => 404, no status/movement/invoice effect", async () => {
      const id = await confirmed(A);
      await post(`/orders/${id}/assign-courier`, A.actors.WAREHOUSE!, { courierId: A.actors.COURIER!.userId }).expect(201);
      await post(`/orders/${id}/handover`, A.actors.WAREHOUSE!).expect(201);
      const before = await snapshot(A, id);
      const [issue, release] = [await movements(A, id, 'ISSUE'), await movements(A, id, 'RELEASE')];
      expect((await post(`/orders/${id}/handover`, B.actors.WAREHOUSE!)).status).toBe(404);
      expect((await post(`/orders/${id}/return-to-warehouse`, B.actors.WAREHOUSE!, { reason: 'cross tenant' })).status).toBe(404);
      expect((await post(`/orders/${id}/return-to-warehouse`, B.actors.SALES_DIRECTOR!, { reason: 'cross tenant' })).status).toBe(404);
      expect(await snapshot(A, id)).toEqual(before);
      expect([await movements(A, id, 'ISSUE'), await movements(A, id, 'RELEASE')]).toEqual([issue, release]);
      expect(await invoices(A, id)).toBe(0);
    });

    it('return-to-warehouse without / blank / too-short reason => 400, order stays SHIPPED (reason mandatory)', async () => {
      const id = await confirmed(A);
      await post(`/orders/${id}/assign-courier`, A.actors.WAREHOUSE!, { courierId: A.actors.COURIER!.userId }).expect(201);
      await post(`/orders/${id}/handover`, A.actors.WAREHOUSE!).expect(201);
      const before = await snapshot(A, id);
      for (const body of [{}, { reason: '   ' }, { reason: 'ab' }]) {
        expect((await post(`/orders/${id}/return-to-warehouse`, A.actors.WAREHOUSE!, body)).status).toBe(400);
      }
      expect(await snapshot(A, id)).toEqual(before);
      expect(before.status).toBe('SHIPPED');
    });

    it('director (orders.update) cannot physically ship: confirm/close/delete leave an assigned CONFIRMED order unshipped, no ISSUE/invoice', async () => {
      const dir = A.actors.SALES_DIRECTOR!;
      const id = await confirmed(A);
      await post(`/orders/${id}/assign-courier`, A.actors.WAREHOUSE!, { courierId: A.actors.COURIER!.userId }).expect(201);
      await expectDenied(A, 'SALES_DIRECTOR', id, 'orders.dispatch', (t) => post(`/orders/${id}/handover`, dir, {}, t));
      await post(`/orders/${id}/confirm`, dir);
      await post(`/orders/${id}/close`, dir, {});
      await del(`/orders/${id}`, dir);
      expect((await snapshot(A, id)).status).not.toBe('SHIPPED');
      expect(await movements(A, id, 'ISSUE')).toBe(0);
      expect(await invoices(A, id)).toBe(0);
    });

    it('company A order with inactive courier / non-courier user => 404 COURIER_NOT_FOUND', async () => {
      const id = await confirmed(A);
      const before = await snapshot(A, id);
      for (const courierId of [inactiveCourierA, nonCourierA]) {
        const res = await post(`/orders/${id}/assign-courier`, A.actors.WAREHOUSE!, { courierId });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('COURIER_NOT_FOUND');
      }
      expect(await snapshot(A, id)).toEqual(before);
    });
  });

  describe('4. stale token after role change', () => {
    it('director => warehouse after token issued: old token denied on confirm, order unchanged', async () => {
      const actor = await addUser(A, 'SALES_DIRECTOR', 'Stale');
      const id = await newOrder(A);
      // Token works as director.
      await post(`/orders/${await newOrder(A)}/confirm`, actor).expect(201); // token works while director
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${A.id}, true)`;
        await tx.userRole.deleteMany({ where: { userId: actor.userId } });
        await tx.userRole.create({ data: { userId: actor.userId, roleId: A.roles.WAREHOUSE! } });
      });
      const before = await snapshot(A, id);
      const traceId = `trace-ordrbac-${randomUUID()}`;
      const res = await post(`/orders/${id}/confirm`, actor, {}, traceId);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(await snapshot(A, id)).toEqual(before);
      const rows = await denied(A, traceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.newValue).toMatchObject({ permission: 'orders.update' });
    });
  });

  describe('5. courierId on create without assignCourier (D2 approval bypass)', () => {
    it('user holding orders.create+orders.update only, POST /orders with courierId => 403 SALES_ORDER_COURIER_ASSIGN_FORBIDDEN, no order, no reservation', async () => {
      const phone = uniquePhone();
      const user = await systemPrisma.user.create({
        data: { companyId: A.id, firstName: 'UpdOnly', lastName: 'Rbac', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
      });
      const perms = await Promise.all(
        ['orders.create', 'orders.read', 'orders.update', 'customers.read', 'catalog.read'].map((k) => {
          const [module, code] = k.split('.');
          return ensurePermission(module!, code!);
        }),
      );
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${A.id}, true)`;
        const role = await tx.role.create({ data: { companyId: A.id, code: `UPD_ONLY_${Date.now()}`, name: 'Update only' } });
        await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
        await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
      });
      const token = (await loginWithMfa(app, phone, password)).accessToken;
      const actor: Actor = { token, userId: user.id, phone };
      const clientId = randomUUID();
      const reservedBefore = await reserved(A);
      const res = await post('/orders', actor, {
        customerId: A.customerId,
        clientId,
        courierId: A.actors.COURIER!.userId,
        lines: [{ productId: A.productId, packagingId: A.packagingId, qty: 3 }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.code).toBe('SALES_ORDER_COURIER_ASSIGN_FORBIDDEN');
      expect(await tenantPrisma.run(A.id, () => tenantPrisma.client.salesOrder.count({ where: { clientId } }))).toBe(0);
      expect(await reserved(A)).toBe(reservedBefore);
    });

    it('SALES_AGENT POST /orders with courierId => 403 SALES_ORDER_COURIER_ASSIGN_FORBIDDEN', async () => {
      const res = await post('/orders', A.actors.SALES_AGENT!, {
        customerId: A.customerId,
        courierId: A.actors.COURIER!.userId,
        lines: [{ productId: A.productId, packagingId: A.packagingId, qty: 1 }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.code).toBe('SALES_ORDER_COURIER_ASSIGN_FORBIDDEN');
    });

    const rejectedAudit = async (co: Co, userId: string, since: Date) => {
      for (let i = 0; i < 20; i++) {
        const rows = await tenantPrisma.run(co.id, () =>
          tenantPrisma.client.auditLog.findMany({ where: { action: 'order.create_with_courier_rejected', userId, createdAt: { gte: since } } }),
        );
        if (rows.length) return rows;
        await new Promise((r) => setTimeout(r, 100));
      }
      return [];
    };
    const expectAuditIsolated = async (rows: { companyId: string; userId: string | null; entityId: string | null; newValue: unknown }[], userId: string) => {
      expect(rows).toHaveLength(1);
      expect(rows[0]!.companyId).toBe(A.id);
      expect(rows[0]!.userId).toBe(userId);
      expect(rows[0]!.entityId).toBe(userId);
      expect(rows[0]!.newValue).toMatchObject({ reason: 'SALES_ORDER_COURIER_ASSIGN_FORBIDDEN', requiredPermissions: 'orders.update,orders.assignCourier' });
      const blob = JSON.stringify(rows[0]);
      for (const foreign of [B.id, bCourierId, B.customerId, B.productId, ...Object.values(B.actors).map((a) => a.userId)]) expect(blob).not.toContain(foreign);
      // Nothing of this rejection leaked into company B's audit trail.
      const inB = await tenantPrisma.run(B.id, () => tenantPrisma.client.auditLog.count({ where: { action: 'order.create_with_courier_rejected' } }));
      expect(inB).toBe(0);
    };

    it('(a) HTTP POST /orders with courierId by SALES_AGENT => audit row order.create_with_courier_rejected persists after rollback, tenant-isolated', async () => {
      const agent = await addUser(A, 'SALES_AGENT', 'HttpAudit'); // fresh user => exactly one row expected
      const since = new Date(Date.now() - 1000);
      const res = await post('/orders', agent, {
        customerId: A.customerId,
        courierId: A.actors.COURIER!.userId,
        lines: [{ productId: A.productId, packagingId: A.packagingId, qty: 1 }],
      });
      expect(res.status).toBe(403);
      await expectAuditIsolated(await rejectedAudit(A, agent.userId, since), agent.userId);
    });

    it('(b) /sync/push ORDER with courierId by SALES_AGENT => audit row order.create_with_courier_rejected persists, tenant-isolated', async () => {
      const agent = A.actors.COURIER!; // distinct user is not allowed to push; use a fresh agent for a clean one-row assertion
      void agent;
      const fresh = await addUser(A, 'SALES_AGENT', 'SyncAudit');
      const since = new Date(Date.now() - 1000);
      const clientId = randomUUID();
      const res = await post('/sync/push', fresh, {
        documents: [{ type: 'order', clientId, payload: { customerId: A.customerId, clientId, courierId: A.actors.COURIER!.userId, lines: [{ productId: A.productId, packagingId: A.packagingId, qty: 1 }] } }],
      });
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect(res.body.results[0].status).toBe('REJECTED');
      await expectAuditIsolated(await rejectedAudit(A, fresh.userId, since), fresh.userId);
    });

    it('SALES_AGENT /sync/push order with courierId => REJECTED, no order, no reservation', async () => {
      const clientId = randomUUID();
      const reservedBefore = await reserved(A);
      const res = await post('/sync/push', A.actors.SALES_AGENT!, {
        documents: [
          {
            type: 'order',
            clientId,
            payload: {
              customerId: A.customerId,
              clientId,
              courierId: A.actors.COURIER!.userId,
              lines: [{ productId: A.productId, packagingId: A.packagingId, qty: 2 }],
            },
          },
        ],
      });
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect(res.body.results).toHaveLength(1);
      expect(['REJECTED', 'FAILED']).toContain(res.body.results[0].status);
      expect(await tenantPrisma.run(A.id, () => tenantPrisma.client.salesOrder.count({ where: { clientId } }))).toBe(0);
      expect(await reserved(A)).toBe(reservedBefore);
    });
  });

  describe('6. full flows over HTTP', () => {
    it('agent create => director confirm => warehouse assign (CONFIRMED) => handover (SHIPPED, no ISSUE, no invoice) => courier partial deliver => invoice only after DELIVERED', async () => {
      const agent = A.actors.SALES_AGENT!;
      const created = await post('/orders', agent, { customerId: A.customerId, lines: [{ productId: A.productId, packagingId: A.packagingId, qty: 10 }] });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.id as string;
      expect(created.body.status).toBe('SUBMITTED');
      const reserved0 = Number(await reserved(A));

      const conf = await post(`/orders/${id}/confirm`, A.actors.SALES_DIRECTOR!).expect(201);
      expect(conf.body.status).toBe('CONFIRMED');
      expect(Number(await reserved(A))).toBe(reserved0 + 10);
      expect(await movements(A, id, 'RESERVE')).toBeGreaterThan(0);

      const courier = A.actors.COURIER!;
      const asg = await post(`/orders/${id}/assign-courier`, A.actors.WAREHOUSE!, { courierId: courier.userId });
      expect(asg.status, JSON.stringify(asg.body)).toBe(201);
      expect(asg.body.status).toBe('CONFIRMED');
      // Assigned but not handed over: deliver => 409 SALES_ORDER_HANDOVER_REQUIRED, nothing issued.
      const early = await post(`/orders/${id}/deliver`, courier);
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('SALES_ORDER_HANDOVER_REQUIRED');
      const ship = await post(`/orders/${id}/handover`, A.actors.WAREHOUSE!);
      expect(ship.status, JSON.stringify(ship.body)).toBe(201);
      expect(ship.body.status).toBe('SHIPPED');
      expect(await movements(A, id, 'ISSUE')).toBe(0);
      expect(await invoices(A, id)).toBe(0);
      expect(Number(await reserved(A))).toBe(reserved0 + 10);

      // Another courier cannot deliver it.
      await post(`/orders/${id}/deliver`, courier2A).expect(403);
      expect((await snapshot(A, id)).status).toBe('SHIPPED');

      const full = await get(`/orders/${id}`, courier).expect(200);
      const lineId = full.body.lines[0].id as string;
      // Partial issue is warehouse/management only (SALES_PARTIAL_DELIVERY_NOT_ALLOWED for a courier).
      const denied403 = await post(`/orders/${id}/deliver`, courier, { lines: [{ lineId, deliveredQty: '6' }] });
      expect(denied403.status).toBe(403);
      expect(denied403.body.code).toBe('SALES_PARTIAL_DELIVERY_NOT_ALLOWED');
      expect(await invoices(A, id)).toBe(0);
      const del = await post(`/orders/${id}/deliver`, A.actors.WAREHOUSE!, { lines: [{ lineId, deliveredQty: '6' }] });
      expect(del.status, JSON.stringify(del.body)).toBe(201);
      expect(del.body.status).toBe('DELIVERED');
      expect(await invoices(A, id)).toBe(1);
      const issued = await tenantPrisma.run(A.id, () => tenantPrisma.client.stockMovement.findMany({ where: { refId: id, type: 'ISSUE' } }));
      expect(issued.reduce((s, m) => s + Number(m.qty), 0)).toBe(6);
      expect(Number(await reserved(A))).toBe(reserved0); // undelivered remainder released
    });

    it('confirm => director cancel releases the reserve exactly once; repeat cancel is an idempotent no-op, no double release', async () => {
      const dir = A.actors.SALES_DIRECTOR!;
      const id = await newOrder(A, 7);
      const r0 = Number(await reserved(A));
      await post(`/orders/${id}/confirm`, dir).expect(201);
      expect(Number(await reserved(A))).toBe(r0 + 7);
      await post(`/orders/${id}/cancel`, dir, { reason: 'customer refused' }).expect(201);
      expect(Number(await reserved(A))).toBe(r0);
      expect(await movements(A, id, 'RELEASE')).toBe(1);
      const again = await post(`/orders/${id}/cancel`, dir, { reason: 'customer refused' });
      expect(again.status).toBe(201); // service returns the CANCELLED order unchanged
      expect(again.body.status).toBe('CANCELLED');
      expect(Number(await reserved(A))).toBe(r0);
      expect(await movements(A, id, 'RELEASE')).toBe(1);
    });

    it('SHIPPED => cancel 409 SALES_ORDER_SHIPPED_REQUIRES_RETURN => return-to-warehouse => cancel OK, reserve released once', async () => {
      const dir = A.actors.SALES_DIRECTOR!;
      const id = await newOrder(A, 4);
      const r0 = Number(await reserved(A));
      await post(`/orders/${id}/confirm`, dir).expect(201);
      await post(`/orders/${id}/assign-courier`, A.actors.WAREHOUSE!, { courierId: A.actors.COURIER!.userId }).expect(201);
      await post(`/orders/${id}/handover`, A.actors.WAREHOUSE!).expect(201);
      const blocked = await post(`/orders/${id}/cancel`, dir, { reason: 'too late' });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('SALES_ORDER_SHIPPED_REQUIRES_RETURN');
      expect((await snapshot(A, id)).status).toBe('SHIPPED');
      expect(Number(await reserved(A))).toBe(r0 + 4);
      await post(`/orders/${id}/return-to-warehouse`, A.actors.WAREHOUSE!, { reason: 'courier returned' }).expect(201);
      expect(Number(await reserved(A))).toBe(r0 + 4); // reservation kept
      await post(`/orders/${id}/cancel`, dir, { reason: 'after return' }).expect(201);
      expect(Number(await reserved(A))).toBe(r0);
      expect(await movements(A, id, 'RELEASE')).toBe(1);
      expect(await invoices(A, id)).toBe(0);
    });

    it('ADR-069/070: assign repeat no-op; handover repeat no-op (one audit); reassign in SHIPPED 409; handover without courier 409; return from DELIVERED 409', async () => {
      const wh = A.actors.WAREHOUSE!;
      const courierId = A.actors.COURIER!.userId;
      const audits = (id: string, action: string) => tenantPrisma.run(A.id, () => tenantPrisma.client.auditLog.count({ where: { entityId: id, action } }));
      const id = await confirmed(A, 2);

      const noCourier = await post(`/orders/${id}/handover`, wh);
      expect(noCourier.status).toBe(409);
      expect(noCourier.body.code).toBe('SALES_ORDER_HANDOVER_NO_COURIER');

      await post(`/orders/${id}/assign-courier`, wh, { courierId }).expect(201);
      await post(`/orders/${id}/assign-courier`, wh, { courierId }).expect(201);
      expect(await audits(id, 'order.assignCourier')).toBe(1);

      await post(`/orders/${id}/handover`, wh).expect(201);
      const again = await post(`/orders/${id}/handover`, wh, { courierId });
      expect(again.status).toBe(201);
      expect(again.body.status).toBe('SHIPPED');
      expect(await audits(id, 'order.handover')).toBe(1);

      const reassign = await post(`/orders/${id}/assign-courier`, wh, { courierId: courier2A.userId });
      expect(reassign.status).toBe(409);
      expect(reassign.body.code).toBe('SALES_ORDER_ALREADY_HANDED_OVER');
      expect((await snapshot(A, id)).courierId).toBe(courierId);
      expect(await movements(A, id, 'ISSUE')).toBe(0);
      expect(await invoices(A, id)).toBe(0);

      await post(`/orders/${id}/deliver`, A.actors.COURIER!).expect(201);
      expect(await movements(A, id, 'ISSUE')).toBe(1);
      expect(await invoices(A, id)).toBe(1);
      const ret = await post(`/orders/${id}/return-to-warehouse`, wh, { reason: 'too late now' });
      expect(ret.status).toBe(409);
      expect(ret.body.code).toBe('SALES_ORDER_RETURN_INVALID_STATUS');
      expect((await snapshot(A, id)).status).toBe('DELIVERED');
    });

    it('return-to-warehouse: same Idempotency-Key replays, a new key => 409, one audit', async () => {
      const wh = A.actors.WAREHOUSE!;
      const id = await confirmed(A, 1);
      await post(`/orders/${id}/assign-courier`, wh, { courierId: A.actors.COURIER!.userId }).expect(201);
      await post(`/orders/${id}/handover`, wh).expect(201);
      const key = randomUUID();
      const send = () => http().post(`/orders/${id}/return-to-warehouse`).set(bearer(wh)).set('Idempotency-Key', key).send({ reason: 'came back' });
      const r1 = await send();
      expect(r1.status, JSON.stringify(r1.body)).toBe(201);
      const r2 = await send();
      expect(r2.status).toBe(201);
      expect(r2.body.status).toBe('CONFIRMED');
      const r3 = await post(`/orders/${id}/return-to-warehouse`, wh, { reason: 'came back' });
      expect(r3.status).toBe(409);
      expect(await tenantPrisma.run(A.id, () => tenantPrisma.client.auditLog.count({ where: { entityId: id, action: 'order.returnToWarehouse' } }))).toBe(1);
    });

    it('POST /orders with courierId (office) => CONFIRMED + courier + reserved, not SHIPPED', async () => {
      const phone = uniquePhone();
      const u = await systemPrisma.user.create({
        data: { companyId: A.id, firstName: 'OwnerCreate', lastName: 'Rbac', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
      });
      const perms = await Promise.all(
        permissionKeysForRole('OWNER').map((k) => {
          const [module, code] = k.split('.');
          return ensurePermission(module!, code!);
        }),
      );
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${A.id}, true)`;
        const role = await tx.role.create({ data: { companyId: A.id, code: 'OWNER', name: 'OWNER', isSystem: true } });
        await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
        await tx.userRole.create({ data: { userId: u.id, roleId: role.id } });
      });
      const owner: Actor = { token: (await loginWithMfa(app, phone, password)).accessToken, userId: u.id, phone };
      const r0 = Number(await reserved(A));
      const res = await post('/orders', owner, {
        customerId: A.customerId,
        agentId: A.actors.SALES_AGENT!.userId,
        courierId: A.actors.COURIER!.userId,
        lines: [{ productId: A.productId, packagingId: A.packagingId, qty: 3 }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.status).toBe('CONFIRMED');
      expect(res.body.courierId).toBe(A.actors.COURIER!.userId);
      expect(Number(await reserved(A))).toBe(r0 + 3);
      expect(await movements(A, res.body.id as string, 'ISSUE')).toBe(0);
    });
  });
});
