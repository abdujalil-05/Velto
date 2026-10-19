import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { prisma, systemPrisma } from '@velto/database';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { uniquePhone } from './unique-phone';

/**
 * F1.3 / TZ 16.3 "mutations idempotent under parallel calls": @Idempotent()
 * on confirm/deliver and cash-session close, driven over real HTTP through
 * the full Nest pipeline against real Postgres (RLS, app role).
 */
describe('E2E: Idempotency-Key on confirm / deliver / cash close (F1.3, 16.3)', () => {
  let app: INestApplication;
  let companyId: string;
  let token: string;
  let customerId: string;
  let productId: string;
  let packagingId: string;
  let warehouseId: string;
  const phone = uniquePhone();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test, key?: string) => {
    r.set('Authorization', `Bearer ${token}`);
    if (key) r.set('Idempotency-Key', key);
    return r;
  };

  async function inTenant<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      return fn(tx);
    });
  }

  async function newOrder(qty = 5): Promise<string> {
    const res = await auth(http().post('/orders')).send({ customerId, lines: [{ productId, packagingId, qty }] }).expect(201);
    return res.body.id;
  }
  const stock = () => inTenant((tx) => tx.stockLevel.findFirst({ where: { productId, warehouseId } }));
  const audits = (action: string, entityId: string) =>
    inTenant((tx) => tx.auditLog.count({ where: { action, entityId } }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.init();

    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-idem-${Date.now()}`, name: 'Idem Tenant' } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Idem Co' } });
    companyId = company.id;

    const codes = [
      ['orders', 'create'], ['orders', 'read'], ['orders', 'update'], ['orders', 'deliver'],
      ['cash', 'read'], ['cash', 'open'], ['cash', 'close'],
    ];
    const permissions = await Promise.all(
      codes.map(([module, code]) =>
        systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } }),
      ),
    );
    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Idem', lastName: 'Op', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    await prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      const role = await tx.role.create({ data: { companyId, code: 'IDEM_OP', name: 'Idem Op' } });
      await tx.rolePermission.createMany({ data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })) });
      await tx.userRole.create({ data: { userId: dbUser.id, roleId: role.id } });
      const wh = await tx.warehouse.create({ data: { companyId, name: 'Idem WH' } });
      warehouseId = wh.id;
      const product = await tx.product.create({ data: { companyId, sku: 'IDEM-1', name: 'Idem P', baseUnit: 'dona', vatRate: '12' } });
      productId = product.id;
      const pk = await tx.productPackaging.create({ data: { productId, name: 'dona', qtyInBaseUnit: '1', isDefault: true } });
      packagingId = pk.id;
      const pl = await tx.priceList.create({ data: { companyId, name: 'PL', isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: pl.id, productId, price: '10000.00' } });
      await tx.stockLevel.create({ data: { productId, warehouseId, onHand: '1000', reserved: '0' } });
      const c = await tx.customer.create({ data: { companyId, code: 'IDEM-C', name: 'Idem C' } });
      customerId = c.id;
    });
    const login = await http().post('/auth/login').send({ phone, password }).expect(201);
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('16.3: parallel confirm with ONE key => one result, one reservation, one audit', async () => {
    const id = await newOrder(5);
    const before = await stock();
    const key = randomUUID();
    const res = await Promise.all(Array.from({ length: 6 }, () => auth(http().post(`/orders/${id}/confirm`), key)));
    for (const r of res) expect(r.status).toBe(201);
    for (const r of res) expect(r.body.status).toBe('CONFIRMED');
    for (const r of res) expect(r.body).toEqual(res[0].body);
    const after = await stock();
    expect(Number(after.reserved) - Number(before.reserved)).toBe(5);
    expect(await audits('order.confirm', id)).toBe(1);
  });

  it('16.3: parallel deliver with ONE key => one invoice, one ISSUE movement, one audit', async () => {
    const id = await newOrder(3);
    await auth(http().post(`/orders/${id}/confirm`)).expect(201);
    const before = await stock();
    const key = randomUUID();
    const res = await Promise.all(Array.from({ length: 6 }, () => auth(http().post(`/orders/${id}/deliver`), key)));
    for (const r of res) expect(r.status).toBe(201);
    for (const r of res) expect(r.body).toEqual(res[0].body);
    expect(res[0].body.status).toBe('DELIVERED');
    expect(await inTenant((tx) => tx.invoice.count({ where: { orderId: id } }))).toBe(1);
    expect(
      await inTenant((tx) => tx.stockMovement.count({ where: { refId: id, type: 'ISSUE' } })),
    ).toBe(1);
    const after = await stock();
    expect(Number(before.onHand) - Number(after.onHand)).toBe(3);
    expect(await audits('order.deliver', id)).toBe(1);
  });

  it('F1.3: replay with same key => identical status+body, audit not duplicated', async () => {
    const id = await newOrder(2);
    const key = randomUUID();
    const first = await auth(http().post(`/orders/${id}/confirm`), key).expect(201);
    const reservedAfterFirst = Number((await stock()).reserved);
    const second = await auth(http().post(`/orders/${id}/confirm`), key);
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(Number((await stock()).reserved)).toBe(reservedAfterFirst);
    expect(await audits('order.confirm', id)).toBe(1);
  });

  it('F1.3: same key + different request => 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const a = await newOrder(1);
    const b = await newOrder(1);
    const key = randomUUID();
    await auth(http().post(`/orders/${a}/confirm`), key).expect(201);
    const res = await auth(http().post(`/orders/${b}/confirm`), key).expect(422);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // the second order must be untouched
    const o = await auth(http().get(`/orders/${b}`)).expect(200);
    expect(o.body.status).toBe('SUBMITTED');
  });

  it('F1.3: no key => ordinary flow, a repeated call hits the normal state rule (not replayed)', async () => {
    const id = await newOrder(1);
    const ok = await auth(http().post(`/orders/${id}/confirm`)).expect(201);
    expect(ok.body.status).toBe('CONFIRMED');
    const again = await auth(http().post(`/orders/${id}/confirm`));
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(await audits('order.confirm', id)).toBe(1);
    await auth(http().post(`/orders/${id}/deliver`)).expect(201);
  });

  it('F1.3: overlong key => 400 IDEMPOTENCY_KEY_INVALID', async () => {
    const id = await newOrder(1);
    const res = await auth(http().post(`/orders/${id}/confirm`), 'x'.repeat(129)).expect(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  it('F1.3: cash-session close replay => same response, one audit; different closeAmount => 422', async () => {
    const open = await auth(http().post('/cash-sessions/open')).send({ openAmount: 1000 }).expect(201);
    const id = open.body.id;
    const key = randomUUID();
    const parallel = await Promise.all(
      Array.from({ length: 4 }, () => auth(http().post(`/cash-sessions/${id}/close`), key).send({ closeAmount: 1500 })),
    );
    for (const r of parallel) expect(r.status).toBe(201);
    for (const r of parallel) expect(r.body).toEqual(parallel[0].body);
    const replay = await auth(http().post(`/cash-sessions/${id}/close`), key).send({ closeAmount: 1500 });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(parallel[0].body);
    expect(await audits('cash.close', id)).toBe(1);
    const reused = await auth(http().post(`/cash-sessions/${id}/close`), key).send({ closeAmount: 9999 }).expect(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
