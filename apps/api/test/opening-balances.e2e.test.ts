import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import { Prisma, prisma, systemPrisma } from '@velto/database';
import { permissionKeysForRole } from '../../../packages/database/src/rbac-catalog';
import { AppModule } from '../src/app.module';
import { expectWithinBudget } from '../src/common/testing/perf';
import { configureApp } from '../src/bootstrap';
import { StorageService } from '../src/common/storage/storage.service';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { localDateString } from '../src/modules/analytics/report-utils';
import { buildTestWorkbook } from '../src/modules/import/parsers/test-workbook';
import { uniquePhone } from './unique-phone';
import { loginWithMfa } from './mfa-login';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CUST_HEADERS = ['customerCode', 'debt', 'credit', 'docRef', 'docDate'];
const STOCK_HEADERS = ['sku', 'warehouseName', 'qty'];

class InMemoryStorage {
  async upload(input: { extension: string; keyPrefix: string }) {
    return `memory://${input.keyPrefix}/${randomUUID()}.${input.extension}`;
  }
}

/** F6 opening balances over HTTP: RBAC + audit, signOff, Idempotency-Key, tenant isolation, CSV, 1000 customers + 2000 pairs in one tx. */
describe('E2E opening balances (ADR-041..043)', () => {
  vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });
  let app: INestApplication;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const rnd = () => uniquePhone();
  const tag = randomUUID().slice(0, 6);
  const today = localDateString(new Date(), 'Asia/Tashkent');
  let companyA: string;
  let companyB: string;
  let ownerA: { token: string; id: string };
  let ownerB: { token: string; id: string };
  let accountant: { token: string; id: string };
  let director: { token: string; id: string };
  let cashier: { token: string; id: string };

  const http = () => request(app.getHttpServer());
  const bearer = (t: { token: string }) => ({ Authorization: `Bearer ${t.token}` });

  async function seedUser(companyId: string, roleCode: string) {
    const phone = rnd();
    const permissionIds: string[] = [];
    for (const key of permissionKeysForRole(roleCode)) {
      const [module, code] = key.split('.');
      const p = await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } });
      permissionIds.push(p.id);
    }
    const user = await systemPrisma.user.create({
      data: { companyId, firstName: roleCode, lastName: 'T', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      const role = await tx.role.create({ data: { companyId, code: roleCode, name: roleCode, isSystem: true } });
      for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    });
    const res = { body: await loginWithMfa(app, phone, password) };
    return { token: res.body.accessToken as string, id: user.id };
  }

  async function seedCompany(label: string) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-ob-${label}-${Date.now()}-${tag}`, name: `OB ${label}` } });
    return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `OB ${label}` } })).id;
  }

  const makeCustomers = async (prefix: string, n: number) => {
    await tenantPrisma.run(companyA, (tx) => tx.customer.createMany({ data: Array.from({ length: n }, (_, i) => ({ companyId: companyA, code: `${prefix}-${i}`, name: `C ${i}` })) }));
    return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
  };

  const upload = (who: { token: string }, kind: 'customers' | 'stock', buf: Buffer, filename = 'opening.xlsx', contentType = XLSX) =>
    http().post(`/opening-balances/${kind}/preview`).set(bearer(who)).attach('file', buf, { filename, contentType });
  const postBody = (t: { debt?: string; credit?: string; qty?: string }, signOff: unknown = true, omitSignOff = false) => ({
    asOfDate: today,
    source: '1C',
    controlDebt: t.debt ?? '0',
    controlCredit: t.credit ?? '0',
    controlQty: t.qty ?? '0',
    ...(omitSignOff ? {} : { signOff }),
  });
  const deniedCount = (userId: string) =>
    tenantPrisma.run(companyA, (tx) => tx.auditLog.count({ where: { userId, action: 'auth.permission_denied' } }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(StorageService).useValue(new InMemoryStorage()).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    // Loopback-only listen: supertest's default `::` bind can collide with a foreign 127.0.0.1 listener (e.g. VS Code helper) => random 4xx.
    await app.listen(0, '127.0.0.1');
    companyA = await seedCompany('A');
    companyB = await seedCompany('B');
    ownerA = await seedUser(companyA, 'OWNER');
    ownerB = await seedUser(companyB, 'OWNER');
    accountant = await seedUser(companyA, 'ACCOUNTANT');
    director = await seedUser(companyA, 'SALES_DIRECTOR');
    cashier = await seedUser(companyA, 'CASHIER');
  });

  afterAll(async () => {
    await app.close();
  });

  it('RBAC: preview is OWNER-only (opening.preview) -> ACCOUNTANT/SALES_DIRECTOR/CASHIER 403 + audit, no batch; ACCOUNTANT list/detail 200; post/void 403 + audit', async () => {
    const [c] = await makeCustomers(`RB${tag}`, 1);
    const file = await buildTestWorkbook(CUST_HEADERS, [[c, 10, undefined, 'R1', undefined]]);
    const batchesBefore = await tenantPrisma.run(companyA, (tx) => tx.openingBalanceBatch.count());
    for (const who of [accountant, director, cashier]) {
      const before = await deniedCount(who.id);
      const denied = await upload(who, 'customers', file);
      expect(denied.status, JSON.stringify(denied.body)).toBe(403);
      const deniedStock = await upload(who, 'stock', await buildTestWorkbook(['sku', 'warehouseName', 'qty'], [['X', 'Y', 1]]));
      expect(deniedStock.status, JSON.stringify(deniedStock.body)).toBe(403);
      expect(await deniedCount(who.id)).toBe(before + 2);
    }
    expect(await tenantPrisma.run(companyA, (tx) => tx.openingBalanceBatch.count())).toBe(batchesBefore);

    const prev = await upload(ownerA, 'customers', file);
    expect(prev.status, JSON.stringify(prev.body)).toBe(201);
    const id = prev.body.batch.id as string;
    await http().get('/opening-balances').set(bearer(accountant)).expect(200);
    await http().get(`/opening-balances/${id}`).set(bearer(accountant)).expect(200);

    for (const who of [accountant, director, cashier]) {
      const before = await deniedCount(who.id);
      await http().post(`/opening-balances/${id}/post`).set(bearer(who)).send(postBody({ debt: '10' })).expect(403);
      await http().post(`/opening-balances/${id}/void`).set(bearer(who)).send({ reason: 'test void' }).expect(403);
      expect(await deniedCount(who.id)).toBe(before + 2);
    }
  });

  it('signOff missing/false -> 400; Idempotency-Key replays without duplicates; plain re-post -> 409; tenant B gets 404', async () => {
    const [c] = await makeCustomers(`ID${tag}`, 1);
    const prev = await upload(ownerA, 'customers', await buildTestWorkbook(CUST_HEADERS, [[c, '250.75', undefined, 'I1', undefined]]));
    const id = prev.body.batch.id as string;

    await http().post(`/opening-balances/${id}/post`).set(bearer(ownerA)).send(postBody({ debt: '250.75' }, true, true)).expect(400);
    const off = await http().post(`/opening-balances/${id}/post`).set(bearer(ownerA)).send(postBody({ debt: '250.75' }, false)).expect(400);
    expect(off.body.code).toBe('OPENING_SIGN_OFF_REQUIRED');
    const mismatch = await http().post(`/opening-balances/${id}/post`).set(bearer(ownerA)).send(postBody({ debt: '250.70' })).expect(409);
    expect(mismatch.body.code).toBe('OPENING_TOTALS_MISMATCH');

    await http().get(`/opening-balances/${id}`).set(bearer(ownerB)).expect(404);
    await http().post(`/opening-balances/${id}/post`).set(bearer(ownerB)).send(postBody({ debt: '250.75' })).expect(404);

    const key = `ob-${randomUUID()}`;
    const first = await http().post(`/opening-balances/${id}/post`).set(bearer(ownerA)).set('Idempotency-Key', key).send(postBody({ debt: '250.75' })).expect(201);
    const replay = await http().post(`/opening-balances/${id}/post`).set(bearer(ownerA)).set('Idempotency-Key', key).send(postBody({ debt: '250.75' })).expect(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(first.body.status).toBe('POSTED');
    const again = await http().post(`/opening-balances/${id}/post`).set(bearer(ownerA)).send(postBody({ debt: '250.75' })).expect(409);
    expect(again.body.code).toBe('OPENING_BATCH_NOT_PREVIEWED');
    expect(await tenantPrisma.run(companyA, (tx) => tx.invoice.count({ where: { openingBatchId: id } }))).toBe(1);
  });

  it('CSV (semicolon, UTF-8) preview works', async () => {
    const [c] = await makeCustomers(`CS${tag}`, 1);
    const csv = Buffer.from(`\uFEFFcustomerCode;debt;credit;docRef;docDate\n${c};1234.56;;CSV-1;01.09.2026\n`, 'utf-8');
    const res = await upload(ownerA, 'customers', csv, 'opening.csv', 'text/csv');
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(201);
    expect(res.body.invalidCount).toBe(0);
    expect(res.body.batch.debtTotal).toBe('1234.56');
  });

  it('1000 customers + 2000 product×warehouse pairs: each post is one transaction under 60 s; invariants hold', async () => {
    const codes = await makeCustomers(`PF${tag}`, 1000);
    const custRows = codes.map((c, i) => (i % 4 === 0 ? [c, undefined, `${i}.25`, undefined, undefined] : [c, `${i + 1}.10`, undefined, `D-${i}`, undefined]));
    const prevC = await upload(ownerA, 'customers', await buildTestWorkbook(CUST_HEADERS, custRows));
    expect(prevC.status, JSON.stringify(prevC.body).slice(0, 300)).toBe(201);
    expect(prevC.body.invalidCount).toBe(0);
    const t0 = performance.now();
    const postC = await http()
      .post(`/opening-balances/${prevC.body.batch.id}/post`)
      .set(bearer(ownerA))
      .send(postBody({ debt: prevC.body.batch.debtTotal, credit: prevC.body.batch.creditTotal }));
    const msC = Math.round(performance.now() - t0);
    expect(postC.status, JSON.stringify(postC.body).slice(0, 300)).toBe(201);
    console.log(`[F6 perf] opening post 1000 customers: ${msC} ms`);
    expectWithinBudget("opening e2e customers", msC, 60_000);

    const sum = await tenantPrisma.run(companyA, (tx) => tx.customer.aggregate({ where: { code: { startsWith: `PF${tag}-` } }, _sum: { cachedBalance: true } }));
    expect(sum._sum.cachedBalance!.toFixed(2)).toBe(new Prisma.Decimal(prevC.body.batch.debtTotal).minus(prevC.body.batch.creditTotal).toFixed(2));

    const warehouses = await tenantPrisma.run(companyA, async (tx) => [
      await tx.warehouse.create({ data: { companyId: companyA, name: `PW1-${tag}` } }),
      await tx.warehouse.create({ data: { companyId: companyA, name: `PW2-${tag}` } }),
    ]);
    await tenantPrisma.run(companyA, (tx) =>
      tx.product.createMany({ data: Array.from({ length: 1000 }, (_, i) => ({ companyId: companyA, sku: `PS${tag}-${i}`, name: `P ${i}`, baseUnit: 'dona', vatRate: 12 })) }),
    );
    const stockRows = Array.from({ length: 2000 }, (_, i) => [`PS${tag}-${i % 1000}`, warehouses[i < 1000 ? 0 : 1]!.name, (i % 50) + 1]);
    const prevS = await upload(ownerA, 'stock', await buildTestWorkbook(STOCK_HEADERS, stockRows));
    expect(prevS.status, JSON.stringify(prevS.body).slice(0, 300)).toBe(201);
    expect(prevS.body.invalidCount).toBe(0);
    const t1 = performance.now();
    const postS = await http().post(`/opening-balances/${prevS.body.batch.id}/post`).set(bearer(ownerA)).send(postBody({ qty: prevS.body.batch.qtyTotal }));
    const msS = Math.round(performance.now() - t1);
    expect(postS.status, JSON.stringify(postS.body).slice(0, 300)).toBe(201);
    console.log(`[F6 perf] opening post 2000 pairs: ${msS} ms`);
    expectWithinBudget("opening e2e stock", msS, 60_000);

    const levels = await tenantPrisma.run(companyA, (tx) => tx.stockLevel.findMany({ where: { product: { sku: { startsWith: `PS${tag}-` } } } }));
    expect(levels).toHaveLength(2000);
    expect(levels.every((l) => l.reserved.isZero())).toBe(true);
    expect(levels.reduce((s, l) => s.plus(l.onHand), new Prisma.Decimal(0)).toFixed(3)).toBe(new Prisma.Decimal(prevS.body.batch.qtyTotal).toFixed(3));
  });
});
