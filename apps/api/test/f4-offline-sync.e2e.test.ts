import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import { prisma, systemPrisma } from '@velto/database';
import { permissionKeysForRole } from '../../../packages/database/src/rbac-catalog';
import { AppModule } from '../src/app.module';
import { expectWithinBudget } from '../src/common/testing/perf';
import { configureApp } from '../src/bootstrap';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { SalesService } from '../src/modules/sales/sales.service';
import { uniquePhone } from './unique-phone';

/**
 * F4.3/F4.4 (TZ §8.5, §16.2): offline sync QA over HTTP on real Postgres + RLS.
 * 20 offline orders, triple resend, mixed batch, mid-batch failure, parallel clientId,
 * revoked agent, pull cursor / tombstones / scope, perf (NFR-PERF-004..006).
 */
describe('E2E F4 offline sync (TZ 8.5 / 16.2)', () => {
  vi.setConfig({ testTimeout: 30_000 }); // 20-doc pushes x3 are slow while the whole suite runs in parallel
  let app: INestApplication;
  let sales: SalesService;
  let cid: string;
  let productId: string;
  let packagingId: string;
  let warehouseId: string;
  let customerId: string;
  let blockedCustomerId: string;
  let perfCid: string;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tokens: Record<string, { token: string; userId: string }> = {};
  const auth = (k: string) => ({ Authorization: `Bearer ${tokens[k]!.token}` });
  const http = () => request(app.getHttpServer());
  const push = (k: string, documents: unknown[]) => http().post('/sync/push').set(auth(k)).send({ documents });
  const pull = (k: string, qs = '') => http().get(`/sync/pull${qs}`).set(auth(k));
  const run = <T>(c: string, fn: () => Promise<T>, o?: { timeout?: number }) => tenantPrisma.run(c, fn, o);
  const rid = () => randomUUID().slice(0, 8);

  const orderDoc = (opts: { expectedUnitPrice?: string; customer?: string; qty?: number } = {}) => {
    const clientId = randomUUID();
    const line = {
      productId,
      packagingId,
      qty: opts.qty ?? 1,
      ...(opts.expectedUnitPrice !== undefined && { expectedUnitPrice: opts.expectedUnitPrice }),
    };
    return { type: 'order', clientId, payload: { customerId: opts.customer ?? customerId, clientId, lines: [line] } };
  };
  const batch = (n: number) => Array.from({ length: n }, () => orderDoc({ expectedUnitPrice: '10000' }));
  const ordersFor = (ids: string[]) => run(cid, () => tenantPrisma.client.salesOrder.findMany({ where: { clientId: { in: ids } } }));
  const soCounter = () =>
    run(cid, async () => (await tenantPrisma.client.documentCounter.findFirst({ where: { docType: 'SO', year: new Date().getFullYear() } }))?.lastNumber ?? 0);
  const reserved = () =>
    run(cid, async () => (await tenantPrisma.client.stockLevel.findFirst({ where: { productId, warehouseId } }))?.reserved.toString());
  const orderCount = () => run(cid, () => tenantPrisma.client.salesOrder.count());

  async function seedCompany(label: string, roles: string[]) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-f4o-${label}-${Date.now()}-${rid()}`, name: `F4O ${label}` } });
    const c = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `F4O ${label}` } })).id;
    const roleIds: Record<string, string> = {};
    for (const roleCode of roles) {
      const permissionIds: string[] = [];
      for (const key of permissionKeysForRole(roleCode)) {
        const [module, code] = key.split('.');
        permissionIds.push((await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } })).id);
      }
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${c}, true)`;
        const role = await tx.role.create({ data: { companyId: c, code: roleCode, name: roleCode, isSystem: true } });
        for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
        roleIds[roleCode] = role.id;
      });
    }
    return { cid: c, roleIds };
  }
  async function mkUser(key: string, c: string, roleId: string) {
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: { companyId: c, firstName: key, lastName: 'F4o', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${c}, true)`;
      await tx.userRole.create({ data: { userId: user.id, roleId } });
    });
    const res = await http().post('/auth/login').send({ phone, password }).expect(201);
    tokens[key] = { token: res.body.accessToken, userId: user.id };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.init();
    sales = app.get(SalesService);

    const a = await seedCompany('A', ['SALES_AGENT', 'OWNER']);
    cid = a.cid;
    await run(cid, async () => {
      const tx = tenantPrisma.client;
      warehouseId = (await tx.warehouse.create({ data: { companyId: cid, name: 'F4O WH' } })).id;
      const p = await tx.product.create({ data: { companyId: cid, sku: `F4O-${rid()}`, name: 'F4O P', baseUnit: 'dona', vatRate: 12 } });
      productId = p.id;
      packagingId = (await tx.productPackaging.create({ data: { productId, name: 'dona', qtyInBaseUnit: 1, isDefault: true } })).id;
      const pl = await tx.priceList.create({ data: { companyId: cid, name: 'Default', isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: pl.id, productId, price: '10000' } });
      await tx.stockLevel.create({ data: { productId, warehouseId, onHand: 100000 } });
      customerId = (await tx.customer.create({ data: { companyId: cid, code: `F4O-C-${rid()}`, name: 'C' } })).id;
      blockedCustomerId = (await tx.customer.create({ data: { companyId: cid, code: `F4O-B-${rid()}`, name: 'Blocked', isBlocked: true } })).id;
    });
    await mkUser('AGENT1', cid, a.roleIds.SALES_AGENT!);
    await mkUser('AGENT2', cid, a.roleIds.SALES_AGENT!);
    await mkUser('AGENT_REVOKED', cid, a.roleIds.SALES_AGENT!);
    await mkUser('AGENT_NOPERM', cid, a.roleIds.SALES_AGENT!);
    await mkUser('OWNER', cid, a.roleIds.OWNER!);
  }, 120_000);

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('8.5 / 16.2: 20 unique offline orders in one push => 20 ACCEPTED, 20 distinct orders and SO numbers, gapless counter', async () => {
    const docs = batch(20);
    const counterBefore = await soCounter();
    const res = await push('AGENT1', docs).expect(201);
    expect(res.body.results).toHaveLength(20);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(Array(20).fill('ACCEPTED'));
    expect(res.body.results.map((r: { clientId: string }) => r.clientId)).toEqual(docs.map((d) => d.clientId)); // order preserved
    const orders = await ordersFor(docs.map((d) => d.clientId));
    expect(new Set(orders.map((o) => o.clientId)).size).toBe(20);
    expect(new Set(orders.map((o) => o.number)).size).toBe(20);
    expect(new Set(res.body.results.map((r: { id: string }) => r.id)).size).toBe(20);
    expect((await soCounter()) - counterBefore).toBe(20);
    expect(orders.every((o) => o.agentId === tokens.AGENT1!.userId)).toBe(true);
  });

  it('8.5 / 16.2: same 20-batch resent 3x => 2nd/3rd are 20 DUPLICATE with the same ids; still 20 orders, SO counter and reservation unchanged', async () => {
    const docs = batch(20);
    const first = await push('AGENT1', docs).expect(201);
    const ids = first.body.results.map((r: { id: string }) => r.id);
    const counter = await soCounter();
    const reservedBefore = await reserved();
    const ordersBefore = await orderCount();
    for (let i = 0; i < 2; i++) {
      const again = await push('AGENT1', docs).expect(201);
      expect(again.body.results.map((r: { status: string }) => r.status)).toEqual(Array(20).fill('DUPLICATE'));
      expect(again.body.results.map((r: { id: string }) => r.id)).toEqual(ids);
    }
    expect((await ordersFor(docs.map((d) => d.clientId))).length).toBe(20);
    expect(await orderCount()).toBe(ordersBefore);
    expect(await soCounter()).toBe(counter);
    expect(await reserved()).toBe(reservedBefore);
  });

  it('8.5 / 16.2: mixed batch (valid, PRICE_CHANGED, blocked customer, forced RETRY) => each item correct, nothing from CONFLICT/REJECTED/RETRY written', async () => {
    const valid = orderDoc({ expectedUnitPrice: '10000' });
    const conflict = orderDoc({ expectedUnitPrice: '9000' });
    const blocked = orderDoc({ customer: blockedCustomerId });
    const retry = orderDoc();
    const valid2 = orderDoc();
    const original = sales.createWithOutcome.bind(sales);
    vi.spyOn(sales, 'createWithOutcome').mockImplementation(async (dto, u) => {
      if (dto.clientId === retry.clientId) {
        await original(dto, u); // real write that the savepoint must discard
        throw new Error('connection reset');
      }
      return original(dto, u);
    });
    const counterBefore = await soCounter();
    const res = await push('AGENT1', [valid, conflict, blocked, retry, valid2]).expect(201);
    const r = res.body.results;
    expect(r.map((x: { status: string }) => x.status)).toEqual(['ACCEPTED', 'CONFLICT', 'REJECTED', 'RETRY', 'ACCEPTED']);
    expect(r[1].error.code).toBe('PRICE_CHANGED');
    expect(r[1].error.details.lines[0]).toMatchObject({ expectedUnitPrice: '9000.00', serverUnitPrice: '10000.00' });
    expect(r[2].error.code).toBe('SALES_CUSTOMER_BLOCKED');
    expect(r[3].error.code).toBe('SYNC_RETRY');
    const stored = await ordersFor([valid, conflict, blocked, retry, valid2].map((d) => d.clientId));
    expect(stored.map((o) => o.clientId).sort()).toEqual([valid.clientId, valid2.clientId].sort());
    expect((await soCounter()) - counterBefore).toBe(2); // no number burnt by CONFLICT/REJECTED/RETRY
  });

  it('16.2: mid-batch failure then resend of the WHOLE batch => no double effects (19 DUPLICATE + the failed one ACCEPTED)', async () => {
    const docs = batch(20);
    const failing = docs[9]!;
    const original = sales.createWithOutcome.bind(sales);
    const spy = vi.spyOn(sales, 'createWithOutcome').mockImplementation(async (dto, u) => {
      if (dto.clientId === failing.clientId) throw new Error('network died');
      return original(dto, u);
    });
    const first = await push('AGENT1', docs).expect(201);
    expect(first.body.results.filter((x: { status: string }) => x.status === 'ACCEPTED')).toHaveLength(19);
    expect(first.body.results[9].status).toBe('RETRY');
    expect((await ordersFor(docs.map((d) => d.clientId))).length).toBe(19);
    spy.mockRestore();

    const second = await push('AGENT1', docs).expect(201);
    const statuses = second.body.results.map((x: { status: string }) => x.status);
    expect(statuses.filter((s: string) => s === 'DUPLICATE')).toHaveLength(19);
    expect(statuses[9]).toBe('ACCEPTED');
    const orders = await ordersFor(docs.map((d) => d.clientId));
    expect(orders).toHaveLength(20);
    expect(new Set(orders.map((o) => o.number)).size).toBe(20);
  });

  it('16.3 / 8.5: the same clientId pushed in parallel from two connections => exactly one ACCEPTED, one order', async () => {
    for (let round = 0; round < 3; round++) {
      const doc = orderDoc({ expectedUnitPrice: '10000' });
      const res = await Promise.all([push('AGENT1', [doc]), push('AGENT1', [doc]), push('AGENT1', [doc])]);
      const statuses = res.map((x) => x.body.results?.[0]?.status).sort();
      expect(statuses).toEqual(['ACCEPTED', 'DUPLICATE', 'DUPLICATE']);
      expect(new Set(res.map((x) => x.body.results[0].id)).size).toBe(1);
      expect(await ordersFor([doc.clientId])).toHaveLength(1);
    }
  });

  it('16.2 logout/revoke: deactivated agent => 401 and nothing written; agent whose permissions were revoked => 403 and nothing written', async () => {
    const before = await orderCount();
    await systemPrisma.user.update({ where: { id: tokens.AGENT_REVOKED!.userId }, data: { isActive: false } });
    const d1 = orderDoc();
    await push('AGENT_REVOKED', [d1]).expect(401);
    await pull('AGENT_REVOKED').expect(401);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${cid}, true)`;
      await tx.userRole.deleteMany({ where: { userId: tokens.AGENT_NOPERM!.userId } });
    });
    const d2 = orderDoc();
    await push('AGENT_NOPERM', [d2]).expect(403);
    expect(await ordersFor([d1.clientId, d2.clientId])).toHaveLength(0);
    expect(await orderCount()).toBe(before);
  });

  describe('pull (8 / 10.2)', () => {
    it('after push, the agent pull stays consistent (200, cursor advances) and the pushed orders are server-visible via /orders', async () => {
      const docs = batch(3);
      const p0 = await pull('AGENT2').expect(200);
      const res = await push('AGENT2', docs).expect(201);
      const p1 = await pull('AGENT2', `?cursor=${encodeURIComponent(p0.body.cursor)}`).expect(200);
      expect(typeof p1.body.cursor).toBe('string');
      for (const r of res.body.results) {
        const o = await http().get(`/orders/${r.id}`).set(auth('AGENT2')).expect(200);
        expect(o.body.clientId).toBe(r.clientId);
      }
    });

    it('cursor flow with concurrent writes: no row is skipped across pages (union covers rows existing before AND inserted during paging)', async () => {
      const mk = (n: number, tag: string) =>
        run(cid, async () => {
          const ids: string[] = [];
          for (let i = 0; i < n; i++) {
            ids.push((await tenantPrisma.client.product.create({ data: { companyId: cid, sku: `F4O-${tag}-${rid()}-${i}`, name: `P ${tag} ${i}`, baseUnit: 'dona', vatRate: 12 } })).id);
          }
          return ids;
        });
      const before = await mk(30, 'pre');
      const seen = new Set<string>();
      let cursor: string | undefined;
      let during: string[] = [];
      for (let page = 0; page < 200; page++) {
        const qs = `?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const [res, created] = await Promise.all([pull('OWNER', qs).expect(200), page === 1 ? mk(10, 'mid') : Promise.resolve([] as string[])]);
        if (page === 1) during = created;
        for (const p of res.body.products) seen.add(p.id);
        cursor = res.body.cursor;
        if (!res.body.hasMore) break;
      }
      // a final pull after the last cursor must deliver anything committed behind the page boundary
      const tail = await pull('OWNER', `?cursor=${encodeURIComponent(cursor!)}`).expect(200);
      for (const p of tail.body.products) seen.add(p.id);
      for (const id of [...before, ...during]) expect(seen.has(id), `product ${id} skipped`).toBe(true);
    }, 60_000);

    it('tombstones: deleting a product and a customer reaches a second device that pulls from its old cursor', async () => {
      const [prodId, custId] = await run(cid, async () => {
        const tx = tenantPrisma.client;
        const p = await tx.product.create({ data: { companyId: cid, sku: `F4O-DEL-${rid()}`, name: 'del', baseUnit: 'dona', vatRate: 12 } });
        const c = await tx.customer.create({ data: { companyId: cid, code: `F4O-DEL-${rid()}`, name: 'del' } });
        return [p.id, c.id] as const;
      });
      // device 1 and device 2 both sync everything including the doomed rows
      const drain = async () => {
        let cursor: string | undefined;
        for (let i = 0; i < 200; i++) {
          const res = await pull('OWNER', `?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200);
          cursor = res.body.cursor;
          if (!res.body.hasMore) return cursor!;
        }
        throw new Error('pull never finished');
      };
      const cursor2 = await drain();
      await run(cid, async () => {
        await tenantPrisma.client.product.delete({ where: { id: prodId } });
        await tenantPrisma.client.customer.delete({ where: { id: custId } });
        // FK checks on Invoice/Payment/Outlet(customerId) have no standalone customerId index: ~0.7s each on a 1.2M-customer dev DB, >5s under load.
      }, { timeout: 30_000 });
      const res = await pull('OWNER', `?cursor=${encodeURIComponent(cursor2)}`).expect(200);
      const tomb = res.body.tombstones as Array<{ entity: string; entityId: string }>;
      expect(tomb.some((t) => t.entity === 'Product' && t.entityId === prodId)).toBe(true);
      expect(tomb.some((t) => t.entity === 'Customer' && t.entityId === custId)).toBe(true);
      expect(res.body.products.some((p: { id: string }) => p.id === prodId)).toBe(false);
    });

    it('agent scope pruning: route change forces fullResync and delivers/prunes exactly the in-scope customers', async () => {
      const [o1, o2, c1, c2, agentId] = await run(cid, async () => {
        const tx = tenantPrisma.client;
        const mk = async (n: string) => {
          const c = await tx.customer.create({ data: { companyId: cid, code: `F4O-S${n}-${rid()}`, name: `S${n}`, updatedAt: new Date(Date.now() - 3_600_000) } });
          const o = await tx.outlet.create({ data: { companyId: cid, customerId: c.id, name: `SO${n}`, updatedAt: new Date(Date.now() - 3_600_000) } });
          return [o.id, c.id] as const;
        };
        const [oa, ca] = await mk('1');
        const [ob, cb] = await mk('2');
        const route = await tx.route.create({ data: { companyId: cid, agentId: tokens.AGENT2!.userId, weekday: 2, name: 'F4O R' } });
        await tx.routeStop.create({ data: { routeId: route.id, outletId: oa, sortOrder: 1 } });
        return [oa, ob, ca, cb, route.id] as const;
      });
      const first = await pull('AGENT2').expect(200);
      expect(first.body.customers.map((c: { id: string }) => c.id)).toContain(c1);
      expect(first.body.customers.map((c: { id: string }) => c.id)).not.toContain(c2);

      await run(cid, () => tenantPrisma.client.routeStop.create({ data: { routeId: agentId, outletId: o2, sortOrder: 2 } }));
      const grown = await pull('AGENT2', `?cursor=${encodeURIComponent(first.body.cursor)}`).expect(200);
      expect(grown.body.fullResync).toBe(true);
      expect(grown.body.customers.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining([c1, c2]));

      await run(cid, () => tenantPrisma.client.routeStop.deleteMany({ where: { routeId: agentId, outletId: o2 } }));
      const shrunk = await pull('AGENT2', `?cursor=${encodeURIComponent(grown.body.cursor)}`).expect(200);
      expect(shrunk.body.fullResync).toBe(true);
      expect(shrunk.body.scope.customerIds).toContain(c1);
      expect(shrunk.body.scope.customerIds).not.toContain(c2);
      expect(shrunk.body.scope.outletIds).not.toContain(o2);
    }, 30_000);
  });

  describe('perf (NFR-PERF-004..006, generous thresholds)', () => {
    it('pull of 5k products + 2k customers < 8 s; push of 20 offline docs < 3 s', async () => {
      const p = await seedCompany('P', ['OWNER']);
      perfCid = p.cid;
      await mkUser('PERF_OWNER', perfCid, p.roleIds.OWNER!);
      await systemPrisma.product.createMany({
        data: Array.from({ length: 5000 }, (_, i) => ({ companyId: perfCid, sku: `PERF-${i}`, name: `Perf product ${i}`, baseUnit: 'dona', vatRate: 12 })),
      });
      await systemPrisma.customer.createMany({
        data: Array.from({ length: 2000 }, (_, i) => ({ companyId: perfCid, code: `PERF-C-${i}`, name: `Perf customer ${i}` })),
      });

      const t0 = performance.now();
      let cursor: string | undefined;
      let pages = 0;
      let products = 0;
      let customers = 0;
      for (;;) {
        const res = await pull('PERF_OWNER', `?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200);
        pages++;
        products += res.body.products.length;
        customers += res.body.customers.length;
        cursor = res.body.cursor;
        if (!res.body.hasMore) break;
      }
      const pullMs = Math.round(performance.now() - t0);
      expect(products).toBe(5000);
      expect(customers).toBe(2000);

      const docs = batch(20);
      const t1 = performance.now();
      const res = await push('AGENT1', docs).expect(201);
      const pushMs = Math.round(performance.now() - t1);
      expect(res.body.results.every((r: { status: string }) => r.status === 'ACCEPTED' || r.status === 'DUPLICATE')).toBe(true);
      // eslint-disable-next-line no-console
      console.log(`[F4 PERF] full pull 5k products + 2k customers: ${pullMs} ms over ${pages} pages; push 20 orders: ${pushMs} ms`);
      expectWithinBudget("F4 full pull 5k+2k", pullMs, 8000);
      expectWithinBudget("F4 push 20 orders", pushMs, 3000);
    }, 120_000);
  });
});
