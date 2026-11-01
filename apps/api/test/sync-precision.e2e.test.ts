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

/** ADR-059a over HTTP: POST /sync/push precision rejection (ORDER_QTY_PRECISION / SYNC_VALIDATION_FAILED), idempotent replay, payment scale. */
describe('E2E ADR-059a sync push precision', () => {
  vi.setConfig({ testTimeout: 30_000 });
  let app: INestApplication;
  let cid: string;
  let token: string;
  let customerId: string;
  let productId: string;
  let pkg1: string;
  let pkg15: string;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const rid = () => randomUUID().slice(0, 8);
  const push = (documents: unknown[]) => request(app.getHttpServer()).post('/sync/push').set('Authorization', `Bearer ${token}`).send({ documents });
  const orderDoc = (qty: number | string, packagingId: string, clientId = randomUUID()) => ({
    type: 'order',
    clientId,
    payload: { customerId, clientId, lines: [{ productId, packagingId, qty }] },
  });
  const paymentDoc = (amount: number | string, clientId = randomUUID()) => ({ type: 'payment', clientId, payload: { customerId, clientId, amount, method: 'CASH' } });
  const run = <T>(fn: () => Promise<T>) => tenantPrisma.run(cid, fn);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.listen(0, '127.0.0.1');

    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-sprec-${Date.now()}-${rid()}`, name: 'SyncPrec' } });
    cid = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'SyncPrec' } })).id;
    const permissionIds: string[] = [];
    for (const key of permissionKeysForRole('SALES_AGENT')) {
      const [module, code] = key.split('.');
      permissionIds.push((await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } })).id);
    }
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({ data: { companyId: cid, firstName: 'Ag', lastName: 'Prec', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) } });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${cid}, true)`;
      const role = await tx.role.create({ data: { companyId: cid, code: 'SALES_AGENT', name: 'SALES_AGENT', isSystem: true } });
      for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    });
    await run(async () => {
      const tx = tenantPrisma.client;
      const wh = await tx.warehouse.create({ data: { companyId: cid, name: 'WH' } });
      productId = (await tx.product.create({ data: { companyId: cid, sku: `SP-${rid()}`, name: 'SP', baseUnit: 'kg', vatRate: 12 } })).id;
      pkg1 = (await tx.productPackaging.create({ data: { productId, name: 'kg', qtyInBaseUnit: 1, isDefault: true } })).id;
      pkg15 = (await tx.productPackaging.create({ data: { productId, name: 'bag', qtyInBaseUnit: '1.5' } })).id;
      const pl = await tx.priceList.create({ data: { companyId: cid, name: 'Default', isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: pl.id, productId, price: '1000' } });
      await tx.stockLevel.create({ data: { productId, warehouseId: wh.id, onHand: 100000 } });
      customerId = (await tx.customer.create({ data: { companyId: cid, code: `SP-C-${rid()}`, name: 'C' } })).id;
    });
    token = (await loginWithMfa(app, phone, password)).accessToken;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  const ordersBy = (ids: string[]) => run(() => tenantPrisma.client.salesOrder.findMany({ where: { clientId: { in: ids } } }));

  it('ADR-059a: ORDER 1.111 pkg x factor 1.5 => REJECTED ORDER_QTY_PRECISION, nothing stored', async () => {
    const doc = orderDoc(1.111, pkg15);
    const res = await push([doc]).expect(201);
    expect(res.body.results[0].status).toBe('REJECTED');
    expect(res.body.results[0].error.code).toBe('ORDER_QTY_PRECISION');
    expect(await ordersBy([doc.clientId])).toHaveLength(0);
  });

  it('ADR-059a: valid order replayed with same clientId => single order, 2nd DUPLICATE with same id', async () => {
    const doc = orderDoc(0.2, pkg15); // 0.3 base units exactly
    const first = await push([doc]).expect(201);
    expect(first.body.results[0].status).toBe('ACCEPTED');
    const again = await push([doc]).expect(201);
    expect(again.body.results[0].status).toBe('DUPLICATE');
    expect(again.body.results[0].id).toBe(first.body.results[0].id);
    const orders = await ordersBy([doc.clientId]);
    expect(orders).toHaveLength(1);
  });

  it('ADR-059a: ORDER qty 1.0005 (over 3 dp) => REJECTED SYNC_VALIDATION_FAILED, nothing stored', async () => {
    const doc = orderDoc(1.0005, pkg1);
    const res = await push([doc]).expect(201);
    expect(res.body.results[0].status).toBe('REJECTED');
    expect(res.body.results[0].error.code).toBe('SYNC_VALIDATION_FAILED');
    expect(await ordersBy([doc.clientId])).toHaveLength(0);
  });

  it('ADR-059a: PAYMENT "100.005" REJECTED, "100.05" ACCEPTED and stored as 100.05', async () => {
    const bad = paymentDoc('100.005');
    const good = paymentDoc('100.05');
    const res = await push([bad, good]).expect(201);
    expect(res.body.results[0].status).toBe('REJECTED');
    expect(res.body.results[0].error.code).toBe('SYNC_VALIDATION_FAILED');
    expect(res.body.results[1].status).toBe('ACCEPTED');
    const rows = await run(() => tenantPrisma.client.payment.findMany({ where: { clientId: { in: [bad.clientId, good.clientId] } } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clientId).toBe(good.clientId);
    expect(rows[0]!.amount.toFixed(2)).toBe('100.05');
  });
});
