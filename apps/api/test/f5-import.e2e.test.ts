import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { buildTestWorkbook } from '../src/modules/import/parsers/test-workbook';
import { uniquePhone } from './unique-phone';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CUSTOMER_HEADERS = ['code', 'name', 'phone', 'paymentTermDays', 'outletName'];
const PRODUCT_HEADERS = ['sku', 'name', 'baseUnit', 'categoryName', 'vatRate'];

/** In-memory StorageService replacement: no MinIO needed. Production keeps the real S3 adapter. */
class InMemoryStorage {
  readonly files = new Map<string, Buffer>();
  async upload(input: { buffer: Buffer; extension: string; keyPrefix: string }) {
    const key = `memory://${input.keyPrefix}/${randomUUID()}.${input.extension}`;
    this.files.set(key, input.buffer);
    return key;
  }
}

/** F5 step 5 (TZ M12 / 7.3 / 16.1): import over HTTP, real Postgres + RLS + BullMQ worker, in-memory file storage. */
describe('E2E F5 import (create-only, preview/confirm, scale, RBAC, isolation)', () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
  let app: INestApplication;
  const storage = new InMemoryStorage();
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const rnd = () => uniquePhone();
  const tag = randomUUID().slice(0, 6);
  let companyA: string;
  let companyB: string;
  let ownerA: { token: string; id: string };
  let ownerB: { token: string };
  let accountantA: { token: string };

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
    const res = await http().post('/auth/login').send({ phone, password }).expect(201);
    return { token: res.body.accessToken as string, id: user.id };
  }

  async function seedCompany(label: string) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-f5imp-${label}-${Date.now()}-${tag}`, name: `F5 ${label}` } });
    return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `F5 ${label}` } })).id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StorageService)
      .useValue(storage)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.init();
  });

  // Every test gets its own tenants/users so a failure cannot cascade into the others.
  beforeEach(async () => {
    companyA = await seedCompany('A');
    companyB = await seedCompany('B');
    ownerA = await seedUser(companyA, 'OWNER');
    ownerB = await seedUser(companyB, 'OWNER');
    accountantA = await seedUser(companyA, 'ACCOUNTANT');
  });

  afterAll(async () => {
    const t = performance.now();
    await app.close();
    console.log('[close ms]', Math.round(performance.now() - t));
  });

  const upload = (who: { token: string }, type: 'customers' | 'products', buf: Buffer) =>
    http().post(`/import/${type}`).set(bearer(who)).attach('file', buf, { filename: 'x.xlsx', contentType: XLSX });

  /** Deadline (default 80 s, below the 150 s test timeout) stays below the test timeout; the failure message carries the last http/status/progress/body. */
  async function waitStatus(who: { token: string }, id: string, want = 'DONE', deadlineMs = 80_000) {
    const end = Date.now() + deadlineMs;
    let last = 'no response';
    while (Date.now() < end) {
      const res = await http().get(`/import/${id}`).set(bearer(who));
      last = `http=${res.status} status=${res.body?.status} progress=${res.body?.progress} body=${JSON.stringify(res.body?.errorLog ?? res.body).slice(0, 200)}`;
      if (res.status === 200 && res.body.status === 'FAILED') throw new Error(`import ${id} FAILED: ${last}`);
      if (res.status === 200 && res.body.status === want) return res.body;
      await new Promise((r) => setTimeout(r, res.status === 429 ? 2000 : 500));
    }
    throw new Error(`import ${id} not ${want} within ${deadlineMs} ms; last: ${last}`);
  }

  const customerRows = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => [`${prefix}-${i}`, `Customer ${i}`, '+998901234567', 7, `Outlet ${i}`] as (string | number)[]);
  const productRows = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => [`${prefix}-${i}`, `Product ${i}`, 'dona', `Cat ${i % 10}`, 12] as (string | number)[]);
  const customerCount = (c: string, prefix: string) =>
    tenantPrisma.run(c, (tx) => tx.customer.count({ where: { code: { startsWith: prefix } } }));
  const productCount = (c: string, prefix: string) =>
    tenantPrisma.run(c, (tx) => tx.product.count({ where: { sku: { startsWith: prefix } } }));

  it('1000 customers: preview fast, createdBy set, confirm creates all, re-import creates no duplicates (create-only)', async () => {
    const buf = await buildTestWorkbook(CUSTOMER_HEADERS, customerRows(1000, `CU${tag}`));
    const t0 = performance.now();
    const up = await upload(ownerA, 'customers', buf);
    const previewMs = Math.round(performance.now() - t0);
    expect(up.status, JSON.stringify(up.body).slice(0, 300)).toBe(201);
    console.log(`[F5 perf] customers preview 1000 rows: ${previewMs} ms`);
    expect(previewMs).toBeLessThan(15_000);
    expect(up.body.createdBy).toBe(ownerA.id);
    expect(up.body.errorLog.validCount).toBe(1000);
    expect(await customerCount(companyA, `CU${tag}`)).toBe(0); // preview writes nothing

    await http().post(`/import/${up.body.id}/confirm`).set(bearer(ownerA)).expect(201);
    const t1 = performance.now();
    const done = await waitStatus(ownerA, up.body.id);
    console.log(`[F5 perf] customers commit 1000 rows: ${Math.round(performance.now() - t1)} ms`);
    expect(done.status).toBe('DONE');
    expect(done.progress).toBe(100);
    expect(done.errorLog.createdCount).toBe(1000);
    expect(await customerCount(companyA, `CU${tag}`)).toBe(1000);

    // takroriy import: same file again -> every row reported as existing, nothing written.
    const again = await upload(ownerA, 'customers', buf);
    expect(again.status).toBe(201);
    expect(again.body.errorLog.validCount).toBe(0);
    expect(again.body.errorLog.invalidCount).toBe(1000);
    expect(again.body.errorLog.errors[0].i18n[0].en).toContain('already exists');
    await http().post(`/import/${again.body.id}/confirm`).set(bearer(ownerA)).expect(201);
    const done2 = await waitStatus(ownerA, again.body.id);
    expect(done2.status).toBe('DONE');
    expect(done2.errorLog.createdCount).toBe(0);
    expect(await customerCount(companyA, `CU${tag}`)).toBe(1000);
  }, 150_000);

  it('2000 products: preview fast, confirm creates all, re-import creates no duplicates', async () => {
    const buf = await buildTestWorkbook(PRODUCT_HEADERS, productRows(2000, `PR${tag}`));
    const t0 = performance.now();
    const up = await upload(ownerA, 'products', buf);
    const previewMs = Math.round(performance.now() - t0);
    expect(up.status, JSON.stringify(up.body).slice(0, 300)).toBe(201);
    console.log(`[F5 perf] products preview 2000 rows: ${previewMs} ms`);
    expect(previewMs).toBeLessThan(20_000);
    expect(up.body.errorLog.validCount).toBe(2000);

    await http().post(`/import/${up.body.id}/confirm`).set(bearer(ownerA)).expect(201);
    const t1 = performance.now();
    const done = await waitStatus(ownerA, up.body.id);
    console.log(`[F5 perf] products commit 2000 rows: ${Math.round(performance.now() - t1)} ms`);
    expect(done.errorLog.createdCount).toBe(2000);
    expect(await productCount(companyA, `PR${tag}`)).toBe(2000);

    const again = await upload(ownerA, 'products', buf);
    expect(again.body.errorLog.validCount).toBe(0);
    await http().post(`/import/${again.body.id}/confirm`).set(bearer(ownerA)).expect(201);
    await waitStatus(ownerA, again.body.id);
    expect(await productCount(companyA, `PR${tag}`)).toBe(2000);
  }, 150_000);

  it('error rows: line numbers + trilingual reasons; existing & in-file duplicates reported; only valid rows written; double confirm -> one wins', async () => {
    await tenantPrisma.run(companyA, (tx) => tx.customer.create({ data: { companyId: companyA, code: `EX${tag}`, name: 'Existing' } }));
    const buf = await buildTestWorkbook(CUSTOMER_HEADERS, [
      [`OK${tag}-1`, 'Good one', '+998901234567', 0, 'O1'],
      [`EX${tag}`, 'Clashes with DB', '+998901234567', 0, 'O2'], // row 3: existing -> never updated
      [`OK${tag}-1`, 'Dup in file', '+998901234567', 0, 'O3'], // row 4: duplicate in file
      ['', '', '', 0, ''], // row 5 blank code+name... (blank row is skipped, so use a bad one below)
      [`BAD${tag}`, '', '+998901234567', -3, 'O5'], // row 6: name missing + bad paymentTermDays
      [`OK${tag}-2`, 'Good two', '+998901234567', 5, 'O6'],
    ]);
    const up = await upload(ownerA, 'customers', buf);
    expect(up.status).toBe(201);
    const rep = up.body.errorLog;
    expect(rep.validCount).toBe(2);
    const byRow = new Map<number, { messages: string[]; i18n: { uz: string; ru: string; en: string }[] }>(rep.errors.map((e: any) => [e.row, e]));
    expect(byRow.get(3)!.i18n[0].ru).toContain('уже существует');
    expect(byRow.get(4)!.i18n[0].en).toContain('duplicated in the file');
    expect(byRow.get(6)!.messages).toHaveLength(2);
    expect(byRow.get(6)!.i18n.every((m) => m.uz && m.ru && m.en)).toBe(true);

    const [c1, c2] = await Promise.all([
      http().post(`/import/${up.body.id}/confirm`).set(bearer(ownerA)),
      http().post(`/import/${up.body.id}/confirm`).set(bearer(ownerA)),
    ]);
    expect([c1.status, c2.status].sort()).toEqual([201, 409]);
    const done = await waitStatus(ownerA, up.body.id);
    expect(done.errorLog.createdCount).toBe(2);
    expect(await customerCount(companyA, `OK${tag}`)).toBe(2);
    const existing = await tenantPrisma.run(companyA, (tx) => tx.customer.findFirstOrThrow({ where: { code: `EX${tag}` } }));
    expect(existing.name).toBe('Existing'); // not updated
    await http().post(`/import/${up.body.id}/confirm`).set(bearer(ownerA)).expect(409); // confirm after DONE
  });

  it('list is ordered createdAt desc and tenant-scoped', async () => {
    for (const n of [1, 2]) await upload(ownerA, 'customers', await buildTestWorkbook(CUSTOMER_HEADERS, customerRows(n, `LS${n}${tag}`))).expect(201);
    const res = await http().get('/import?pageSize=100').set(bearer(ownerA)).expect(200);
    const times = res.body.data.map((j: any) => new Date(j.createdAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(res.body.data.length).toBe(2);
    const resB = await http().get('/import').set(bearer(ownerB)).expect(200);
    expect(resB.body.data).toHaveLength(0);
  });

  it('ACCOUNTANT cannot import (upload/confirm 403); tenant B cannot read or confirm tenant A job', async () => {
    const buf = await buildTestWorkbook(CUSTOMER_HEADERS, customerRows(1, `AC${tag}`));
    await upload(accountantA, 'customers', buf).expect(403);
    const up = await upload(ownerA, 'customers', buf);
    expect(up.status).toBe(201);
    await http().post(`/import/${up.body.id}/confirm`).set(bearer(accountantA)).expect(403);
    await http().get(`/import/${up.body.id}`).set(bearer(ownerB)).expect(404);
    await http().post(`/import/${up.body.id}/confirm`).set(bearer(ownerB)).expect(404);
    const still = await http().get(`/import/${up.body.id}`).set(bearer(ownerA)).expect(200);
    expect(still.body.status).toBe('PENDING');
    expect(await customerCount(companyB, `AC${tag}`)).toBe(0);
  });
});
