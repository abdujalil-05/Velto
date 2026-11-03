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
 * PO 2026-11-02: POST /payments/reconciliations requires `payments.handover`
 * (real catalog: OWNER + CASHIER). ACCOUNTANT, SALES_DIRECTOR and SALES_AGENT
 * get 403 + `auth.permission_denied`. GET /payments/reconciliations is not
 * captured by GET /payments/:id; the agent status endpoint uses payments.create.
 */
describe('E2E: payment intent reconciliation RBAC + routing', () => {
  let app: INestApplication;
  let companyId: string;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tokens: Record<string, { token: string; userId: string }> = {};
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.listen(0, '127.0.0.1');

    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-recon-e2e-${Date.now()}`, name: 'RECON' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'RECON Co' } })).id;

    for (const roleCode of ['SALES_AGENT', 'ACCOUNTANT', 'SALES_DIRECTOR', 'CASHIER']) {
      const permissionIds: string[] = [];
      for (const key of permissionKeysForRole(roleCode)) {
        const [module, code] = key.split('.');
        const p = await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } });
        permissionIds.push(p.id);
      }
      const phone = uniquePhone();
      const user = await systemPrisma.user.create({
        data: { companyId, firstName: roleCode, lastName: 'Recon', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        const role = await tx.role.create({ data: { companyId, code: roleCode, name: roleCode, isSystem: true } });
        for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
        await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
      });
      tokens[roleCode] = { token: (await loginWithMfa(app, phone, password)).accessToken, userId: user.id };
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(['ACCOUNTANT', 'SALES_DIRECTOR', 'SALES_AGENT'])('%s POST /payments/reconciliations => 403 + auth.permission_denied audit', async (role) => {
    const traceId = `trace-recon-${randomUUID()}`;
    await http()
      .post('/payments/reconciliations')
      .set('Authorization', `Bearer ${tokens[role]!.token}`)
      .set('x-request-id', traceId)
      .send({ clientId: randomUUID(), outcome: 'EXISTING_PAYMENT_CONFIRMED', reason: 'Kassa hujjati bilan solishtirildi' })
      .expect(403);
    const rows = await tenantPrisma.run(companyId, (tx) => tx.auditLog.findMany({ where: { action: 'auth.permission_denied', traceId } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.newValue).toMatchObject({ permission: 'payments.handover' });
    expect(await tenantPrisma.run(companyId, (tx) => tx.paymentIntentResolution.count())).toBe(0);
  });

  it('CASHIER confirms a rejected intent => 201, identical repeat => 200 (same row), audit carries x-request-id; lists + agent status route correctly', async () => {
    const cashier = tokens.CASHIER!;
    const customer = await tenantPrisma.run(companyId, (tx) => tx.customer.create({ data: { companyId, code: `RECON-C-${Date.now()}`, name: 'Recon Customer' } }));
    const clientId = randomUUID();
    const pay = await http()
      .post('/payments')
      .set('Authorization', `Bearer ${cashier.token}`)
      .send({ customerId: customer.id, amount: 30000, method: 'TRANSFER', clientId })
      .expect(201);
    await http()
      .post('/payments')
      .set('Authorization', `Bearer ${cashier.token}`)
      .send({ customerId: customer.id, amount: 30001, method: 'TRANSFER', clientId })
      .expect(409);

    const open = await http().get('/payments/reconciliations?status=OPEN').set('Authorization', `Bearer ${tokens.ACCOUNTANT!.token}`).expect(200);
    expect(open.body.data.map((r: { clientId: string }) => r.clientId)).toContain(clientId);

    const traceId = `trace-recon-ok-${randomUUID()}`;
    const body = { clientId, outcome: 'EXISTING_PAYMENT_CONFIRMED', reason: 'Bank ko\'chirmasi bilan tasdiqlandi' };
    const first = await http().post('/payments/reconciliations').set('Authorization', `Bearer ${cashier.token}`).set('x-request-id', traceId).send(body).expect(201);
    expect(first.body.resolution).toMatchObject({ clientId, paymentId: pay.body.id, outcome: 'EXISTING_PAYMENT_CONFIRMED', traceId });
    const second = await http().post('/payments/reconciliations').set('Authorization', `Bearer ${cashier.token}`).send(body).expect(200);
    expect(second.body.resolution.id).toBe(first.body.resolution.id);
    await http()
      .post('/payments/reconciliations')
      .set('Authorization', `Bearer ${cashier.token}`)
      .send({ ...body, outcome: 'NOT_POSTED_CONFIRMED', evidenceRef: 'BANK-1' })
      .expect(409)
      .expect((res) => expect(res.body.code).toBe('PAYMENT_RECONCILIATION_CONTRADICTION'));

    const audits = await tenantPrisma.run(companyId, (tx) => tx.auditLog.findMany({ where: { action: 'payment.reconcile', entityId: pay.body.id } }));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.traceId).toBe(traceId);

    const resolved = await http().get('/payments/reconciliations?status=RESOLVED').set('Authorization', `Bearer ${cashier.token}`).expect(200);
    expect(resolved.body.data.map((r: { clientId: string }) => r.clientId)).toContain(clientId);

    // Agent did not request this intent -> UNKNOWN (no leak); validation caps the batch at 100.
    const status = await http()
      .post('/payments/reconciliations/status')
      .set('Authorization', `Bearer ${tokens.SALES_AGENT!.token}`)
      .send({ clientIds: [clientId] })
      .expect(200);
    expect(status.body).toEqual({ items: [{ clientId, status: 'UNKNOWN' }] });
    await http()
      .post('/payments/reconciliations/status')
      .set('Authorization', `Bearer ${tokens.SALES_AGENT!.token}`)
      .send({ clientIds: Array.from({ length: 101 }, () => randomUUID()) })
      .expect(400);
  });
});
