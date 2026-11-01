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
 * F8.1 / ADR-029 / TZ §6.5, §6.7.2, §5.4.2 F-01 (HTTP level, real Postgres + RLS):
 * agent cash -> PENDING_HANDOVER -> cashier accept (POSTED + FIFO) / reject.
 */
describe('E2E F8.1: payment handover (ADR-029)', () => {
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

  async function seedUser(companyId: string, key: string, roleCodes: string[]) {
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: { companyId, firstName: key, lastName: 'Handover', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
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
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-f81-${label}-${Date.now()}-${rid()}`, name: `F81 ${label}` } });
    return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `F81 ${label}` } })).id;
  }

  const newCustomer = (companyId: string) =>
    tenantPrisma.run(companyId, (tx) => tx.customer.create({ data: { companyId, code: `H-${rid()}`, name: 'Handover Customer' } }));
  const openShift = (k: string) => http().post('/cash-sessions/open').set(auth(k)).send({ openAmount: 0 }).expect(201);
  const pay = (k: string, customerId: string, amount: number, method = 'CASH') =>
    http().post('/payments').set(auth(k)).set('Idempotency-Key', randomUUID()).send({ customerId, amount, method }).expect(201);
  const accept = (k: string, id: string, key = randomUUID()) => http().post(`/payments/${id}/handover/accept`).set(auth(k)).set('Idempotency-Key', key);
  const reject = (k: string, id: string, reason: string, key = randomUUID()) =>
    http().post(`/payments/${id}/handover/reject`).set(auth(k)).set('Idempotency-Key', key).send({ reason });
  const dbPayment = (companyId: string, id: string) => tenantPrisma.run(companyId, (tx) => tx.payment.findUniqueOrThrow({ where: { id } }));
  const cachedBalance = async (companyId: string, customerId: string) =>
    (await tenantPrisma.run(companyId, (tx) => tx.customer.findUniqueOrThrow({ where: { id: customerId } }))).cachedBalance.toString();
  const deniedAudits = (companyId: string, traceId: string) =>
    tenantPrisma.run(companyId, (tx) => tx.auditLog.findMany({ where: { action: 'auth.permission_denied', traceId } }));

  let customerA: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    // Loopback-only listen: supertest's default `::` bind can collide with a foreign 127.0.0.1 listener (e.g. VS Code helper) => random 4xx.
    await app.listen(0, '127.0.0.1');

    companyA = await seedCompany('a');
    companyB = await seedCompany('b');
    await seedUser(companyA, 'AGENT', ['SALES_AGENT']);
    await seedUser(companyA, 'AGENT2', ['SALES_AGENT']);
    await seedUser(companyA, 'AGENT_CASHIER', ['SALES_AGENT', 'CASHIER']); // collects AND holds payments.handover
    await seedUser(companyA, 'ACCOUNTANT', ['ACCOUNTANT']);
    await seedUser(companyA, 'CASHIER', ['CASHIER']);
    await seedUser(companyA, 'OWNER', ['OWNER']);
    await seedUser(companyA, 'DIRECTOR', ['SALES_DIRECTOR']);
    await seedUser(companyB, 'AGENT_B', ['SALES_AGENT']);
    await seedUser(companyB, 'CASHIER_B', ['CASHIER']);
    customerA = (await newCustomer(companyA)).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('SEC-054: SALES_AGENT, ACCOUNTANT and SALES_DIRECTOR accept/reject => 403 + auth.permission_denied audit; payment untouched', async () => {
    const p = await pay('AGENT', customerA, 1000);
    for (const role of ['AGENT', 'ACCOUNTANT', 'DIRECTOR']) {
      for (const op of ['accept', 'reject'] as const) {
        const traceId = `trace-ho-${randomUUID()}`;
        const r = http().post(`/payments/${p.body.id}/handover/${op}`).set(auth(role)).set('x-request-id', traceId).set('Idempotency-Key', randomUUID());
        await (op === 'reject' ? r.send({ reason: 'no rights' }) : r).expect(403);
        const rows = await deniedAudits(companyA, traceId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.userId).toBe(tokens[role]!.userId);
        expect(rows[0]!.newValue).toMatchObject({ permission: 'payments.handover' });
      }
    }
    expect((await dbPayment(companyA, p.body.id)).status).toBe('PENDING_HANDOVER');
  });

  it('accept without an open cash session => 409 PAYMENT_HANDOVER_CASH_SESSION_NOT_OPEN; payment stays PENDING_HANDOVER', async () => {
    const p = await pay('AGENT', customerA, 1000);
    const res = await accept('CASHIER', p.body.id).expect(409);
    expect(res.body.code).toBe('PAYMENT_HANDOVER_CASH_SESSION_NOT_OPEN');
    expect((await dbPayment(companyA, p.body.id)).status).toBe('PENDING_HANDOVER');
  });

  it('CASHIER / OWNER with an open shift accept => 200 POSTED, audited with handover actor', async () => {
    for (const role of ['CASHIER', 'OWNER']) {
      await openShift(role);
      const p = await pay('AGENT', customerA, 2000);
      const res = await accept(role, p.body.id).expect(201);
      expect(res.body.status).toBe('POSTED');
      const row = await dbPayment(companyA, p.body.id);
      expect(row).toMatchObject({ status: 'POSTED', handoverActorId: tokens[role]!.userId });
      expect(row.handoverCashSessionId).not.toBeNull();
      const audits = await tenantPrisma.run(companyA, (tx) => tx.auditLog.findMany({ where: { action: 'payment.handover.accept', entityId: p.body.id } }));
      expect(audits).toHaveLength(1);
      expect(audits[0]!.userId).toBe(tokens[role]!.userId);
    }
  });

  it('reject by OWNER/CASHIER with reason => REJECTED, no ledger effect, no shift needed', async () => {
    const before = await cachedBalance(companyA, customerA);
    for (const role of ['CASHIER', 'OWNER']) {
      const p = await pay('AGENT', customerA, 3000);
      const res = await reject(role, p.body.id, '  Pul kelmadi  ').expect(201);
      expect(res.body.status).toBe('REJECTED');
      const row = await dbPayment(companyA, p.body.id);
      expect(row).toMatchObject({ status: 'REJECTED', handoverRejectReason: 'Pul kelmadi' });
    }
    expect(await cachedBalance(companyA, customerA)).toBe(before);
  });

  it('collector cannot resolve own payment => 403 PAYMENT_HANDOVER_SELF_RESOLVE (accept and reject)', async () => {
    await openShift('AGENT_CASHIER');
    const p = await pay('AGENT_CASHIER', customerA, 1500);
    expect((await dbPayment(companyA, p.body.id)).status).toBe('PENDING_HANDOVER');
    const a = await accept('AGENT_CASHIER', p.body.id).expect(403);
    expect(a.body.code).toBe('PAYMENT_HANDOVER_SELF_RESOLVE');
    const r = await reject('AGENT_CASHIER', p.body.id, 'self reject').expect(403);
    expect(r.body.code).toBe('PAYMENT_HANDOVER_SELF_RESOLVE');
    expect((await dbPayment(companyA, p.body.id)).status).toBe('PENDING_HANDOVER');
  });

  it('F-01 idempotency: same Idempotency-Key accept twice => identical response, one POSTED transition, one audit', async () => {
    await openShift('AGENT2').catch(() => undefined); // not permitted (no cash.open) -> ignored; cashier shift already open
    const p = await pay('AGENT', customerA, 4000);
    const key = randomUUID();
    const first = await accept('CASHIER', p.body.id, key).expect(201);
    const second = await accept('CASHIER', p.body.id, key).expect(201);
    expect(second.body).toEqual(first.body);
    const audits = await tenantPrisma.run(companyA, (tx) => tx.auditLog.findMany({ where: { action: 'payment.handover.accept', entityId: p.body.id } }));
    expect(audits).toHaveLength(1);
    // A fresh key on the already POSTED payment is a real conflict, not a replay.
    const again = await accept('CASHIER', p.body.id).expect(409);
    expect(again.body.code).toBe('PAYMENT_NOT_PENDING_HANDOVER');
  });

  it('reject with reason shorter than 3 chars => 400, payment stays PENDING_HANDOVER', async () => {
    const p = await pay('AGENT', customerA, 1000);
    await reject('CASHIER', p.body.id, 'ab').expect(400);
    await reject('CASHIER', p.body.id, '   a  ').expect(400);
    expect((await dbPayment(companyA, p.body.id)).status).toBe('PENDING_HANDOVER');
  });

  it('SEC-001..005: cashier of tenant A cannot accept/reject tenant B payment (404); in-transit never shows other tenant', async () => {
    const customerB = (await newCustomer(companyB)).id;
    const pB = await pay('AGENT_B', customerB, 7777);
    await openShift('CASHIER_B');
    await accept('CASHIER', pB.body.id).expect(404);
    await reject('CASHIER', pB.body.id, 'cross tenant').expect(404);
    expect((await dbPayment(companyB, pB.body.id)).status).toBe('PENDING_HANDOVER');

    const crossView = await http().get(`/payments/in-transit?customerId=${customerB}`).set(auth('CASHIER')).expect(200);
    expect(crossView.body).toMatchObject({ amount: '0.00', count: 0 });
    const ownView = await http().get(`/payments/in-transit?customerId=${customerB}`).set(auth('CASHIER_B')).expect(200);
    expect(ownView.body).toMatchObject({ amount: '7777.00', count: 1 });
  });

  it('SEC-023: SALES_AGENT in-transit sees only own collection; office roles see the total', async () => {
    const customer = (await newCustomer(companyA)).id;
    await pay('AGENT', customer, 1000);
    await pay('AGENT2', customer, 250);
    const a1 = await http().get(`/payments/in-transit?customerId=${customer}`).set(auth('AGENT')).expect(200);
    const a2 = await http().get(`/payments/in-transit?customerId=${customer}`).set(auth('AGENT2')).expect(200);
    const office = await http().get(`/payments/in-transit?customerId=${customer}`).set(auth('CASHIER')).expect(200);
    expect(a1.body).toMatchObject({ amount: '1000.00', count: 1 });
    expect(a2.body).toMatchObject({ amount: '250.00', count: 1 });
    expect(office.body).toMatchObject({ amount: '1250.00', count: 2 });
  });

  it('TZ §5.4.2 F-01: sync push cash => PENDING_HANDOVER, balance unchanged, reconciliation clean; accept => POSTED + FIFO, balance down', async () => {
    const customer = (await newCustomer(companyA)).id;
    const invoice = await tenantPrisma.run(companyA, (tx) =>
      tx.invoice.create({ data: { companyId: companyA, number: `H-INV-${rid()}`, customerId: customer, total: '100000', status: 'OPEN' } }),
    );
    await tenantPrisma.run(companyA, async (tx) => {
      await tx.customer.update({ where: { id: customer }, data: { cachedBalance: '100000' } });
    });

    const clientId = randomUUID();
    const push = await http()
      .post('/sync/push')
      .set(auth('AGENT'))
      .send({ documents: [{ type: 'payment', clientId, payload: { customerId: customer, clientId, amount: 60000, method: 'CASH' } }] })
      .expect(201);
    expect(push.body.results[0]).toMatchObject({ clientId, status: 'ACCEPTED', paymentStatus: 'PENDING_HANDOVER' });
    const paymentId = push.body.results[0].id as string;

    expect(await cachedBalance(companyA, customer)).toBe('100000');
    let inv = await tenantPrisma.run(companyA, (tx) => tx.invoice.findUniqueOrThrow({ where: { id: invoice.id } }));
    expect(inv.status).toBe('OPEN');
    expect(await tenantPrisma.run(companyA, (tx) => tx.paymentAllocation.count({ where: { paymentId } }))).toBe(0);

    // Reconciliation: ledger counts POSTED only, so "in transit" is not drift.
    const run1 = await http().post('/reconciliation/run').set(auth('OWNER')).set('Idempotency-Key', randomUUID()).expect(201);
    const findingsFor = () =>
      tenantPrisma.run(companyA, (tx) => tx.reconciliationFinding.findMany({ where: { status: 'OPEN', kind: 'BALANCE' } }));
    expect(run1.body.balanceFindings).toBe(0);
    expect((await findingsFor()).filter((f) => JSON.stringify(f).includes(customer))).toHaveLength(0);

    await accept('CASHIER', paymentId).expect(201);
    expect((await dbPayment(companyA, paymentId)).status).toBe('POSTED');
    expect(await cachedBalance(companyA, customer)).toBe('40000');
    inv = await tenantPrisma.run(companyA, (tx) => tx.invoice.findUniqueOrThrow({ where: { id: invoice.id } }));
    expect(inv.status).not.toBe('OPEN'); // partially paid
    const alloc = await tenantPrisma.run(companyA, (tx) => tx.paymentAllocation.findMany({ where: { paymentId } }));
    expect(alloc.map((a) => a.invoiceId)).toEqual([invoice.id]);
    expect(alloc[0]!.amount.toString()).toBe('60000');

    const run2 = await http().post('/reconciliation/run').set(auth('OWNER')).set('Idempotency-Key', randomUUID()).expect(201);
    expect(run2.body.balanceFindings).toBe(0);
  });

  it('security audit decision: agent CARD / TRANSFER are PENDING_HANDOVER too (no hiding cash as card); balance unchanged until cashier accept', async () => {
    for (const method of ['CARD', 'TRANSFER']) {
      const customer = (await newCustomer(companyA)).id;
      await tenantPrisma.run(companyA, (tx) => tx.customer.update({ where: { id: customer }, data: { cachedBalance: '9000' } }));
      const p = await pay('AGENT', customer, 5000, method);
      expect(p.body.status).toBe('PENDING_HANDOVER');
      expect(await cachedBalance(companyA, customer)).toBe('9000');
      const view = await http().get(`/payments/in-transit?customerId=${customer}`).set(auth('AGENT')).expect(200);
      expect(view.body).toMatchObject({ amount: '5000.00', count: 1 });
      await accept('CASHIER', p.body.id).expect(201);
      expect((await dbPayment(companyA, p.body.id)).status).toBe('POSTED');
    }
  });

  it('ADR-029 POST /payments/statuses: agent sees only own; foreign agent / other tenant absent; >100 => 400 PAYMENT_STATUSES_LIMIT', async () => {
    const customer = (await newCustomer(companyA)).id;
    const customerB = (await newCustomer(companyB)).id;
    const mine = await pay('AGENT', customer, 111);
    const theirs = await pay('AGENT2', customer, 222);
    const foreignTenant = await pay('AGENT_B', customerB, 333);
    const statuses = (k: string, body: object) => http().post('/payments/statuses').set(auth(k)).send(body);

    const res = await statuses('AGENT', { ids: [mine.body.id, theirs.body.id, foreignTenant.body.id, randomUUID()] }).expect(200);
    expect(res.body.map((r: { id: string }) => r.id)).toEqual([mine.body.id]);
    expect(res.body[0]).toMatchObject({ status: 'PENDING_HANDOVER' });

    const byClient = await statuses('AGENT', { clientIds: [randomUUID()] }).expect(200);
    expect(byClient.body).toEqual([]);

    // Office role sees every same-tenant payment, still never another tenant's.
    const office = await statuses('CASHIER', { ids: [mine.body.id, theirs.body.id, foreignTenant.body.id] }).expect(200);
    expect(office.body.map((r: { id: string }) => r.id).sort()).toEqual([mine.body.id, theirs.body.id].sort());

    // ACCOUNTANT (payments.read, not SALES_AGENT) is not owner-scoped: documents current behaviour = same-tenant office view.
    const acc = await statuses('ACCOUNTANT', { ids: [mine.body.id, theirs.body.id, foreignTenant.body.id] }).expect(200);
    expect(acc.body.map((r: { id: string }) => r.id).sort()).toEqual([mine.body.id, theirs.body.id].sort());

    const many = (n: number) => Array.from({ length: n }, () => randomUUID());
    const over = await statuses('AGENT', { ids: many(60), clientIds: many(41) }).expect(400);
    expect(over.body.code).toBe('PAYMENT_STATUSES_LIMIT');
    await statuses('AGENT', { ids: many(101) }).expect(400);
    await statuses('AGENT', {}).expect(400);
    await statuses('AGENT', { ids: many(60), clientIds: many(40) }).expect(200);
  });
});
