import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/** ADR-031/012: POST /export/1c is @Idempotent; CORS exposes the download headers (ADR-030). Real Postgres + RLS. */
describe('E2E: 1C export create idempotency + CORS exposed headers', () => {
  let app: INestApplication;
  let companyId: string;
  let token: string;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const http = () => request(app.getHttpServer());
  const jobCount = () => tenantPrisma.run(companyId, (tx) => tx.exportJob.count({ where: { type: '1c' } }));
  const create = (body: object, key?: string) => {
    const r = http().post('/export/1c').set('Authorization', `Bearer ${token}`);
    if (key) r.set('Idempotency-Key', key);
    return r.send(body);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    // Loopback-only listen: supertest's default `::` bind can collide with a foreign 127.0.0.1 listener (e.g. VS Code helper) => random 4xx.
    await app.listen(0, '127.0.0.1');
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-1c-idem-${Date.now()}`, name: '1C Idem' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: '1C Idem Co' } })).id;
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: { companyId, firstName: 'Acc', lastName: 'Idem', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    const permissionIds: string[] = [];
    for (const k of permissionKeysForRole('ACCOUNTANT')) {
      const [module, code] = k.split('.');
      permissionIds.push((await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } })).id);
    }
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      const role = await tx.role.create({ data: { companyId, code: 'ACCOUNTANT', name: 'ACCOUNTANT', isSystem: true } });
      for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    });
    token = (await http().post('/auth/login').send({ phone, password }).expect(201)).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('same Idempotency-Key replays the same job and creates no second one', async () => {
    const body = { from: '2020-01-01T00:00:00.000Z', to: '2020-01-01T23:59:59.000Z', format: 'CSV' };
    const key = randomUUID();
    const first = await create(body, key).expect(201);
    expect(await jobCount()).toBe(1);
    const second = await create(body, key).expect(201);
    expect(second.body.id).toBe(first.body.id);
    expect(await jobCount()).toBe(1);
  });

  it('a different key creates a distinct job', async () => {
    const body = { from: '2020-02-01T00:00:00.000Z', to: '2020-02-01T23:59:59.000Z', format: 'CSV' };
    const before = await jobCount();
    await create(body, randomUUID()).expect(201);
    expect(await jobCount()).toBe(before + 1);
  });

  it('CORS exposes X-Content-SHA256 and Content-Disposition, keeps credentials', async () => {
    const res = await http().get('/export/1c').set('Origin', 'http://localhost:3000').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.headers['access-control-expose-headers']).toBe('X-Content-SHA256,Content-Disposition,Retry-After');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });
});
