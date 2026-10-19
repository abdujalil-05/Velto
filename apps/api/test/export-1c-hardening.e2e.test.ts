import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Job } from 'bullmq';
import argon2 from 'argon2';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { InvoiceStatus, PaymentMethod, Prisma, prisma, systemPrisma } from '@velto/database';
import { permissionKeysForRole } from '../../../packages/database/src/rbac-catalog';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { StorageService } from '../src/common/storage/storage.service';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { buildReportCsv, buildReportXlsx, type ReportTable } from '../src/modules/analytics/report-export';
import type { Export1cJobData } from '../src/modules/integrations/export-1c/export-1c.constants';
import { Export1cProcessor } from '../src/modules/integrations/export-1c/export-1c.processor';
import { Export1cRecoveryService } from '../src/modules/integrations/export-1c/export-1c-recovery.service';
import { uniquePhone } from './unique-phone';

/**
 * F5.3 hardening: TZ §5.4.2 I-01 (stable Ид across re-export), §16.5.1 negative tests, SEC-001/009,
 * §7.6.3 formula injection, ADR-024 (no reversal inside a non-FAILED export period), ADR-030 sweep/limits.
 * Real Postgres + RLS (app role), StorageService in-memory double, per-file BULLMQ_PREFIX (setup-bull-prefix).
 */
describe('E2E F5.3: 1C export hardening', () => {
  let app: INestApplication;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tokens: Record<string, string> = {};
  const permIdCache = new Map<string, string>();
  const rid = () => randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const auth = (k: string) => ({ Authorization: `Bearer ${tokens[k]!}` });

  const store = new Map<string, Buffer>();
  const storage = {
    putObject: async ({ key, buffer }: { key: string; buffer: Buffer }) => {
      store.set(key, buffer);
      return key;
    },
    getObject: async (key: string) => {
      const buf = store.get(key);
      if (!buf) throw new Error('no such key');
      return { stream: Readable.from([buf]), size: buf.length };
    },
  };
  const processor = () => new Export1cProcessor(tenantPrisma, storage as unknown as StorageService);
  const fakeJob = (exportJobId: string, companyId: string) => ({ data: { exportJobId, companyId } }) as unknown as Job<Export1cJobData>;

  async function seedCompany(label: string) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-f53h-${label}-${Date.now()}-${rid()}`, name: `F53H ${label}` } });
    return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `F53H ${label}` } })).id;
  }

  async function seedUser(companyId: string, key: string, roleCode: string) {
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: { companyId, firstName: key, lastName: 'Hardening', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
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
      let role = await tx.role.findFirst({ where: { companyId, code: roleCode } });
      if (!role) {
        role = await tx.role.create({ data: { companyId, code: roleCode, name: roleCode, isSystem: true } });
        for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
      }
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    });
    const res = await http().post('/auth/login').send({ phone, password }).expect(201);
    tokens[key] = res.body.accessToken;
  }

  /** Customers + invoices + payments for one company, all created "now" (inside nowPeriod()). */
  async function seedDocs(companyId: string, opts: { invoices: number; payments: number; customerName?: string }) {
    return tenantPrisma.run(companyId, async (tx) => {
      const customer = await tx.customer.create({ data: { companyId, code: `C-${rid()}`, name: opts.customerName ?? 'Test Customer' } });
      const product = await tx.product.create({ data: { companyId, sku: `SKU-${rid()}`, name: 'Test Product', baseUnit: 'dona', externalCode: '1C-001' } });
      const invoiceIds: string[] = [];
      for (let i = 0; i < opts.invoices; i++) {
        const inv = await tx.invoice.create({
          data: {
            companyId, number: `INV-${i}-${rid()}`, customerId: customer.id, total: '100', status: InvoiceStatus.OPEN,
            lines: { create: [{ productId: product.id, qty: '1', unitPrice: '100', vatRate: '12', lineTotal: '100' }] },
          },
        });
        invoiceIds.push(inv.id);
      }
      const paymentIds: string[] = [];
      for (let i = 0; i < opts.payments; i++) {
        const pay = await tx.payment.create({ data: { companyId, number: `PAY-${i}-${rid()}`, customerId: customer.id, amount: '50', method: PaymentMethod.CASH } });
        paymentIds.push(pay.id);
      }
      return { customerId: customer.id, invoiceIds, paymentIds };
    });
  }

  const nowPeriod = () => ({ periodFrom: new Date(Date.now() - 86_400_000), periodTo: new Date(Date.now() + 86_400_000) });
  const queued = (companyId: string, format: 'XML' | 'EXCEL' | 'CSV', period = nowPeriod()) =>
    tenantPrisma.run(companyId, (tx) => tx.exportJob.create({ data: { companyId, type: '1c', format, ...period } }));
  const dbJob = (companyId: string, id: string) => tenantPrisma.run(companyId, (tx) => tx.exportJob.findUniqueOrThrow({ where: { id } }));
  const generate = async (companyId: string, format: 'XML' | 'EXCEL' | 'CSV') => {
    const job = await queued(companyId, format);
    await processor().process(fakeJob(job.id, companyId));
    const done = await dbJob(companyId, job.id);
    return { job: done, buffer: store.get(done.storageKey!)! };
  };
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const csvRows = (b: Buffer) => b.toString('utf-8').slice(1).split('\r\n').filter(Boolean).slice(1).map((r) => r.split(','));
  const loadXlsx = async (b: Buffer) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(b as never);
    return wb;
  };
  const columnValues = (sheet: ExcelJS.Worksheet, col: number) => {
    const out: unknown[] = [];
    sheet.eachRow((row, n) => {
      if (n > 1) out.push(row.getCell(col).value);
    });
    return out;
  };

  let companyA: string;
  let companyB: string;
  let companyP: string; // period / throttle: no pre-existing active jobs
  let companyR: string; // reversal ban

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(StorageService).useValue(storage).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.init();
    [companyA, companyB, companyP, companyR] = await Promise.all([seedCompany('a'), seedCompany('b'), seedCompany('p'), seedCompany('r')]);
    await seedUser(companyA, 'OWNER_A', 'OWNER');
    await seedUser(companyB, 'OWNER_B', 'OWNER');
    await seedUser(companyP, 'PERIOD', 'OWNER');
    await seedUser(companyP, 'THROTTLE', 'OWNER');
    await seedUser(companyR, 'OWNER_R', 'OWNER');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('I-01 (TZ 5.4.2): re-export of one period keeps Ид stable; hash/recordCount consistent', () => {
    let docs: Awaited<ReturnType<typeof seedDocs>>;
    let allIds: string[];
    beforeAll(async () => {
      docs = await seedDocs(companyA, { invoices: 80, payments: 2 });
      allIds = [...docs.invoiceIds, ...docs.paymentIds];
    });

    it.each(['CSV', 'XML'] as const)('%s: 80 invoices -> GENERATED, same Velto UUIDs as Ид in both exports, fileHash = sha256(file), recordCount = documents', async (format) => {
      const first = await generate(companyA, format);
      const second = await generate(companyA, format);
      for (const { job, buffer } of [first, second]) {
        expect(job.status).toBe('GENERATED');
        expect(job.recordCount).toBe(82); // 80 sales + 2 payments
        expect(job.fileHash).toBe(sha(buffer));
        expect(job.fileSize).toBe(buffer.length);
      }
      const ids = (b: Buffer) =>
        format === 'CSV'
          ? new Set(csvRows(b).map((r) => r[1]!))
          : new Set([...b.toString('utf-8').matchAll(/<Ид>([0-9a-f-]{36})<\/Ид>/g)].map((m) => m[1]!));
      const a = ids(first.buffer);
      const b = ids(second.buffer);
      expect([...b].sort()).toEqual([...a].sort());
      for (const id of allIds) expect(a.has(id)).toBe(true);
      expect(first.job.id).not.toBe(second.job.id); // a re-export is a new job over the same period
    });

    it('EXCEL: GENERATED, identical document set (numbers + sums) on re-export, fileHash/recordCount correct', async () => {
      const first = await generate(companyA, 'EXCEL');
      const second = await generate(companyA, 'EXCEL');
      for (const { job, buffer } of [first, second]) {
        expect(job.status).toBe('GENERATED');
        expect(job.recordCount).toBe(82);
        expect(job.fileHash).toBe(sha(buffer));
      }
      const rows = async (b: Buffer) => {
        const wb = await loadXlsx(b);
        const sales = wb.getWorksheet('Sotish hujjatlari')!;
        const pays = wb.getWorksheet("To'lovlar")!;
        return { sales: columnValues(sales, 1).sort(), pays: columnValues(pays, 1).sort() };
      };
      const r1 = await rows(first.buffer);
      expect(r1.sales).toHaveLength(80);
      expect(r1.pays).toHaveLength(2);
      expect(await rows(second.buffer)).toEqual(r1);
    });

    // ADR-024: "Ид = Velto UUID" must also hold for the Excel alternative. export-1c-excel.ts has no Ид column today.
    it('EXCEL: sales/payments sheets carry the Velto UUID in an "Ид" column', async () => {
      const { buffer } = await generate(companyA, 'EXCEL');
      const wb = await loadXlsx(buffer);
      const header = wb.getWorksheet('Sotish hujjatlari')!.getRow(1).values as unknown[];
      expect(header).toContain('Ид');
    });
  });

  describe('SEC-001/009: tenant isolation of export jobs', () => {
    let jobA: string;
    beforeAll(async () => {
      await seedDocs(companyA, { invoices: 1, payments: 0 });
      jobA = (await generate(companyA, 'CSV')).job.id;
    });

    it('tenant B: download / ack / getById of A job id => 404; B list excludes it', async () => {
      await http().get(`/export/1c/${jobA}/download`).set(auth('OWNER_B')).expect(404);
      await http().get(`/export/1c/${jobA}`).set(auth('OWNER_B')).expect(404);
      await http().post(`/export/1c/${jobA}/ack`).set(auth('OWNER_B')).set('Idempotency-Key', randomUUID()).send({ result: 'ACCEPTED', checksum: 'a'.repeat(64) }).expect(404);
      const list = await http().get('/export/1c?pageSize=100').set(auth('OWNER_B')).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(jobA);
      expect((await dbJob(companyA, jobA)).status).toBe('GENERATED');
    });

    it('A list contains only A jobs; job views never expose fileUrl/storageKey', async () => {
      const list = await http().get('/export/1c?pageSize=100').set(auth('OWNER_A')).expect(200);
      expect(list.body.data.length).toBeGreaterThan(0);
      const ownIds = new Set((await tenantPrisma.run(companyA, (tx) => tx.exportJob.findMany({ select: { id: true } }))).map((j) => j.id));
      for (const j of list.body.data) expect(ownIds.has(j.id)).toBe(true);
      const view = await http().get(`/export/1c/${jobA}`).set(auth('OWNER_A')).expect(200);
      expect(JSON.stringify([list.body, view.body])).not.toMatch(/fileUrl|storageKey|exports\//);
    });

    it.each([['QUEUED'], ['PROCESSING'], ['FAILED']] as const)('download of a %s job => 409 EXPORT_NOT_DOWNLOADABLE', async (status) => {
      const job = await tenantPrisma.run(companyA, async (tx) => {
        const created = await tx.exportJob.create({ data: { companyId: companyA, type: '1c', format: 'CSV', ...nowPeriod() } });
        if (status === 'QUEUED') return created;
        await tx.exportJob.update({ where: { id: created.id }, data: { status: 'PROCESSING' } });
        if (status === 'PROCESSING') return created;
        return tx.exportJob.update({ where: { id: created.id }, data: { status: 'FAILED', errorLog: { message: 'x' } } });
      });
      const res = await http().get(`/export/1c/${job.id}/download`).set(auth('OWNER_A')).expect(409);
      expect(res.body.code).toBe('EXPORT_NOT_DOWNLOADABLE');
    });

    it('worker tenant leak: A job over a period that also holds B documents exports only A documents (and vice versa)', async () => {
      const a = await seedDocs(companyA, { invoices: 2, payments: 1 });
      const b = await seedDocs(companyB, { invoices: 2, payments: 1 });
      const ids = (buf: Buffer) => new Set(csvRows(buf).map((r) => r[1]!));
      const outA = ids((await generate(companyA, 'CSV')).buffer);
      const outB = ids((await generate(companyB, 'CSV')).buffer);
      for (const id of [...a.invoiceIds, ...a.paymentIds]) {
        expect(outA.has(id)).toBe(true);
        expect(outB.has(id)).toBe(false);
      }
      for (const id of [...b.invoiceIds, ...b.paymentIds]) {
        expect(outB.has(id)).toBe(true);
        expect(outA.has(id)).toBe(false);
      }
    });

    it('worker given A job id with B companyId is a no-op (RLS hides the row); A job untouched', async () => {
      const job = await queued(companyA, 'CSV');
      const before = store.size;
      await processor().process(fakeJob(job.id, companyB));
      expect(store.size).toBe(before);
      expect((await dbJob(companyA, job.id)).status).toBe('QUEUED');
    });
  });

  describe('period rule + throttle + recovery sweep (ADR-030)', () => {
    const dayOffset = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

    it('period ending today or in the future => 400 EXPORT_PERIOD_NOT_CLOSED; nothing created', async () => {
      for (const to of [dayOffset(0), dayOffset(1), dayOffset(30)]) {
        const res = await http().post('/export/1c').set(auth('PERIOD')).send({ from: '2020-01-01', to, format: 'CSV' }).expect(400);
        expect(res.body.code).toBe('EXPORT_PERIOD_NOT_CLOSED');
      }
      expect(await tenantPrisma.run(companyP, (tx) => tx.exportJob.count())).toBe(0);
    });

    it('create is throttled to 5/min per user => 6th request 429', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await http().post('/export/1c').set(auth('THROTTLE')).send({ from: '2020-01-01', to: dayOffset(0), format: 'CSV' })).status);
      expect(statuses.slice(0, 5).every((s) => s === 400)).toBe(true);
      expect(statuses[5]).toBe(429);
    });

    it('sweep: PROCESSING older than 15 min => FAILED with errorLog; a 14-min-old one is left alone; re-run is a no-op', async () => {
      const make = async (ageMs: number) =>
        tenantPrisma.run(companyP, async (tx) => {
          const j = await tx.exportJob.create({ data: { companyId: companyP, type: '1c', format: 'CSV', ...nowPeriod() } });
          await tx.exportJob.update({ where: { id: j.id }, data: { status: 'PROCESSING' } });
          await tx.exportJob.update({ where: { id: j.id }, data: { updatedAt: new Date(Date.now() - ageMs) } });
          return j.id;
        });
      const stale = await make(16 * 60_000);
      const fresh = await make(14 * 60_000);
      const sweeper = new Export1cRecoveryService(tenantPrisma, { add: vi.fn().mockResolvedValue(undefined) } as never);
      expect(await sweeper.sweep()).toBeGreaterThanOrEqual(1);
      const s = await dbJob(companyP, stale);
      expect(s.status).toBe('FAILED');
      expect(JSON.stringify(s.errorLog)).toContain('PROCESSING');
      expect((await dbJob(companyP, fresh)).status).toBe('PROCESSING');
      await sweeper.sweep();
      expect((await dbJob(companyP, stale)).status).toBe('FAILED');
    });

    it('sweep: orphaned QUEUED (>15 min) is re-enqueued with jobId export-{id}; a fresh QUEUED is not; >ABANDONED_QUEUED_MS + enqueue failure => FAILED', async () => {
      const make = async (ageMs: number) =>
        tenantPrisma.run(companyP, async (tx) => {
          const j = await tx.exportJob.create({ data: { companyId: companyP, type: '1c', format: 'CSV', ...nowPeriod() } });
          await tx.exportJob.update({ where: { id: j.id }, data: { updatedAt: new Date(Date.now() - ageMs) } });
          return j.id;
        });
      const orphan = await make(20 * 60_000);
      const fresh = await make(5 * 60_000);
      const add = vi.fn().mockResolvedValue(undefined);
      await new Export1cRecoveryService(tenantPrisma, { add } as never).sweep();
      const ids = add.mock.calls.map((c) => c[2]?.jobId);
      expect(ids).toContain(`export-${orphan}`);
      expect(ids).not.toContain(`export-${fresh}`);
      expect((await dbJob(companyP, orphan)).status).toBe('QUEUED');

      const dead = await make(2 * 3_600_000);
      const prevAbandoned = process.env.ABANDONED_QUEUED_MS;
      process.env.ABANDONED_QUEUED_MS = String(3_600_000); // ADR-047 default is 24h; pin 1h so the 2h-old job is abandoned
      try {
        await new Export1cRecoveryService(tenantPrisma, { add: vi.fn().mockRejectedValue(new Error('redis down')) } as never).sweep();
      } finally {
        if (prevAbandoned === undefined) delete process.env.ABANDONED_QUEUED_MS;
        else process.env.ABANDONED_QUEUED_MS = prevAbandoned;
      }
      expect((await dbJob(companyP, dead)).status).toBe('FAILED');
      expect((await dbJob(companyP, orphan)).status).toBe('QUEUED'); // young enough: kept for the next sweep
    });
  });

  describe('ADR-024/025: payments.reverse is refused inside a non-FAILED export period', () => {
    const HASH = createHash('sha256').update('x').digest('hex');
    let day = 0;
    type Status = 'QUEUED' | 'PROCESSING' | 'GENERATED' | 'ACCOUNTING_ACCEPTED' | 'FAILED_REVIEW' | 'FAILED';

    async function paymentWithJob(customerId: string, status: Status) {
      const at = new Date(Date.UTC(2018, 0, 1 + day++, 10)); // distinct day per case, far from any other period
      const from = new Date(Date.UTC(2018, 0, at.getUTCDate(), 0));
      const to = new Date(from.getTime() + 86_399_000);
      const paymentId = await tenantPrisma.run(companyR, async (tx) =>
        (await tx.payment.create({ data: { companyId: companyR, number: `PAY-R-${rid()}`, customerId, amount: '10', method: PaymentMethod.CASH, createdAt: at } })).id,
      );
      const jobId = await tenantPrisma.run(companyR, async (tx) => {
        const j = await tx.exportJob.create({ data: { companyId: companyR, type: '1c', format: 'CSV', periodFrom: from, periodTo: to } });
        if (status === 'QUEUED') return j.id;
        await tx.exportJob.update({ where: { id: j.id }, data: { status: 'PROCESSING' } });
        if (status === 'PROCESSING') return j.id;
        if (status === 'FAILED') {
          await tx.exportJob.update({ where: { id: j.id }, data: { status: 'FAILED', errorLog: { message: 'x' } } });
          return j.id;
        }
        await tx.exportJob.update({
          where: { id: j.id },
          data: { status: 'GENERATED', fileHash: HASH, storageKey: `exports/1c/${companyR}/${j.id}.csv`, fileName: 'a.csv', fileSize: 1, recordCount: 1, mappingVersion: 1, generatedAt: new Date() },
        });
        return j.id;
      });
      if (status === 'ACCOUNTING_ACCEPTED' || status === 'FAILED_REVIEW') {
        const body = status === 'ACCOUNTING_ACCEPTED' ? { result: 'ACCEPTED', checksum: HASH } : { result: 'REJECTED', checksum: HASH, note: 'Kontragent topilmadi' };
        await http().post(`/export/1c/${jobId}/ack`).set(auth('OWNER_R')).set('Idempotency-Key', randomUUID()).send(body).expect(201);
      }
      return { paymentId, jobId };
    }
    const reverse = (paymentId: string) =>
      http().post(`/payments/${paymentId}/reverse`).set(auth('OWNER_R')).set('Idempotency-Key', randomUUID()).send({ reason: 'cash returned' });

    let customerId: string;
    beforeAll(async () => {
      customerId = (await tenantPrisma.run(companyR, (tx) => tx.customer.create({ data: { companyId: companyR, code: `C-${rid()}`, name: 'Rev Customer' } }))).id;
    });

    it.each(['QUEUED', 'PROCESSING', 'GENERATED', 'ACCOUNTING_ACCEPTED', 'FAILED_REVIEW'] as const)('%s period => 409 PAYMENT_REVERSAL_EXPORTED_1C, payment stays POSTED', async (status) => {
      const { paymentId, jobId } = await paymentWithJob(customerId, status);
      const res = await reverse(paymentId).expect(409);
      expect(res.body.code).toBe('PAYMENT_REVERSAL_EXPORTED_1C');
      expect(res.body.details).toMatchObject({ exportJobId: jobId });
      expect((await tenantPrisma.run(companyR, (tx) => tx.payment.findUniqueOrThrow({ where: { id: paymentId } }))).status).toBe('POSTED');
    });

    it('FAILED period => reversal allowed (nothing was exported)', async () => {
      const { paymentId } = await paymentWithJob(customerId, 'FAILED');
      const res = await reverse(paymentId);
      expect([200, 201]).toContain(res.status);
      expect((await tenantPrisma.run(companyR, (tx) => tx.payment.findUniqueOrThrow({ where: { id: paymentId } }))).status).toBe('REVERSED');
    });
  });

  describe('SEC-001/009 / TZ 7.6.3: spreadsheet formula injection', () => {
    const HOSTILE = ['=SUM(1)', '@x', '\tTabbed', '+cmd|x', '-cmd|x'];
    const SAFE_UUID = randomUUID();

    describe('1C export (CSV + Excel)', () => {
      let docs: Awaited<ReturnType<typeof seedDocs>>[];
      let company: string;
      beforeAll(async () => {
        company = await seedCompany('inj');
        docs = [];
        for (const name of HOSTILE) docs.push(await seedDocs(company, { invoices: 1, payments: 1, customerName: name }));
      });

      it('CSV: hostile customer names are prefixed with apostrophe; Ид (UUID), amounts and dates unchanged', async () => {
        const { buffer } = await generate(company, 'CSV');
        const rows = csvRows(buffer);
        const names = new Set(rows.map((r) => r[5]!));
        for (const n of HOSTILE) {
          expect(names.has(`'${n}`)).toBe(true);
          expect(names.has(n)).toBe(false);
        }
        const allIds = new Set(docs.flatMap((d) => [...d.invoiceIds, ...d.paymentIds]));
        for (const r of rows) {
          expect(allIds.has(r[1]!)).toBe(true); // UUID cell untouched
          expect(r[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
        const sale = rows.find((r) => r[0] === 'SALE')!;
        expect(sale.slice(8, 12)).toEqual(['1', '100', '100', '100']); // qty, unitPrice, lineTotal, total
      });

            it('EXCEL: hostile customer names are neutralised in Kontragentlar / Sotish / Tolovlar sheets', async () => {
        const { buffer } = await generate(company, 'EXCEL');
        const wb = await loadXlsx(buffer);
        const cells = [
          ...columnValues(wb.getWorksheet('Kontragentlar')!, 2),
          ...columnValues(wb.getWorksheet('Sotish hujjatlari')!, 3),
          ...columnValues(wb.getWorksheet("To'lovlar")!, 3),
        ];
        for (const n of HOSTILE) {
          expect(cells).toContain(`'${n}`);
          expect(cells).not.toContain(n);
        }
      });

      it('EXCEL: numbers and phone-like values are not altered (amount string, sheet structure)', async () => {
        const { buffer } = await generate(company, 'EXCEL');
        const wb = await loadXlsx(buffer);
        expect(columnValues(wb.getWorksheet('Sotish hujjatlari')!, 4).every((v) => v === '100')).toBe(true);
        expect(columnValues(wb.getWorksheet("To'lovlar")!, 4).every((v) => v === '50')).toBe(true);
      });
    });

    describe('report exports (CSV + XLSX) share the same neutralisation', () => {
      const table: ReportTable = {
        title: 'Hisobot',
        meta: [],
        notes: [],
        sections: [
          {
            name: 'S',
            columns: [{ header: 'Mijoz' }, { header: 'Izoh' }, { header: 'ID' }, { header: 'Summa', money: true }],
            rows: HOSTILE.map((h) => [h, `=1+1 ${h}`, SAFE_UUID, new Prisma.Decimal('-1250.5')]),
          },
        ],
      };

      it('CSV: hostile name/note cells get an apostrophe; UUID and negative money stay as they are', () => {
        const lines = buildReportCsv(table).toString('utf-8').split('\r\n');
        for (const h of HOSTILE) {
          expect(lines.some((l) => l.startsWith(`'${h},`) || l.startsWith(`"'${h}"`))).toBe(true);
          expect(lines.some((l) => l.startsWith(`${h},`))).toBe(false);
        }
        expect(lines.filter((l) => l.includes(SAFE_UUID)).every((l) => l.endsWith(`${SAFE_UUID},-1250.50`))).toBe(true);
      });

      it('XLSX: hostile cells neutralised; UUID string and numeric money unchanged', async () => {
        const wb = await loadXlsx(await buildReportXlsx(table));
        const sheet = wb.getWorksheet('S')!;
        const mijoz = columnValues(sheet, 1);
        for (const h of HOSTILE) {
          expect(mijoz).toContain(`'${h}`);
          expect(mijoz).not.toContain(h);
        }
        expect(columnValues(sheet, 3).filter((v) => v === SAFE_UUID)).toHaveLength(HOSTILE.length);
        expect(columnValues(sheet, 4).filter((v) => v === -1250.5)).toHaveLength(HOSTILE.length);
      });
    });
  });
});
