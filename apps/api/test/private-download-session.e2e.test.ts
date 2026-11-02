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
import { loginWithMfa } from './mfa-login';

/** Private downloads streamed through the API: revoked session, RBAC revoked mid-token, no-store, audited foreign-id denial, no fileUrl. */
describe('E2E: private download hardening (closed-pilot conditions)', () => {
  let app: INestApplication;
  let companyA: string;
  let companyB: string;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const FILE = Buffer.from('code,amount\r\nP-1,100\r\n');
  const HASH = createHash('sha256').update(FILE).digest('hex');
  const storageDouble = { getObject: async () => ({ stream: Readable.from([FILE]), size: FILE.length }) };
  const http = () => request(app.getHttpServer());
  type Session = { token: string; cookie: string[]; userId: string; companyId: string };
  const bearer = (s: Session) => ({ Authorization: `Bearer ${s.token}` });
  const permIdCache = new Map<string, string>();
  let day = 0;

  async function seedCompany(label: string) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-pd-${label}-${Date.now()}-${randomUUID().slice(0, 8)}`, name: `PD ${label}` } });
    return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `PD ${label}` } })).id;
  }

  async function seedOwner(companyId: string): Promise<Session> {
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: { companyId, firstName: 'Own', lastName: 'Er', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    const permissionIds: string[] = [];
    for (const k of permissionKeysForRole('OWNER')) {
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
        (await tx.role.findFirst({ where: { companyId, code: 'OWNER' } })) ??
        (await tx.role.create({ data: { companyId, code: 'OWNER', name: 'OWNER', isSystem: true } }));
      if (!(await tx.rolePermission.count({ where: { roleId: role.id } }))) {
        for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
      }
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    });
    const login = await loginWithMfa(app, phone, password);
    return { token: login.accessToken, cookie: (login.cookies ?? []).map((c) => c.split(';')[0]!), userId: user.id, companyId };
  }

  async function newJob(companyId: string, type: '1c' | 'company') {
    const periodFrom = new Date(Date.UTC(2021, 0, 1 + day++));
    return tenantPrisma.run(companyId, async (tx) => {
      const job = await tx.exportJob.create({ data: { companyId, type, format: type === '1c' ? 'CSV' : 'EXCEL', periodFrom, periodTo: new Date(periodFrom.getTime() + 86_399_000), status: 'QUEUED' } });
      await tx.exportJob.update({ where: { id: job.id }, data: { status: 'PROCESSING' } });
      return tx.exportJob.update({
        where: { id: job.id },
        data: { status: 'GENERATED', fileHash: HASH, storageKey: `exports/${companyId}/${job.id}`, fileName: 'f.csv', fileSize: FILE.length, recordCount: 1, mappingVersion: 1, generatedAt: new Date() },
      });
    });
  }
  const download = (s: Session, kind: '1c' | 'company', id: string) =>
    http().get(`${kind === '1c' ? '/export/1c' : '/company-export'}/${id}/download`).set(bearer(s));
  const audits = (companyId: string, action: string, entityId: string) =>
    tenantPrisma.run(companyId, (tx) => tx.auditLog.findMany({ where: { action, entityId } }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(StorageService).useValue(storageDouble).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.listen(0, '127.0.0.1');
    companyA = await seedCompany('a');
    companyB = await seedCompany('b');
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['logout', false],
    ['logout-all', true],
  ])('%s: the same access token gets 401 AUTH_SESSION_EXPIRED on both downloads (was 200 before)', async (_n, allDevices) => {
    const s = await seedOwner(companyA);
    const j1c = await newJob(companyA, '1c');
    const jco = await newJob(companyA, 'company');
    await download(s, '1c', j1c.id).expect(200);
    await download(s, 'company', jco.id).expect(200);

    await http().post('/auth/logout').set('Cookie', s.cookie).send({ allDevices }).expect(204);

    for (const [kind, id] of [['1c', j1c.id], ['company', jco.id]] as const) {
      const res = await download(s, kind, id).expect(401);
      expect(res.body.code).toBe('AUTH_SESSION_EXPIRED');
    }
    expect((await audits(companyA, 'auth.session_revoked_denied', s.userId)).length).toBeGreaterThanOrEqual(2);
  });

  it('company.export revoked mid-token => 403 on download', async () => {
    const companyC = await seedCompany('c');
    const s = await seedOwner(companyC);
    const job = await newJob(companyC, 'company');
    await download(s, 'company', job.id).expect(200);
    await tenantPrisma.run(companyC, async (tx) => {
      const perm = await tx.permission.findFirstOrThrow({ where: { module: 'company', code: 'export' } });
      await tx.rolePermission.deleteMany({ where: { permissionId: perm.id, role: { companyId: companyC } } });
    });
    await download(s, 'company', job.id).expect(403);
  });

  it('downloads carry Cache-Control: private, no-store + Pragma: no-cache', async () => {
    const s = await seedOwner(companyA);
    for (const [kind, type] of [['1c', '1c'], ['company', 'company']] as const) {
      const job = await newJob(companyA, type);
      const res = await download(s, kind, job.id).expect(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['pragma']).toBe('no-cache');
    }
    const report = await http().get('/reports/sales/export').set(bearer(s)).expect(200);
    expect(report.headers['cache-control']).toBe('private, no-store');
    const aging = await http().get('/reports/aging/export').set(bearer(s));
    if (aging.status === 200) expect(aging.headers['cache-control']).toBe('private, no-store');
  });

  it('foreign / missing job id => identical 404, denial audited in the caller company with jobId + traceId, no foreign data', async () => {
    const s = await seedOwner(companyB);
    const foreign1c = await newJob(companyA, '1c');
    const foreignCo = await newJob(companyA, 'company');
    for (const [kind, id, action] of [['1c', foreign1c.id, 'export.download_rejected'], ['company', foreignCo.id, 'company.export.download_rejected']] as const) {
      const foreign = await download(s, kind, id).expect(404);
      const missing = await download(s, kind, randomUUID()).expect(404);
      expect({ ...foreign.body, traceId: 0 }).toEqual({ ...missing.body, traceId: 0 });
      const rows = await audits(companyB, action, id);
      expect(rows).toHaveLength(1);
      const v = rows[0]!.newValue as { reason: string; jobId: string; traceId: string };
      expect(v.jobId).toBe(id);
      expect(v.reason).toBe('EXPORT_JOB_NOT_FOUND');
      expect(typeof v.traceId).toBe('string');
      expect(JSON.stringify(rows[0])).not.toContain(HASH);
      expect(await audits(companyA, action, id)).toHaveLength(0);
    }
  });

  it('import job responses (list + get) never expose fileUrl', async () => {
    const s = await seedOwner(companyA);
    const job = await tenantPrisma.run(companyA, (tx) =>
      tx.importJob.create({ data: { companyId: companyA, type: 'customers', status: 'PENDING', fileUrl: 'https://s3.example/secret-key', createdBy: s.userId, progress: 0 } }),
    );
    const one = await http().get(`/import/${job.id}`).set(bearer(s)).expect(200);
    expect(one.body.id).toBe(job.id);
    expect(JSON.stringify(one.body)).not.toMatch(/fileUrl|s3\.example/);
    const list = await http().get('/import').set(bearer(s)).expect(200);
    expect(JSON.stringify(list.body)).not.toMatch(/fileUrl|s3\.example/);
  });
});
