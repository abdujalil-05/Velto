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
import { StorageService } from '../src/common/storage/storage.service';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { localDateString } from '../src/modules/analytics/report-utils';
import { buildTestWorkbook } from '../src/modules/import/parsers/test-workbook';
import { OPENING_TX_OPTIONS } from '../src/modules/opening-balances/opening-balances.constants';
import { uniquePhone } from './unique-phone';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CUST_HEADERS = ['customerCode', 'debt', 'credit', 'docRef', 'docDate'];
const TZ = 'Asia/Tashkent';
const daysAgo = (n: number) => localDateString(new Date(Date.now() - n * 86_400_000), TZ);

class InMemoryStorage {
  async upload(input: { extension: string; keyPrefix: string }) {
    return `memory://${input.keyPrefix}/${randomUUID()}.${input.extension}`;
  }
  async putObject(input: { key: string }) {
    return input.key;
  }
}

/** F6 platform pieces over HTTP: F-ORD-002 cancel reason, trial status (no auto-block), @TenantTx scope, /import isolation, post-vs-1C-export race, payments source filter. */
describe('E2E opening balances + platform (F-ONB, F-ORD-002, trial, TenantTx)', () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
  let app: INestApplication;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const rnd = () => uniquePhone();
  const tag = randomUUID().slice(0, 6);
  let companyA: string;
  let tenantA: string;
  let ownerA: { token: string; id: string };
  let productId: string;
  let packagingId: string;
  let customerId: string;

  const http = () => request(app.getHttpServer());
  const bearer = (t: { token: string }) => ({ Authorization: `Bearer ${t.token}` });

  async function seedOwner(companyId: string) {
    const phone = rnd();
    const permissionIds: string[] = [];
    for (const key of permissionKeysForRole('OWNER')) {
      const [module, code] = key.split('.');
      const p = await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } });
      permissionIds.push(p.id);
    }
    const user = await systemPrisma.user.create({
      data: { companyId, firstName: 'OWNER', lastName: 'T', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      const role = await tx.role.create({ data: { companyId, code: 'OWNER', name: 'OWNER', isSystem: true } });
      for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    });
    const res = await http().post('/auth/login').send({ phone, password }).expect(201);
    return { token: res.body.accessToken as string, id: user.id };
  }

  const makeCustomers = async (prefix: string, n: number) => {
    await tenantPrisma.run(companyA, (tx) => tx.customer.createMany({ data: Array.from({ length: n }, (_, i) => ({ companyId: companyA, code: `${prefix}-${i}`, name: `C ${i}` })) }));
    return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
  };
  const previewC = (rows: (string | number | undefined)[][]) =>
    buildTestWorkbook(CUST_HEADERS, rows).then((buf) =>
      http().post('/opening-balances/customers/preview').set(bearer(ownerA)).attach('file', buf, { filename: 'opening.xlsx', contentType: XLSX }),
    );
  const postBody = (debt: string, credit = '0') => ({ asOfDate: localDateString(new Date(), TZ), source: '1C', controlDebt: debt, controlCredit: credit, controlQty: '0', signOff: true });
  const createOrder = () => http().post('/orders').set(bearer(ownerA)).send({ customerId, lines: [{ productId, packagingId, qty: 1 }] });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(StorageService).useValue(new InMemoryStorage()).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.init();
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-obp-${Date.now()}-${tag}`, name: 'ObPlatform' } });
    tenantA = tenant.id;
    companyA = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'ObPlatform' } })).id;
    ownerA = await seedOwner(companyA);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyA}, true)`;
      const wh = await tx.warehouse.create({ data: { companyId: companyA, name: 'W' } });
      const product = await tx.product.create({ data: { companyId: companyA, sku: `OP-${tag}`, name: 'P', baseUnit: 'dona', vatRate: '12' } });
      productId = product.id;
      packagingId = (await tx.productPackaging.create({ data: { productId, name: 'dona', qtyInBaseUnit: '1', isDefault: true } })).id;
      const pl = await tx.priceList.create({ data: { companyId: companyA, name: 'PL', isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: pl.id, productId, price: '10000.00' } });
      await tx.stockLevel.create({ data: { productId, warehouseId: wh.id, onHand: '1000', reserved: '0' } });
      customerId = (await tx.customer.create({ data: { companyId: companyA, code: `OPC-${tag}`, name: 'Order customer' } })).id;
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('F-ORD-002: cancel without/blank/short reason -> 400 and order untouched; valid reason fills columns + audit', async () => {
    const order = (await createOrder().expect(201)).body;
    for (const body of [{}, { reason: '   ' }, { reason: 'ab' }, { reason: 'x'.repeat(501) }]) {
      await http().post(`/orders/${order.id}/cancel`).set(bearer(ownerA)).send(body).expect(400);
    }
    const untouched = await tenantPrisma.run(companyA, (tx) => tx.salesOrder.findUniqueOrThrow({ where: { id: order.id } }));
    expect(untouched.status).toBe('SUBMITTED');
    expect(untouched.cancelReason).toBeNull();

    const res = await http().post(`/orders/${order.id}/cancel`).set(bearer(ownerA)).send({ reason: '  customer refused  ' }).expect(201);
    expect(res.body.status).toBe('CANCELLED');
    const row = await tenantPrisma.run(companyA, (tx) => tx.salesOrder.findUniqueOrThrow({ where: { id: order.id } }));
    expect(row).toMatchObject({ status: 'CANCELLED', cancelReason: 'customer refused', cancelledBy: ownerA.id });
    expect(row.cancelledAt).toBeInstanceOf(Date);
    const audit = await tenantPrisma.run(companyA, (tx) => tx.auditLog.findFirst({ where: { action: 'order.cancel', entityId: order.id } }));
    expect(audit?.newValue).toMatchObject({ status: 'CANCELLED', reason: 'customer refused' });
  });

  it('F-ORD-002 DB CHECK: a CANCELLED order with null or blank cancelReason cannot be stored', async () => {
    const order = (await createOrder().expect(201)).body;
    for (const cancelReason of [null, '   ']) {
      await expect(
        tenantPrisma.run(companyA, (tx) => tx.salesOrder.update({ where: { id: order.id }, data: { status: 'CANCELLED', cancelReason } })),
      ).rejects.toThrow(/SalesOrder_cancel_reason_check|cancel_reason/);
    }
    expect((await tenantPrisma.run(companyA, (tx) => tx.salesOrder.findUniqueOrThrow({ where: { id: order.id } }))).status).toBe('SUBMITTED');
  });

  it('trial: GET /settings reports ACTIVE (null) / TRIAL (future) / TRIAL_EXPIRED (past); PATCH plan/trialEndsAt -> 400 and DB unchanged', async () => {
    const status = async () => (await http().get('/settings').set(bearer(ownerA)).expect(200)).body.subscription as { status: string; daysLeft: number };
    await systemPrisma.tenant.update({ where: { id: tenantA }, data: { trialEndsAt: null } });
    expect((await status()).status).toBe('ACTIVE');
    await systemPrisma.tenant.update({ where: { id: tenantA }, data: { trialEndsAt: new Date(Date.now() + 5 * 86_400_000) } });
    const trial = await status();
    expect(trial.status).toBe('TRIAL');
    expect(trial.daysLeft).toBeGreaterThanOrEqual(4);
    await systemPrisma.tenant.update({ where: { id: tenantA }, data: { trialEndsAt: new Date(Date.now() - 86_400_000) } });
    expect(await status()).toMatchObject({ status: 'TRIAL_EXPIRED', daysLeft: 0 });

    const before = await systemPrisma.tenant.findUniqueOrThrow({ where: { id: tenantA } });
    await http().patch('/settings').set(bearer(ownerA)).send({ plan: 'ENTERPRISE' }).expect(400);
    await http().patch('/settings').set(bearer(ownerA)).send({ trialEndsAt: new Date(Date.now() + 99 * 86_400_000).toISOString() }).expect(400);
    const after = await systemPrisma.tenant.findUniqueOrThrow({ where: { id: tenantA } });
    expect(after.plan).toBe(before.plan);
    expect(after.trialEndsAt?.getTime()).toBe(before.trialEndsAt?.getTime());
  });

  it('trial: no automatic block - ordinary order creation, cancel and reads still work on a TRIAL_EXPIRED company', async () => {
    await systemPrisma.tenant.update({ where: { id: tenantA }, data: { trialEndsAt: new Date(Date.now() - 30 * 86_400_000) } });
    expect((await http().get('/settings').set(bearer(ownerA)).expect(200)).body.subscription.status).toBe('TRIAL_EXPIRED');
    const order = (await createOrder().expect(201)).body;
    await http().get('/orders').set(bearer(ownerA)).expect(200);
    await http().get('/customers').set(bearer(ownerA)).expect(200);
    await http().post(`/orders/${order.id}/cancel`).set(bearer(ownerA)).send({ reason: 'expired trial still works' }).expect(201);
    await systemPrisma.tenant.update({ where: { id: tenantA }, data: { trialEndsAt: null } });
  });

  it('@TenantTx: the 60 s tx options apply only to opening preview/post/void; other routes use the default', async () => {
    const [c] = await makeCustomers(`TX${tag}`, 1);
    const spy = vi.spyOn(TenantPrismaService.prototype, 'run');
    try {
      const optsFor = async (call: () => Promise<unknown>) => {
        spy.mockClear();
        await call();
        // The interceptor's request transaction is the first run() of the request (companyId = ours).
        const first = spy.mock.calls.find((args) => args[0] === companyA);
        expect(first, 'request tx run() call').toBeDefined();
        return first![2];
      };
      let batchId = '';
      const preview = await optsFor(async () => {
        const r = await previewC([[c, 10, undefined, 'TX-1', undefined]]);
        expect(r.status).toBe(201);
        batchId = r.body.batch.id;
      });
      expect(preview).toMatchObject(OPENING_TX_OPTIONS);
      const posted = await optsFor(() => http().post(`/opening-balances/${batchId}/post`).set(bearer(ownerA)).send(postBody('10')).expect(201));
      expect(posted).toMatchObject(OPENING_TX_OPTIONS);
      const voided = await optsFor(() => http().post(`/opening-balances/${batchId}/void`).set(bearer(ownerA)).send({ reason: 'tx options check' }).expect(201));
      expect(voided).toMatchObject(OPENING_TX_OPTIONS);

      for (const path of ['/opening-balances', `/opening-balances/${batchId}`, '/orders', '/customers', '/settings', '/import']) {
        const o = await optsFor(() => http().get(path).set(bearer(ownerA)).expect(200));
        expect(o, path).toBeUndefined();
      }
      expect(await optsFor(() => createOrder().expect(201))).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('/import list and detail never expose opening preview jobs', async () => {
    const [c] = await makeCustomers(`IM${tag}`, 1);
    const r = await previewC([[c, 5, undefined, 'IM-1', undefined]]);
    expect(r.status).toBe(201);
    const jobId = r.body.batch.importJobId as string;
    expect(jobId).toBeTruthy();
    expect(await tenantPrisma.run(companyA, (tx) => tx.importJob.count({ where: { id: jobId } }))).toBe(1);
    const list = await http().get('/import?page=1&pageSize=100').set(bearer(ownerA)).expect(200);
    expect((list.body.data as { id: string }[]).some((j) => j.id === jobId)).toBe(false);
    await http().get(`/import/${jobId}`).set(bearer(ownerA)).expect(404);
    await http().post(`/import/${jobId}/confirm`).set(bearer(ownerA)).expect(404);
  });

  it('payments list: source=OPENING returns only OPENING rows; default period listing hides OPENING', async () => {
    const [c] = await makeCustomers(`PL${tag}`, 1);
    const r = await previewC([[c, undefined, 77, undefined, undefined]]);
    await http().post(`/opening-balances/${r.body.batch.id}/post`).set(bearer(ownerA)).send(postBody('0', '77')).expect(201);
    const only = await http().get('/payments?source=OPENING&page=1&pageSize=100').set(bearer(ownerA)).expect(200);
    expect(only.body.data.length).toBeGreaterThan(0);
    expect((only.body.data as { source: string }[]).every((p) => p.source === 'OPENING')).toBe(true);
    const today = localDateString(new Date(), TZ);
    const periodic = await http().get(`/payments?from=${today}&to=${today}&page=1&pageSize=100`).set(bearer(ownerA)).expect(200);
    expect((periodic.body.data as { source: string }[]).some((p) => p.source === 'OPENING')).toBe(false);
  });

  it('race (N=4): two opening posts + two 1C export creates in parallel -> no 5xx/deadlock, all posts commit once, exports exclude OPENING', async () => {
    const [c1, c2] = await makeCustomers(`RX${tag}`, 2);
    const a = await previewC([[c1, '123.45', undefined, 'RX-1', daysAgo(3)]]);
    const b = await previewC([[c2, '67.55', undefined, 'RX-2', daysAgo(3)]]);
    const exp = (fmt: 'CSV' | 'EXCEL') =>
      http().post('/export/1c').set(bearer(ownerA)).set('Idempotency-Key', randomUUID()).send({ from: daysAgo(10), to: daysAgo(1), format: fmt });
    const results = await Promise.all([
      http().post(`/opening-balances/${a.body.batch.id}/post`).set(bearer(ownerA)).send(postBody('123.45')),
      http().post(`/opening-balances/${b.body.batch.id}/post`).set(bearer(ownerA)).send(postBody('67.55')),
      exp('CSV'),
      exp('EXCEL'),
    ]);
    expect(results.map((r) => r.status), JSON.stringify(results.map((r) => r.body.code))).toEqual([201, 201, 201, 201]);
    for (const batch of [a, b]) {
      expect(await tenantPrisma.run(companyA, (tx) => tx.invoice.count({ where: { openingBatchId: batch.body.batch.id } }))).toBe(1);
    }
    const jobIds = [results[2]!.body.id as string, results[3]!.body.id as string];
    await vi.waitFor(
      async () => {
        const jobs = await tenantPrisma.run(companyA, (tx) => tx.exportJob.findMany({ where: { id: { in: jobIds } } }));
        expect(jobs.every((j) => j.status === 'GENERATED' || j.status === 'FAILED')).toBe(true);
      },
      { timeout: 30_000, interval: 300 },
    );
    const jobs = await tenantPrisma.run(companyA, (tx) => tx.exportJob.findMany({ where: { id: { in: jobIds } } }));
    for (const j of jobs) {
      expect(j.status).toBe('GENERATED');
      expect(j.recordCount).toBe(0); // company has no SALE invoices/COLLECTION payments; OPENING (docDate in period) must not count
    }
  });
});
