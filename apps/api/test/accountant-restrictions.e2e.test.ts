import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import { prisma, systemPrisma } from '@velto/database';
import { PERMISSION_DEFS, permissionKeysForRole } from '../../../packages/database/src/rbac-catalog';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { uniquePhone } from './unique-phone';

/**
 * F1.4 / SEC-020..024, SEC-054, §16.3: an ACCOUNTANT (real catalog grant) is
 * read/export-only — every write is 403 + `auth.permission_denied` audit, while
 * reports export and 1C export succeed. Driven over real HTTP.
 */
describe('E2E F1.4: ACCOUNTANT restrictions', () => {
  let app: INestApplication;
  let companyId: string;
  let userId: string;
  let token: string;
  const phone = uniquePhone();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tenantPrisma = new TenantPrismaService();
  const id = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    // Loopback-only listen: supertest's default `::` bind can collide with a foreign 127.0.0.1 listener (e.g. VS Code helper) => random 4xx.
    await app.listen(0, '127.0.0.1');

    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-acc-${Date.now()}`, name: 'ACC' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'ACC Co' } })).id;

    const permissionIds: string[] = [];
    for (const key of permissionKeysForRole('ACCOUNTANT')) {
      const [module, code] = key.split('.');
      expect(PERMISSION_DEFS.some((d) => d.module === module && d.actions.includes(code))).toBe(true);
      const p = await systemPrisma.permission.upsert({
        where: { module_code: { module, code } },
        update: {},
        create: { module, code },
      });
      permissionIds.push(p.id);
    }
    const user = await systemPrisma.user.create({
      data: { companyId, firstName: 'Acc', lastName: 'Ountant', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    userId = user.id;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      const role = await tx.role.create({ data: { companyId, code: 'ACCOUNTANT', name: 'Buxgalter', isSystem: true } });
      for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    });
    const res = await request(app.getHttpServer()).post('/auth/login').send({ phone, password }).expect(201);
    token = res.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  const denied: [string, 'post' | 'patch', string, string][] = [
    ['payments create', 'post', '/payments', 'payments.create'],
    ['payments allocate (F2.1)', 'post', `/payments/${id}/allocate`, 'payments.allocate'],
    ['cash open', 'post', '/cash-sessions/open', 'cash.open'],
    ['cash close', 'post', `/cash-sessions/${id}/close`, 'cash.close'],
    ['order confirm', 'post', `/orders/${id}/confirm`, 'orders.update'],
    ['order cancel', 'post', `/orders/${id}/cancel`, 'orders.cancel'],
    ['stock adjust', 'post', '/stock/adjust', 'stock.adjust'],
    ['users create', 'post', '/users', 'users.create'],
    ['settings update', 'patch', '/settings', 'settings.update'],
    // ADR-003c: ACCOUNTANT's only write is integrations.ack1c — every other write stays 403.
    ['payment reverse (F2.1)', 'post', `/payments/${id}/reverse`, 'payments.reverse'],
    ['payment handover accept (ADR-029)', 'post', `/payments/${id}/handover/accept`, 'payments.handover'],
    ['payment handover reject (ADR-029)', 'post', `/payments/${id}/handover/reject`, 'payments.handover'],
    ['customer block', 'post', `/customers/${id}/block`, 'customers.update'],
    ['purchase order create', 'post', '/purchases/orders', 'purchases.create'],
    ['supplier create', 'post', '/purchases/suppliers', 'purchases.create'],
    ['reconciliation run', 'post', '/reconciliation/run', 'reconciliation.fix'],
  ];

  it.each(denied)('%s => 403 + auth.permission_denied audit', async (_label, method, path, permission) => {
    const traceId = `trace-acc-${randomUUID()}`;
    const agent = request(app.getHttpServer());
    await agent[method](path)
      .set('Authorization', `Bearer ${token}`)
      .set('x-request-id', traceId)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(403);
    const rows = await tenantPrisma.run(companyId, (tx) =>
      tx.auditLog.findMany({ where: { action: 'auth.permission_denied', traceId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(userId);
    expect(rows[0].newValue).toMatchObject({ permission });
  });

  it('reports export (sales/agents/overview) => 200', async () => {
    for (const path of ['/reports/sales/export', '/reports/agents/export', '/reports/overview/export']) {
      await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`).expect(200);
    }
  });

  it('1C export: list => 200, create job => 2xx', async () => {
    await request(app.getHttpServer()).get('/export/1c').set('Authorization', `Bearer ${token}`).expect(200);
    const res = await request(app.getHttpServer())
      .post('/export/1c')
      .set('Authorization', `Bearer ${token}`)
      .send({ from: '2026-01-01', to: '2026-01-31', format: 'XML' });
    expect([200, 201, 202]).toContain(res.status);
  });
});
