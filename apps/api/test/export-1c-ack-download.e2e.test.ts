import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { uniquePhone } from './unique-phone';

/** F5.3 / ADR-030: 1C export download (private stream) + manual ACK + throttles. Real Postgres + RLS, StorageService test double. */
describe('E2E F5.3: 1C export download / ACK / limits', () => {
  let app: INestApplication;
  let companyA: string;
  let companyB: string;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tokens: Record<string, { token: string; userId: string }> = {};
  const permIdCache = new Map<string, string>();
  const http = () => request(app.getHttpServer());
  const auth = (k: string) => ({ Authorization: `Bearer ${tokens[k]!.token}` });
  const rid = () => randomUUID().slice(0, 8);
  const FILE = Buffer.from('code,amount\r\nP-1,100\r\n');
  const HASH = createHash('sha256').update(FILE).digest('hex');
  const storageDouble = {
    getObject: async (key: string) => {
      if (!key.startsWith('exports/')) throw new Error('unexpected key');
      return { stream: Readable.from([FILE]), size: FILE.length };
    },
  };

  async function seedUser(companyId: string, key: string, roleCodes: string[]) {
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: { companyId, firstName: key, lastName: 'Export1c', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
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
    const res = await http().post('/auth/login').send({ phone, password }).expect(201);
    tokens[key] = { token: res.body.accessToken, userId: user.id };
  }

  async function seedCompany(label: string) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-f53-${label}-${Date.now()}-${rid()}`, name: `F53 ${label}` } });
    return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `F53 ${label}` } })).id;
  }

  let day = 0;
  /** Inserts a QUEUED job; GENERATED ones walk the legal transition QUEUED -> PROCESSING -> GENERATED. */
  async function newJob(companyId: string, status: 'QUEUED' | 'PROCESSING' | 'GENERATED') {
    const periodFrom = new Date(Date.UTC(2020, 0, 1 + day++));
    const periodTo = new Date(periodFrom.getTime() + 86_399_000);
    return tenantPrisma.run(companyId, async (tx) => {
      const job = await tx.exportJob.create({ data: { companyId, type: '1c', format: 'CSV', periodFrom, periodTo, status: 'QUEUED' } });
      if (status === 'QUEUED') return job;
      await tx.exportJob.update({ where: { id: job.id }, data: { status: 'PROCESSING' } });
      if (status === 'PROCESSING') return job;
      return tx.exportJob.update({
        where: { id: job.id },
        data: { status: 'GENERATED', fileHash: HASH, storageKey: `exports/${companyId}/${job.id}.csv`, fileName: 'export 1c.csv', fileSize: FILE.length, recordCount: 1, mappingVersion: 1, generatedAt: new Date() },
      });
    });
  }
  const dbJob = (companyId: string, id: string) => tenantPrisma.run(companyId, (tx) => tx.exportJob.findUniqueOrThrow({ where: { id } }));
  const ackReq = (k: string, id: string, body: object, key = randomUUID()) => http().post(`/export/1c/${id}/ack`).set(auth(k)).set('Idempotency-Key', key).send(body);
  const audits = (companyId: string, action: string, entityId: string) =>
    tenantPrisma.run(companyId, (tx) => tx.auditLog.findMany({ where: { action, entityId } }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(StorageService).useValue(storageDouble).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    // Loopback-only listen: supertest's default `::` bind can collide with a foreign 127.0.0.1 listener (e.g. VS Code helper) => random 4xx.
    await app.listen(0, '127.0.0.1');
    companyA = await seedCompany('a');
    companyB = await seedCompany('b');
    await seedUser(companyA, 'OWNER', ['OWNER']);
    await seedUser(companyA, 'ACCOUNTANT', ['ACCOUNTANT']);
    await seedUser(companyA, 'AGENT', ['SALES_AGENT']);
    await seedUser(companyA, 'CASHIER', ['CASHIER']);
    await seedUser(companyA, 'DIRECTOR', ['SALES_DIRECTOR']);
    await seedUser(companyA, 'THROTTLED', ['ACCOUNTANT']);
    await seedUser(companyB, 'OWNER_B', ['OWNER']);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('download', () => {
    it('GENERATED: streams the file, sha256 + disposition headers, no fileUrl/storageKey in job view; audit export.download', async () => {
      const job = await newJob(companyA, 'GENERATED');
      const res = await http().get(`/export/1c/${job.id}/download`).set(auth('ACCOUNTANT')).buffer().parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(res.headers['x-content-sha256']).toBe(HASH);
      expect(res.headers['content-disposition']).toContain('attachment; filename="export_1c.csv"');
      expect((res.body as Buffer).equals(FILE)).toBe(true);
      expect(await audits(companyA, 'export.download', job.id)).toHaveLength(1);

      const view = await http().get(`/export/1c/${job.id}`).set(auth('ACCOUNTANT')).expect(200);
      expect(JSON.stringify(view.body)).not.toMatch(/fileUrl|storageKey|exports\//);
      const list = await http().get('/export/1c').set(auth('ACCOUNTANT')).expect(200);
      expect(JSON.stringify(list.body)).not.toMatch(/fileUrl|storageKey/);
    });

    it('tenant B gets 404 for tenant A job', async () => {
      const job = await newJob(companyA, 'GENERATED');
      await http().get(`/export/1c/${job.id}/download`).set(auth('OWNER_B')).expect(404);
    });

    it('SALES_AGENT => 403 + auth.permission_denied audit', async () => {
      const job = await newJob(companyA, 'GENERATED');
      const traceId = `trace-dl-${randomUUID()}`;
      await http().get(`/export/1c/${job.id}/download`).set(auth('AGENT')).set('x-request-id', traceId).expect(403);
      const rows = await tenantPrisma.run(companyA, (tx) => tx.auditLog.findMany({ where: { action: 'auth.permission_denied', traceId } }));
      expect(rows).toHaveLength(1);
    });

    it('before GENERATED (QUEUED) => 409', async () => {
      const job = await newJob(companyA, 'QUEUED');
      const res = await http().get(`/export/1c/${job.id}/download`).set(auth('ACCOUNTANT')).expect(409);
      expect(res.body.code).toBe('EXPORT_NOT_DOWNLOADABLE');
    });

    it('download is throttled to 30/min per user => 429', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) statuses.push((await http().get(`/export/1c/${randomUUID()}/download`).set(auth('THROTTLED'))).status);
      expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true);
      expect(statuses[30]).toBe(429);
    });
  });

  describe('ack', () => {
    it('ACCEPTED happy path: status, ack columns, audit export.ack; second ACK => 409', async () => {
      const job = await newJob(companyA, 'GENERATED');
      const res = await ackReq('OWNER', job.id, { result: 'ACCEPTED', checksum: HASH.toUpperCase() }).expect(201);
      expect(res.body.status).toBe('ACCOUNTING_ACCEPTED');
      expect(JSON.stringify(res.body)).not.toMatch(/fileUrl|storageKey/);
      const row = await dbJob(companyA, job.id);
      expect(row.acknowledgedBy).toBe(tokens.OWNER!.userId);
      expect(row.acknowledgedAt).not.toBeNull();
      expect(row.ackChecksum).toBe(HASH);
      const log = await audits(companyA, 'export.ack', job.id);
      expect(log).toHaveLength(1);
      expect(log[0]!.newValue).toMatchObject({ jobId: job.id, result: 'ACCEPTED' }); // fileHash is masked by audit redaction (the row itself holds it)

      const again = await ackReq('OWNER', job.id, { result: 'ACCEPTED', checksum: HASH }).expect(409);
      expect(again.body.code).toBe('EXPORT_ACK_NOT_ALLOWED');
    });

    it('same Idempotency-Key replays the stored response, one audit row', async () => {
      const job = await newJob(companyA, 'GENERATED');
      const key = randomUUID();
      const first = await ackReq('OWNER', job.id, { result: 'ACCEPTED', checksum: HASH }, key).expect(201);
      const replay = await ackReq('OWNER', job.id, { result: 'ACCEPTED', checksum: HASH }, key).expect(201);
      expect(replay.body).toEqual(first.body);
      expect(await audits(companyA, 'export.ack', job.id)).toHaveLength(1);
    });

    it('checksum mismatch => 409, job stays GENERATED', async () => {
      const job = await newJob(companyA, 'GENERATED');
      const res = await ackReq('OWNER', job.id, { result: 'ACCEPTED', checksum: 'a'.repeat(64) }).expect(409);
      expect(res.body.code).toBe('EXPORT_ACK_CHECKSUM_MISMATCH');
      expect((await dbJob(companyA, job.id)).status).toBe('GENERATED');
    });

    it('REJECTED without note (or < 3 chars) => 400; with note => FAILED_REVIEW', async () => {
      const job = await newJob(companyA, 'GENERATED');
      await ackReq('OWNER', job.id, { result: 'REJECTED', checksum: HASH }).expect(400);
      await ackReq('OWNER', job.id, { result: 'REJECTED', checksum: HASH, note: ' a ' }).expect(400);
      const ok = await ackReq('OWNER', job.id, { result: 'REJECTED', checksum: HASH, note: 'Kontragent topilmadi' }).expect(201);
      expect(ok.body.status).toBe('FAILED_REVIEW');
      expect((await dbJob(companyA, job.id)).ackNote).toBe('Kontragent topilmadi');
    });

    it('ACK on a non-GENERATED job (PROCESSING) => 409', async () => {
      const job = await newJob(companyA, 'PROCESSING');
      await ackReq('OWNER', job.id, { result: 'ACCEPTED', checksum: HASH }).expect(409);
    });

    it('tenant B => 404 and the job stays GENERATED', async () => {
      const job = await newJob(companyA, 'GENERATED');
      await ackReq('OWNER_B', job.id, { result: 'ACCEPTED', checksum: HASH }).expect(404);
      expect((await dbJob(companyA, job.id)).status).toBe('GENERATED');
    });

    it('ADR-003c exception: ACCOUNTANT holds integrations.ack1c => ACK 2xx, acknowledgedBy = accountant, audit export.ack', async () => {
      const job = await newJob(companyA, 'GENERATED');
      const res = await ackReq('ACCOUNTANT', job.id, { result: 'ACCEPTED', checksum: HASH }).expect(201);
      expect(res.body.status).toBe('ACCOUNTING_ACCEPTED');
      expect((await dbJob(companyA, job.id)).acknowledgedBy).toBe(tokens.ACCOUNTANT!.userId);
      expect(await audits(companyA, 'export.ack', job.id)).toHaveLength(1);
    });

    it.each([['AGENT'], ['CASHIER'], ['DIRECTOR']])('%s (no integrations.ack1c) => 403 + auth.permission_denied audit, job unchanged', async (who) => {
      const job = await newJob(companyA, 'GENERATED');
      const traceId = `trace-ack-${randomUUID()}`;
      await ackReq(who, job.id, { result: 'ACCEPTED', checksum: HASH }).set('x-request-id', traceId).expect(403);
      const rows = await tenantPrisma.run(companyA, (tx) => tx.auditLog.findMany({ where: { action: 'auth.permission_denied', traceId } }));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.newValue).toMatchObject({ permission: 'integrations.ack1c' });
      expect((await dbJob(companyA, job.id)).status).toBe('GENERATED');
    });
  });

  describe('active job limit', () => {
    it('3 QUEUED/PROCESSING jobs => create returns 429 EXPORT_ACTIVE_LIMIT and creates nothing', async () => {
      const company = await seedCompany('limit');
      await seedUser(company, 'OWNER_L', ['OWNER']);
      for (let i = 0; i < 3; i++) await newJob(company, i === 0 ? 'PROCESSING' : 'QUEUED');
      const res = await http().post('/export/1c').set(auth('OWNER_L')).send({ from: '2021-01-01', to: '2021-01-02', format: 'CSV' }).expect(429);
      expect(res.body.code).toBe('EXPORT_ACTIVE_LIMIT');
      expect(await tenantPrisma.run(company, (tx) => tx.exportJob.count())).toBe(3);
    });
  });
});
