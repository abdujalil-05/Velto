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

/**
 * F2.1 / SEC-054: payment and stock-movement reversal are denied to ACCOUNTANT
 * and SALES_AGENT (real catalog grants) — 403 + `auth.permission_denied` audit.
 */
describe('E2E F2.1: reversal endpoints RBAC', () => {
  let app: INestApplication;
  let companyId: string;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tokens: Record<string, { token: string; userId: string }> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    // Loopback-only listen: supertest's default `::` bind can collide with a foreign 127.0.0.1 listener (e.g. VS Code helper) => random 4xx.
    await app.listen(0, '127.0.0.1');

    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-rev-${Date.now()}`, name: 'REV' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'REV Co' } })).id;

    for (const roleCode of ['ACCOUNTANT', 'SALES_AGENT']) {
      const permissionIds: string[] = [];
      for (const key of permissionKeysForRole(roleCode)) {
        const [module, code] = key.split('.');
        const p = await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } });
        permissionIds.push(p.id);
      }
      const phone = uniquePhone();
      const user = await systemPrisma.user.create({
        data: { companyId, firstName: roleCode, lastName: 'Rev', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        const role = await tx.role.create({ data: { companyId, code: roleCode, name: roleCode, isSystem: true } });
        for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
        await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
      });
      const res = await request(app.getHttpServer()).post('/auth/login').send({ phone, password }).expect(201);
      tokens[roleCode] = { token: res.body.accessToken, userId: user.id };
    }
  });

  afterAll(async () => {
    await app.close();
  });

  const cases: [string, string, string][] = [];
  for (const role of ['ACCOUNTANT', 'SALES_AGENT']) {
    cases.push([role, `/payments/${randomUUID()}/reverse`, 'payments.reverse']);
    cases.push([role, `/stock/movements/${randomUUID()}/reverse`, 'stock.reverse']);
  }

  it.each(cases)('%s POST %s => 403 + auth.permission_denied audit', async (role, path, permission) => {
    const traceId = `trace-rev-${randomUUID()}`;
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${tokens[role]!.token}`)
      .set('x-request-id', traceId)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'should be denied' })
      .expect(403);
    const rows = await tenantPrisma.run(companyId, (tx) =>
      tx.auditLog.findMany({ where: { action: 'auth.permission_denied', traceId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(tokens[role]!.userId);
    expect(rows[0]!.newValue).toMatchObject({ permission });
  });
});
