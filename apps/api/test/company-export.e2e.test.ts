import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import ExcelJS from 'exceljs';
import request from 'supertest';
import type { Job } from 'bullmq';
import { prisma, systemPrisma } from '@velto/database';
import { permissionKeysForRole } from '../../../packages/database/src/rbac-catalog';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { StorageService } from '../src/common/storage/storage.service';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { Export1cRecoveryService } from '../src/modules/integrations/export-1c/export-1c-recovery.service';
import { CompanyExportProcessor, companyExportHeartbeat } from '../src/modules/company-export/company-export.processor';
import type { CompanyExportJobData } from '../src/modules/company-export/company-export.constants';
import { uniquePhone } from './unique-phone';
import { loginWithMfa } from './mfa-login';

/** ADR-045: company data export (DSR/offboarding). Real Postgres + RLS + Redis worker, StorageService test double. */
describe('E2E ADR-045: company export', () => {
  let app: INestApplication;
  let companyA: string;
  let companyB: string;
  let companyC: string;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tokens: Record<string, { token: string; userId: string }> = {};
  const permIdCache = new Map<string, string>();
  const http = () => request(app.getHttpServer());
  const auth = (k: string) => ({ Authorization: `Bearer ${tokens[k]!.token}` });
  const rid = () => randomUUID().slice(0, 8);
  const stored = new Map<string, Buffer>();
  let failPuts = 0;
  const storageDouble = {
    putObjectStream: async (i: { key: string; body: Readable; contentLength: number }) => {
      if (failPuts > 0) {
        failPuts--;
        i.body.destroy();
        throw new Error('s3 unreachable');
      }
      const chunks: Buffer[] = [];
      for await (const c of i.body) chunks.push(c as Buffer);
      const buf = Buffer.concat(chunks);
      if (buf.length !== i.contentLength) throw new Error('length mismatch');
      stored.set(i.key, buf);
      return i.key;
    },
    getObject: async (key: string) => {
      const buf = stored.get(key);
      if (!buf) throw new Error('missing');
      return { stream: Readable.from([buf]), size: buf.length };
    },
  };

  async function seedUser(companyId: string, key: string, roleCodes: string[]) {
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: { companyId, firstName: key, lastName: 'CompanyExport', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    for (const roleCode of roleCodes) {
      const permissionIds: string[] = [];
      for (const k of permissionKeysForRole(roleCode)) {
        const [module, code] = k.split('.');
        let id = permIdCache.get(k);
        if (!id) {
          id = (await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } })).id;
          permIdCache.set(k, id);
        }
        permissionIds.push(id);
      }
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        const role =
          (await tx.role.findFirst({ where: { companyId, code: roleCode } })) ??
          (await tx.role.create({ data: { companyId, code: roleCode, name: roleCode, isSystem: true } }));
        const existing = await tx.rolePermission.count({ where: { roleId: role.id } });
        if (!existing) for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
        await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
      });
    }
    const res = { body: await loginWithMfa(app, phone, password) };
    tokens[key] = { token: res.body.accessToken, userId: user.id };
  }

  async function seedCompany(label: string) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-cx-${label}-${Date.now()}-${rid()}`, name: `CX ${label}` } });
    return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `CX ${label}` } })).id;
  }

  async function seedBusiness(companyId: string, customerName: string, ownerKey: string) {
    return tenantPrisma.run(companyId, async (tx) => {
      const customer = await tx.customer.create({ data: { companyId, code: `C-${rid()}`, name: customerName, phone: '+998901112233' } });
      await tx.invoice.create({ data: { companyId, number: `INV-${rid()}`, customerId: customer.id, total: '100', status: 'OPEN' } });
      const payment = await tx.payment.create({ data: { companyId, number: `PAY-${rid()}`, customerId: customer.id, amount: '100', method: 'CASH' } });
      const wh = await tx.warehouse.create({ data: { companyId, name: `${customerName}-WH` } });
      const product = await tx.product.create({ data: { companyId, sku: `SKU-${rid()}`, name: `${customerName}-P`, baseUnit: 'pcs' } });
      await tx.stockMovement.create({ data: { companyId, productId: product.id, warehouseId: wh.id, type: 'RECEIVE', qty: '5', note: `${customerName}-MV` } });
      await tx.paymentReversal.create({ data: { companyId, reversesPaymentId: payment.id, reason: `${customerName}-REV`, actorId: ownerKey } });
      await tx.cashSession.create({ data: { companyId, userId: ownerKey, openAmount: '10' } });
      return customer.id;
    });
  }

  const dbJob = (companyId: string, id: string) => tenantPrisma.run(companyId, (tx) => tx.exportJob.findUniqueOrThrow({ where: { id } }));
  const audits = (companyId: string, action: string, entityId?: string) =>
    tenantPrisma.run(companyId, (tx) => tx.auditLog.findMany({ where: { action, ...(entityId ? { entityId } : {}) } }));

  async function waitStatus(companyId: string, id: string, status: string) {
    for (let i = 0; i < 100; i++) {
      const j = await dbJob(companyId, id);
      if (j.status === status) return j;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`job ${id} never reached ${status}`);
  }

  async function readSheets(buf: Buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    const out: Record<string, string[][]> = {};
    wb.eachSheet((ws) => {
      const rows: string[][] = [];
      ws.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(v)))));
      out[ws.name] = rows;
    });
    return out;
  }

  const SECRET_B = 'B-SECRET-CUSTOMER-NAME';
  const FORMULA_NAME = '=HYPERLINK("http://evil","click")';
  let jobIdA: string;
  let customerA: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(StorageService).useValue(storageDouble).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    // Loopback-only listen: supertest's default `::` bind can collide with a foreign 127.0.0.1 listener (e.g. VS Code helper) => random 4xx.
    await app.listen(0, '127.0.0.1');
    companyA = await seedCompany('a');
    companyB = await seedCompany('b');
    companyC = await seedCompany('c');
    await seedUser(companyA, 'OWNER_A', ['OWNER']);
    await seedUser(companyA, 'ACCOUNTANT', ['ACCOUNTANT']);
    await seedUser(companyA, 'DIRECTOR', ['SALES_DIRECTOR']);
    await seedUser(companyA, 'CASHIER', ['CASHIER']);
    await seedUser(companyB, 'OWNER_B', ['OWNER']);
    await seedUser(companyC, 'OWNER_C', ['OWNER']);
    customerA = await seedBusiness(companyA, FORMULA_NAME, tokens.OWNER_A!.userId);
    await seedBusiness(companyB, SECRET_B, tokens.OWNER_B!.userId);
  });

  afterAll(async () => {
    await app.close();
  });

  it('OWNER: POST creates a QUEUED job (no storageKey/fileUrl in view), worker produces the file; GET shows GENERATED', async () => {
    const res = await http().post('/company-export').set(auth('OWNER_A')).set('Idempotency-Key', randomUUID()).expect(201);
    jobIdA = res.body.id;
    expect(res.body.type).toBe('company');
    expect(JSON.stringify(res.body)).not.toMatch(/storageKey|fileUrl|exports\//);
    const done = await waitStatus(companyA, jobIdA, 'GENERATED');
    expect(done.storageKey).toBe(`exports/company/${companyA}/${jobIdA}.xlsx`);
    expect(done.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(done.recordCount).toBeGreaterThan(0);
    const view = await http().get(`/company-export/${jobIdA}`).set(auth('OWNER_A')).expect(200);
    expect(view.body.status).toBe('GENERATED');
    expect(JSON.stringify(view.body)).not.toMatch(/storageKey|fileUrl/);
    expect(await audits(companyA, 'company.export', jobIdA)).toHaveLength(1);
  });

  it('download: streams xlsx via API with X-Content-SHA256, audits company.export.download; no tenant B data, no secrets, sanitized cells', async () => {
    const res = await http().get(`/company-export/${jobIdA}/download`).set(auth('OWNER_A')).buffer().parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    const job = await dbJob(companyA, jobIdA);
    expect(res.headers['x-content-sha256']).toBe(job.fileHash);
    expect(res.headers['content-disposition']).toContain('attachment; filename="company-export-');
    expect(await audits(companyA, 'company.export.download', jobIdA)).toHaveLength(1);

    const sheets = await readSheets(res.body as Buffer);
    expect(Object.keys(sheets)).toEqual(expect.arrayContaining(['customers', 'outlets', 'products', 'price_lists', 'price_list_items', 'stock_levels', 'orders', 'order_lines', 'invoices', 'invoice_lines', 'payments', 'payment_allocations', 'users', 'opening_batches']));
    const all = JSON.stringify(sheets);
    // tenant isolation
    expect(all).not.toContain(SECRET_B);
    expect(sheets.customers!.some((r) => r.includes(customerA))).toBe(true);
    expect(sheets.invoices!.length).toBe(2); // header + A's invoice only
    expect(sheets.payments!.length).toBe(2);
    // new DSR sheets: A's row only, none of B's
    for (const name of ['warehouses', 'stock_movements', 'payment_reversals', 'cash_sessions']) expect(sheets[name]!.length, name).toBe(2);
    expect(JSON.stringify(sheets.stock_movements)).toContain('-MV');
    expect(JSON.stringify([sheets.warehouses, sheets.stock_movements, sheets.payment_reversals])).not.toContain('B-SECRET');
    for (const name of ['suppliers', 'purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines', 'routes', 'route_stops', 'visits']) expect(sheets[name], name).toBeDefined();
    for (const [name, rows] of Object.entries(sheets)) expect(rows[0]!.join(' '), name).not.toMatch(/password|hash|token|initData|telegram|secret/i);
    // no credentials / tokens
    expect(all).not.toMatch(/\$argon2|passwordHash|refreshToken|tokenHash|initData|telegram/i);
    expect(sheets.users![0]).toEqual(['id', 'firstName', 'lastName', 'phone', 'email', 'roles', 'isActive', 'createdAt']);
    expect(sheets.users!.length).toBe(5); // header + 4 owners/staff of A
    // formula injection neutralised
    const cust = sheets.customers!.find((r) => r.includes(customerA))!;
    expect(cust[2]).toBe(`'${FORMULA_NAME}`);
  });

  it('RBAC: ACCOUNTANT / SALES_DIRECTOR / CASHIER => 403 + auth.permission_denied audit; nothing created', async () => {
    const before = (await audits(companyA, 'auth.permission_denied')).length;
    for (const k of ['ACCOUNTANT', 'DIRECTOR', 'CASHIER']) {
      await http().post('/company-export').set(auth(k)).set('Idempotency-Key', randomUUID()).expect(403);
      await http().get(`/company-export/${jobIdA}/download`).set(auth(k)).expect(403);
    }
    const denied = await audits(companyA, 'auth.permission_denied');
    expect(denied.length).toBe(before + 6);
    expect(denied.every((r) => (r.newValue as { permission: string }).permission === 'company.export')).toBe(true);
    expect(await tenantPrisma.run(companyA, (tx) => tx.exportJob.count({ where: { type: 'company' } }))).toBe(1);
    // ACCOUNTANT can still not reach it through the 1C routes either
    await http().get(`/export/1c/${jobIdA}`).set(auth('ACCOUNTANT')).expect(404);
  });

  it("tenant B: A's job id => 404 on status and download", async () => {
    await http().get(`/company-export/${jobIdA}`).set(auth('OWNER_B')).expect(404);
    await http().get(`/company-export/${jobIdA}/download`).set(auth('OWNER_B')).expect(404);
  });

  it('active limit: a second export while one is QUEUED/PROCESSING => 409 COMPANY_EXPORT_ACTIVE; no row added', async () => {
    const queued = await tenantPrisma.run(companyB, (tx) =>
      tx.exportJob.create({ data: { companyId: companyB, type: 'company', format: 'EXCEL', periodFrom: new Date(), periodTo: new Date(), status: 'QUEUED' } }),
    );
    const res = await http().post('/company-export').set(auth('OWNER_B')).set('Idempotency-Key', randomUUID()).expect(409);
    expect(res.body.code).toBe('COMPANY_EXPORT_ACTIVE');
    expect(await tenantPrisma.run(companyB, (tx) => tx.exportJob.count({ where: { type: 'company' } }))).toBe(1);
    expect(queued.id).toBeTruthy();
  });

  it('throttle: 2nd create within a minute by the same user => 429', async () => {
    const first = await http().post('/company-export').set(auth('OWNER_C')).set('Idempotency-Key', randomUUID()).expect(201);
    await waitStatus(companyC, first.body.id, 'GENERATED'); // let the in-process worker finish before the retry tests toggle the storage double
    await http().post('/company-export').set(auth('OWNER_C')).set('Idempotency-Key', randomUUID()).expect(429);
  });

  describe('worker retry / idempotency (processor driven directly)', () => {
    const fakeJob = (data: CompanyExportJobData, attemptsMade: number) => ({ data, attemptsMade, opts: { attempts: 3 } }) as unknown as Job<CompanyExportJobData>;
    const processor = () => new CompanyExportProcessor(tenantPrisma, storageDouble as unknown as StorageService);
    async function queuedJob(companyId: string) {
      return tenantPrisma.run(companyId, (tx) => tx.exportJob.create({ data: { companyId, type: 'company', format: 'EXCEL', periodFrom: new Date(), periodTo: new Date(), status: 'QUEUED' } }));
    }

    it('transient failure => back to QUEUED with errorLog; retry succeeds => GENERATED; redelivery is a no-op', async () => {
      const company = await seedCompany('retry');
      const job = await queuedJob(company);
      const data = { exportJobId: job.id, companyId: company };
      failPuts = 1;
      await expect(processor().process(fakeJob(data, 0))).rejects.toThrow('s3 unreachable');
      const afterFail = await dbJob(company, job.id);
      expect(afterFail.status).toBe('QUEUED');
      expect(afterFail.attemptCount).toBe(1);
      expect(JSON.stringify(afterFail.errorLog)).toContain('s3 unreachable');

      await processor().process(fakeJob(data, 1));
      const ok = await dbJob(company, job.id);
      expect(ok.status).toBe('GENERATED');
      expect(ok.attemptCount).toBe(2);
      expect(ok.errorLog).toBeNull();

      await processor().process(fakeJob(data, 2)); // duplicate delivery
      expect((await dbJob(company, job.id)).attemptCount).toBe(2);
    });

    it('sweep spares a PROCESSING job whose heartbeat is fresh, fails one that went stale', async () => {
      const company = await seedCompany('sweep');
      const job = await queuedJob(company);
      const stale = new Date(Date.now() - 20 * 60_000);
      await tenantPrisma.run(company, (tx) => tx.exportJob.update({ where: { id: job.id }, data: { status: 'PROCESSING', updatedAt: stale } }));
      await companyExportHeartbeat(tenantPrisma, company, job.id);
      const recovery = new Export1cRecoveryService(tenantPrisma, { add: async () => ({}) } as never);
      await recovery.sweep();
      expect((await dbJob(company, job.id)).status).toBe('PROCESSING');
      await tenantPrisma.run(company, (tx) => tx.exportJob.updateMany({ where: { id: job.id }, data: { updatedAt: stale } }));
      await recovery.sweep();
      expect((await dbJob(company, job.id)).status).toBe('FAILED');
    });

    it('last attempt failing => FAILED with visible error (frees the active slot)', async () => {
      const company = await seedCompany('fail');
      const job = await queuedJob(company);
      failPuts = 1;
      await expect(processor().process(fakeJob({ exportJobId: job.id, companyId: company }, 2))).rejects.toThrow();
      const failed = await dbJob(company, job.id);
      expect(failed.status).toBe('FAILED');
      expect(JSON.stringify(failed.errorLog)).toContain('s3 unreachable');
    });
  });
});
