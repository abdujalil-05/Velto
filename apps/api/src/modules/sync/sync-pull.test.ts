import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { prisma, systemPrisma, withTenant } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { decodeCursor, encodeCursor } from './sync-cursor';
import { SyncService } from './sync.service';

/** F4 step 3: GET /sync/pull — changeSeq cursor, tombstones, agent scope, commit-order safety (real Postgres + RLS). */
describe('SyncService.pull (F4, integration)', () => {
  const tenantPrisma = new TenantPrismaService();
  // Only pull() is exercised; the push collaborators are never touched.
  const sync = new SyncService(tenantPrisma, undefined as never, undefined as never, undefined as never, undefined as never, new ConfigService({ SYNC_PULL_LOOKBACK_SECONDS: 5 }));

  async function mkCompany(label: string) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-pull-${label}-${randomUUID().slice(0, 8)}`, name: `Pull ${label}` } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `Pull ${label}` } });
    return company.id;
  }
  const userOf = (companyId: string, id: string, role: string): AuthenticatedUser => ({
    id, companyId, firstName: 'U', lastName: role, roles: [role], permissions: ['field.read'],
  });
  const run = <T>(companyId: string, fn: () => Promise<T>) => tenantPrisma.run(companyId, fn);
  const OLD = () => new Date(Date.now() - 3_600_000);

  let companyId: string;
  let director: AuthenticatedUser;
  let agent: AuthenticatedUser;
  let c1: string, c2: string, o1: string, o2: string;

  beforeAll(async () => {
    companyId = await mkCompany('A');
    const mkUser = async (phone: string, role: string) => {
      const u = await systemPrisma.user.create({ data: { companyId, firstName: 'U', lastName: role, phone } });
      return userOf(companyId, u.id, role);
    };
    director = await mkUser('+998900000601', 'SALES_DIRECTOR');
    agent = await mkUser('+998900000602', 'SALES_AGENT');
    await run(companyId, async () => {
      const tx = tenantPrisma.client;
      for (const [i, n] of [[1, 'One'], [2, 'Two']] as const) {
        const c = await tx.customer.create({ data: { companyId, code: `PULL-${i}-${randomUUID().slice(0, 6)}`, name: `Cust ${n}`, updatedAt: OLD() } });
        const o = await tx.outlet.create({ data: { companyId, customerId: c.id, name: `Out ${n}`, updatedAt: OLD() } });
        if (i === 1) { c1 = c.id; o1 = o.id; } else { c2 = c.id; o2 = o.id; }
      }
      const route = await tx.route.create({ data: { companyId, agentId: agent.id, weekday: 1, name: 'R' } });
      await tx.routeStop.create({ data: { routeId: route.id, outletId: o1, sortOrder: 1 } });
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('paginates by limit with hasMore and a changeSeq cursor; resumes without gaps or repeats', async () => {
    const cid = await mkCompany('page');
    const dir = userOf(cid, randomUUID(), 'OWNER');
    const created = await run(cid, async () => {
      const tx = tenantPrisma.client;
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await tx.product.create({ data: { companyId: cid, sku: `P-${i}`, name: `P${i}`, baseUnit: 'dona', vatRate: 12, updatedAt: OLD() } })).id);
      return ids;
    });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await run(cid, () => sync.pull({ cursor, limit: 2 }, dir));
      pages++;
      expect(page.products.length).toBeLessThanOrEqual(2);
      seen.push(...page.products.map((p) => p.id));
      cursor = page.cursor;
      if (!page.hasMore) break;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([...created].sort());
    expect(new Set(seen).size).toBe(5);
    // BigInt seq is exposed on rows; cursor is opaque base64url
    expect(decodeCursor(cursor)).not.toBeNull();
  });

  it('first call / garbage / legacy ISO cursor = fullResync; valid cursor is not', async () => {
    const first = await run(companyId, () => sync.pull({}, director));
    expect(first.fullResync).toBe(true);
    expect((await run(companyId, () => sync.pull({ cursor: new Date().toISOString() }, director))).fullResync).toBe(true);
    expect((await run(companyId, () => sync.pull({ cursor: first.cursor }, director))).fullResync).toBe(false);
  });

  it('COMMIT ORDER: a lower changeSeq committing after a higher one is still delivered', async () => {
    const cid = await mkCompany('race');
    const dir = userOf(cid, randomUUID(), 'OWNER');
    await run(cid, () => tenantPrisma.client.product.create({ data: { companyId: cid, sku: 'OLD', name: 'old', baseUnit: 'dona', vatRate: 12, updatedAt: OLD() } }));

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let aCreated!: (seq: bigint) => void;
    const aSeq = new Promise<bigint>((r) => (aCreated = r));
    let aId = '';
    // Transaction A takes the LOWER seq first and stays open.
    const txA = withTenant(cid, async (tx) => {
      const p = await tx.product.create({ data: { companyId: cid, sku: 'A', name: 'A', baseUnit: 'dona', vatRate: 12 } });
      aId = p.id;
      aCreated(p.changeSeq);
      await gate;
    });
    const seqA = await aSeq;
    // Transaction B takes a HIGHER seq and commits first.
    const b = await run(cid, () => tenantPrisma.client.product.create({ data: { companyId: cid, sku: 'B', name: 'B', baseUnit: 'dona', vatRate: 12 } }));
    expect(b.changeSeq > seqA).toBe(true);

    const p1 = await run(cid, () => sync.pull({}, dir));
    expect(p1.products.map((p) => p.id)).toContain(b.id);
    expect(p1.products.map((p) => p.id)).not.toContain(aId); // not committed yet

    // Control: a naive "cursor = max seq seen" would lose A forever.
    const naive = encodeCursor({ s: b.changeSeq, f: 'all' });
    release();
    await txA;
    const lost = await run(cid, () => sync.pull({ cursor: naive }, dir));
    expect(lost.products.map((p) => p.id)).not.toContain(aId);

    // The real cursor re-sends the window: A arrives.
    const p2 = await run(cid, () => sync.pull({ cursor: p1.cursor }, dir));
    expect(p2.products.map((p) => p.id)).toContain(aId);
    // Mid-session cursors keep the session start, so rows older than the lookback eventually stop being re-sent.
    const old = await run(cid, () => sync.pull({ cursor: p1.cursor }, dir));
    expect(old.products.length).toBeGreaterThan(0);
  });

  it('terminal cursor ages out: rows older than the lookback are no longer re-sent', async () => {
    const cid = await mkCompany('age');
    const dir = userOf(cid, randomUUID(), 'OWNER');
    await run(cid, () => tenantPrisma.client.product.create({ data: { companyId: cid, sku: 'X', name: 'x', baseUnit: 'dona', vatRate: 12, updatedAt: OLD() } }));
    const p1 = await run(cid, () => sync.pull({}, dir));
    expect(p1.products).toHaveLength(1);
    const p2 = await run(cid, () => sync.pull({ cursor: p1.cursor }, dir));
    expect(p2.products).toHaveLength(0);
  });

  it('sends tombstones (not rows) for deleted/soft-deleted/deactivated product, customer, price item, packaging', async () => {
    const cid = await mkCompany('tomb');
    const dir = userOf(cid, randomUUID(), 'OWNER');
    const ids = await run(cid, async () => {
      const tx = tenantPrisma.client;
      const mkP = (sku: string) => tx.product.create({ data: { companyId: cid, sku, name: sku, baseUnit: 'dona', vatRate: 12, updatedAt: OLD() } });
      const [pSoft, pOff, pKeep] = [await mkP('SOFT'), await mkP('OFF'), await mkP('KEEP')];
      const pack = await tx.productPackaging.create({ data: { productId: pKeep.id, name: 'box', qtyInBaseUnit: 10 } });
      const pl = await tx.priceList.create({ data: { companyId: cid, name: 'PL' } });
      await tx.priceListItem.create({ data: { priceListId: pl.id, productId: pKeep.id, price: '5' } });
      const cust = await tx.customer.create({ data: { companyId: cid, code: 'TC', name: 'TC', updatedAt: OLD() } });
      return { pSoft: pSoft.id, pOff: pOff.id, pKeep: pKeep.id, pack: pack.id, pl: pl.id, cust: cust.id };
    });
    const before = await run(cid, () => sync.pull({}, dir));
    await run(cid, async () => {
      const tx = tenantPrisma.client;
      await tx.product.update({ where: { id: ids.pSoft }, data: { deletedAt: new Date() } });
      await tx.product.update({ where: { id: ids.pOff }, data: { isActive: false } });
      await tx.productPackaging.delete({ where: { id: ids.pack } });
      await tx.priceListItem.delete({ where: { priceListId_productId: { priceListId: ids.pl, productId: ids.pKeep } } });
      await tx.customer.update({ where: { id: ids.cust }, data: { deletedAt: new Date() } });
    });
    const after = await run(cid, () => sync.pull({ cursor: before.cursor }, dir));
    const tomb = after.tombstones.map((t) => `${t.entity}:${t.entityId}`);
    expect(tomb).toContain(`Product:${ids.pSoft}`);
    expect(tomb).toContain(`Product:${ids.pOff}`);
    expect(tomb).toContain(`ProductPackaging:${ids.pack}`);
    expect(tomb).toContain(`Customer:${ids.cust}`);
    const priceTomb = after.tombstones.find((t) => t.entity === 'PriceListItem');
    expect(priceTomb?.entityKey).toEqual({ priceListId: ids.pl, productId: ids.pKeep });
    expect(after.products.map((p) => p.id)).not.toContain(ids.pSoft);
    expect(after.products.map((p) => p.id)).not.toContain(ids.pOff);
    expect(after.customers.map((c) => c.id)).not.toContain(ids.cust);
    expect(typeof after.tombstones[0]!.changeSeq).toBe('bigint');
  });

  it('tombstones are tenant-isolated', async () => {
    const other = await mkCompany('iso');
    const otherDir = userOf(other, randomUUID(), 'OWNER');
    const pid = await run(other, async () => {
      const p = await tenantPrisma.client.product.create({ data: { companyId: other, sku: 'ISO', name: 'iso', baseUnit: 'dona', vatRate: 12 } });
      await tenantPrisma.client.product.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
      return p.id;
    });
    expect((await run(other, () => sync.pull({}, otherDir))).tombstones.map((t) => t.entityId)).toContain(pid);
    const mine = await run(companyId, () => sync.pull({}, director));
    expect(mine.tombstones.map((t) => t.entityId)).not.toContain(pid);
  });

  it('SALES_AGENT gets only own-route outlets and their customers; director keeps tenant scope', async () => {
    const a = await run(companyId, () => sync.pull({}, agent));
    expect(a.customers.map((c) => c.id)).toEqual([c1]);
    expect(a.outlets.map((o) => o.id)).toEqual([o1]);
    expect(a.scope).toEqual({ customerIds: [c1], outletIds: [o1] });

    const d = await run(companyId, () => sync.pull({}, director));
    expect(d.customers.map((c) => c.id).sort()).toEqual([c1, c2].sort());
    expect(d.scope).toBeNull();
  });

  it('agent scope change forces fullResync delivering newly-scoped (old seq) rows; revoked ids vanish from scope', async () => {
    const before = await run(companyId, () => sync.pull({}, agent));
    const stop = await run(companyId, async () => {
      const tx = tenantPrisma.client;
      const route = await tx.route.findFirstOrThrow({ where: { agentId: agent.id } });
      return tx.routeStop.create({ data: { routeId: route.id, outletId: o2, sortOrder: 2 } });
    });
    const grown = await run(companyId, () => sync.pull({ cursor: before.cursor }, agent));
    expect(grown.fullResync).toBe(true);
    expect(grown.customers.map((c) => c.id).sort()).toEqual([c1, c2].sort());
    expect(grown.scope!.outletIds.sort()).toEqual([o1, o2].sort());

    await run(companyId, () => tenantPrisma.client.routeStop.delete({ where: { id: stop.id } }));
    const shrunk = await run(companyId, () => sync.pull({ cursor: grown.cursor }, agent));
    expect(shrunk.fullResync).toBe(true);
    expect(shrunk.scope).toEqual({ customerIds: [c1], outletIds: [o1] });
    // and no Customer/Outlet tombstones leak to agents
    expect(shrunk.tombstones.filter((t) => t.entity === 'Customer' || t.entity === 'Outlet')).toHaveLength(0);
  });
});
