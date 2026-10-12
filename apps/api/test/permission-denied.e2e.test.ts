import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import { prisma, systemPrisma } from '@velto/database';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';

/**
 * §16.3 / SEC-020..024, SEC-054: "ruxsat rad etilsa 403 + audit event",
 * driven over real HTTP (JwtAuthGuard -> TenantContextInterceptor).
 */
describe('E2E §16.3: permission denied => 403 + audit event (+ traceId), no cross-tenant data', () => {
  let app: INestApplication;
  let companyA: string;
  let userA: string;
  let accessToken: string;
  const phone = `+99890${Math.floor(1_000_000 + Math.random() * 8_000_000)}`;
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const secretCustomerName = `TenantB-Secret-${Date.now()}`;
  const tenantPrisma = new TenantPrismaService();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.init();

    const mk = async (label: string) => {
      const t = await systemPrisma.tenant.create({ data: { slug: `test-pd-${label}-${Date.now()}`, name: `PD ${label}` } });
      return (await systemPrisma.company.create({ data: { tenantId: t.id, name: `PD Co ${label}` } })).id;
    };
    companyA = await mk('a');
    const companyB = await mk('b');

    // User in A holds a role with NO permissions -> customers.read is denied.
    const user = await systemPrisma.user.create({
      data: { companyId: companyA, firstName: 'No', lastName: 'Perm', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    userA = user.id;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyA}, true)`;
      const role = await tx.role.create({ data: { companyId: companyA, code: 'NO_PERMS', name: 'No perms' } });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyB}, true)`;
      await tx.customer.create({ data: { companyId: companyB, code: 'PD-B-1', name: secretCustomerName } });
    });

    const res = await request(app.getHttpServer()).post('/auth/login').send({ phone, password }).expect(201);
    accessToken = res.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 403 with the trilingual error contract and leaks no other-tenant data', async () => {
    const res = await request(app.getHttpServer())
      .get('/customers')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);
    expect(res.body.code).toBeTruthy();
    expect(res.body.message).toEqual(expect.objectContaining({ uz: expect.any(String), ru: expect.any(String), en: expect.any(String) }));
    expect(JSON.stringify(res.body)).not.toContain(secretCustomerName);
  });

  it('writes an "auth.permission_denied" audit row carrying the request traceId', async () => {
    const traceId = `trace-${Date.now()}-denied`;
    await request(app.getHttpServer())
      .get('/customers')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('x-request-id', traceId)
      .expect(403);

    const rows = await tenantPrisma.run(companyA, (tx) =>
      tx.auditLog.findMany({ where: { action: 'auth.permission_denied', traceId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(userA);
    expect(rows[0].entity).toBe('User');
    expect(rows[0].newValue).toMatchObject({ permission: 'customers.read', method: 'GET' });
  });
});
