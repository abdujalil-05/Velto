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
import { loginWithMfa } from './mfa-login';

/**
 * F2.1 / SEC-054: POST /payments/:id/allocate requires `payments.allocate`
 * (real catalog: OWNER, SALES_DIRECTOR, CASHIER). SALES_AGENT and ACCOUNTANT
 * get 403 + `auth.permission_denied` audit; CASHIER allocates an advance.
 */
describe('E2E F2.1: payment advance allocation RBAC', () => {
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

    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-alloc-${Date.now()}`, name: 'ALLOC' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'ALLOC Co' } })).id;

    for (const roleCode of ['SALES_AGENT', 'ACCOUNTANT', 'CASHIER']) {
      const permissionIds: string[] = [];
      for (const key of permissionKeysForRole(roleCode)) {
        const [module, code] = key.split('.');
        const p = await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } });
        permissionIds.push(p.id);
      }
      const phone = uniquePhone();
      const user = await systemPrisma.user.create({
        data: { companyId, firstName: roleCode, lastName: 'Alloc', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        const role = await tx.role.create({ data: { companyId, code: roleCode, name: roleCode, isSystem: true } });
        for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
        await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
      });
      const res = { body: await loginWithMfa(app, phone, password) };
      tokens[roleCode] = { token: res.body.accessToken, userId: user.id };
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(['SALES_AGENT', 'ACCOUNTANT'])('%s POST /payments/:id/allocate => 403 + auth.permission_denied audit', async (role) => {
    const traceId = `trace-alloc-${randomUUID()}`;
    await request(app.getHttpServer())
      .post(`/payments/${randomUUID()}/allocate`)
      .set('Authorization', `Bearer ${tokens[role]!.token}`)
      .set('x-request-id', traceId)
      .set('Idempotency-Key', randomUUID())
      .send({ allocations: [{ invoiceId: randomUUID(), amount: '1' }] })
      .expect(403);
    const rows = await tenantPrisma.run(companyId, (tx) =>
      tx.auditLog.findMany({ where: { action: 'auth.permission_denied', traceId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(tokens[role]!.userId);
    expect(rows[0]!.newValue).toMatchObject({ permission: 'payments.allocate' });
  });

  it('CASHIER allocates a payment advance to an invoice => 201, advance reduced, audited', async () => {
    const cashier = tokens.CASHIER!;
    const customer = await tenantPrisma.run(companyId, (tx) =>
      tx.customer.create({ data: { companyId, code: `ALLOC-C-${Date.now()}`, name: 'Alloc Customer' } }),
    );

    const pay = await request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${cashier.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ customerId: customer.id, amount: 30000, method: 'TRANSFER' })
      .expect(201);
    expect(pay.body.advance).toBe('30000');

    const invoice = await tenantPrisma.run(companyId, (tx) =>
      tx.invoice.create({ data: { companyId, number: `ALLOC-INV-${Date.now()}`, customerId: customer.id, total: '20000', status: 'OPEN' } }),
    );

    const res = await request(app.getHttpServer())
      .post(`/payments/${pay.body.id}/allocate`)
      .set('Authorization', `Bearer ${cashier.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ allocations: [{ invoiceId: invoice.id, amount: '20000' }] })
      .expect(201);
    expect(res.body.advance).toBe('10000');

    const [inv, audits] = await tenantPrisma.run(companyId, (tx) =>
      Promise.all([
        tx.invoice.findUniqueOrThrow({ where: { id: invoice.id } }),
        tx.auditLog.findMany({ where: { action: 'payment.allocate', entityId: pay.body.id } }),
      ]),
    );
    expect(inv.status).toBe('PAID');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBe(cashier.userId);
  });
});
