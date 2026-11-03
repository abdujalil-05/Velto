import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import { parsePermissionKey, prisma, systemPrisma } from '@velto/database';
import { permissionKeysForRole } from '../../../packages/database/src/rbac-catalog';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { uniquePhone } from './unique-phone';
import { loginWithMfa } from './mfa-login';

/**
 * ADR-061 over HTTP (real guards/interceptor/filter, real Postgres + RLS):
 * restore/deleted-list need `customers.restore`; every rejection is audited even though the
 * request tx rolled back (TenantContext.afterRollback); rejected ops leave the ledger byte-identical;
 * cross-tenant delete/restore/allocate => 404, no effect.
 */
describe('E2E ADR-061: customer lifecycle RBAC, rejection audit, ledger freeze, tenant isolation', () => {
  let app: INestApplication;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tag = randomUUID().slice(0, 6);
  const tokens: Record<string, string> = {};
  let companyId: string;
  let companyB: string;
  let seq = 0;

  const seedCompany = async (label: string) => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-clife-${label}-${Date.now()}-${tag}`, name: label } });
    return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `${label} Co` } })).id;
  };
  const seedUser = async (cid: string, roleCode: string): Promise<string> => {
    const permissionIds: string[] = [];
    for (const key of permissionKeysForRole(roleCode)) {
      const { module, code } = parsePermissionKey(key);
      permissionIds.push((await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } })).id);
    }
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: { companyId: cid, firstName: roleCode, lastName: 'Cl', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${cid}, true)`;
      const role = await tx.role.create({ data: { companyId: cid, code: roleCode, name: roleCode, isSystem: true } });
      for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    });
    tokens[`${cid === companyId ? 'A' : 'B'}:${roleCode}`] = (await loginWithMfa(app, phone, password)).accessToken;
    return user.id;
  };

  const as = (who: string) => ({
    get: (p: string) => request(app.getHttpServer()).get(p).set('Authorization', `Bearer ${tokens[who]}`),
    post: (p: string) => request(app.getHttpServer()).post(p).set('Authorization', `Bearer ${tokens[who]}`),
    del: (p: string) => request(app.getHttpServer()).delete(p).set('Authorization', `Bearer ${tokens[who]}`),
  });
  const run = <T>(fn: Parameters<TenantPrismaService['run']>[1], cid = companyId) => tenantPrisma.run(cid, fn) as Promise<T>;
  const newCustomer = () => run<{ id: string; code: string }>((tx) => tx.customer.create({ data: { companyId, code: `CL-${tag}-${++seq}`, name: `Cl ${seq}` } }));
  const audit = (entityId: string, action: string, cid = companyId) => run<Array<{ newValue: unknown; traceId: string | null }>>((tx) => tx.auditLog.findMany({ where: { entityId, action } }), cid);
  const ledger = (customerId: string) =>
    run(async (tx) => ({
      payments: await tx.payment.findMany({ where: { customerId }, orderBy: { id: 'asc' } }),
      allocations: await tx.paymentAllocation.findMany({ where: { payment: { customerId } }, orderBy: { id: 'asc' } }),
      reversals: await tx.paymentReversal.findMany({ where: { payment: { customerId } }, orderBy: { id: 'asc' } }),
      invoices: await tx.invoice.findMany({ where: { customerId }, orderBy: { id: 'asc' } }),
      customer: await tx.customer.findUniqueOrThrow({ where: { id: customerId }, select: { cachedBalance: true } }),
    }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.listen(0, '127.0.0.1');
    companyId = await seedCompany('CLIFE');
    companyB = await seedCompany('CLIFE-B');
    for (const r of ['OWNER', 'SALES_DIRECTOR', 'ACCOUNTANT']) await seedUser(companyId, r);
    await seedUser(companyB, 'OWNER');
  });

  afterAll(async () => {
    await app.close();
  });

  // Checklist 3
  it.each(['A:SALES_DIRECTOR', 'A:ACCOUNTANT'])('%s POST /customers/:id/restore => 403 + permission_denied audit, customer stays deleted', async (who) => {
    const c = await newCustomer();
    await as('A:OWNER').del(`/customers/${c.id}`).expect(200);
    const traceId = `trace-rs-${randomUUID()}`;
    await as(who).post(`/customers/${c.id}/restore`).set('x-request-id', traceId).expect(403);
    const rows = await run<Array<{ newValue: unknown }>>((tx) => tx.auditLog.findMany({ where: { action: 'auth.permission_denied', traceId } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.newValue).toMatchObject({ permission: 'customers.restore' });
    expect((await run<{ deletedAt: Date | null }>((tx) => tx.customer.findUniqueOrThrow({ where: { id: c.id } }))).deletedAt).not.toBeNull();
    expect(await audit(c.id, 'customer.restore')).toHaveLength(0);
  });

  it.each(['A:SALES_DIRECTOR', 'A:ACCOUNTANT'])('%s GET /customers?deleted=true => 403; OWNER => 200 listing the deleted customer', async (who) => {
    const c = await newCustomer();
    await as('A:OWNER').del(`/customers/${c.id}`).expect(200);
    await as(who).get('/customers?deleted=true').expect(403);
    const res = await as('A:OWNER').get('/customers?deleted=true&pageSize=100').expect(200);
    expect(JSON.stringify(res.body)).toContain(c.id);
  });

  it('OWNER delete -> restore => 200, both audited; finance rows byte-identical across delete+restore (checklist 2)', async () => {
    const c = await newCustomer();
    await run(async (tx) => {
      const inv = await tx.invoice.create({ data: { companyId, number: `INV-CL-${tag}-${++seq}`, customerId: c.id, total: '300.00', status: 'PAID' } });
      const pay = await tx.payment.create({ data: { companyId, number: `PAY-CL-${tag}-${++seq}`, customerId: c.id, amount: '300.00', method: 'CASH' } });
      await tx.paymentAllocation.create({ data: { paymentId: pay.id, invoiceId: inv.id, amount: '300.00' } });
    });
    const before = await ledger(c.id);
    await as('A:OWNER').del(`/customers/${c.id}`).expect(200);
    await as('A:OWNER').post(`/customers/${c.id}/restore`).expect(201);
    const res = await as('A:OWNER').get(`/customers/${c.id}`).expect(200);
    expect(res.body.deletedAt ?? null).toBeNull();
    expect(await ledger(c.id)).toEqual(before);
    expect(await audit(c.id, 'customer.delete')).toHaveLength(1);
    expect(await audit(c.id, 'customer.restore')).toHaveLength(1);
  });

  // Checklist 7/8/9/12 over HTTP: rejection audit survives the rolled-back request tx.
  it.each([
    ['CONFIRMED order', 'CONFIRMED'],
    ['SHIPPED order', 'SHIPPED'],
    ['DELIVERED order', 'DELIVERED'],
  ])('DELETE with %s => 409 CUSTOMER_HAS_OPEN_OBLIGATIONS, customer + ledger untouched, customer.delete_rejected persisted', async (_n, status) => {
    const c = await newCustomer();
    await run(async (tx) => {
      const wh = (await tx.warehouse.findFirst({ where: { companyId } })) ?? (await tx.warehouse.create({ data: { companyId, name: `WH ${tag}` } }));
      await tx.salesOrder.create({ data: { companyId, number: `SO-CL-${tag}-${++seq}`, customerId: c.id, warehouseId: wh.id, status: status as never } });
    });
    const before = await ledger(c.id);
    const res = await as('A:OWNER').del(`/customers/${c.id}`).expect(409);
    expect(res.body.code).toBe('CUSTOMER_HAS_OPEN_OBLIGATIONS');
    expect((await run<{ deletedAt: Date | null }>((tx) => tx.customer.findUniqueOrThrow({ where: { id: c.id } }))).deletedAt).toBeNull();
    expect(await ledger(c.id)).toEqual(before);
    const rows = await audit(c.id, 'customer.delete_rejected');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.newValue).toMatchObject({ reason: 'CUSTOMER_HAS_OPEN_OBLIGATIONS' });
    expect(await audit(c.id, 'customer.delete')).toHaveLength(0);
  });

  it('DELETE with PENDING_HANDOVER / debt => 409 + persisted rejection audit', async () => {
    const owner = await systemPrisma.user.findFirstOrThrow({ where: { companyId } });
    const h = await newCustomer();
    await run((tx) => tx.payment.create({ data: { companyId, number: `PAY-CL-${tag}-${++seq}`, customerId: h.id, amount: '5.00', method: 'CASH', status: 'PENDING_HANDOVER', collectedBy: owner.id } }));
    expect((await as('A:OWNER').del(`/customers/${h.id}`).expect(409)).body.code).toBe('CUSTOMER_HAS_PENDING_HANDOVER');
    expect(await audit(h.id, 'customer.delete_rejected')).toHaveLength(1);

    const d = await newCustomer();
    await run((tx) => tx.invoice.create({ data: { companyId, number: `INV-CL-${tag}-${++seq}`, customerId: d.id, total: '7.00', status: 'OPEN' } }));
    expect((await as('A:OWNER').del(`/customers/${d.id}`).expect(409)).body.code).toBe('CUSTOMER_HAS_OUTSTANDING_BALANCE');
    expect(await audit(d.id, 'customer.delete_rejected')).toHaveLength(1);
  });

  // Checklist 4
  it('restore with a live same-code customer => 409 CUSTOMER_CODE_CONFLICT_ON_RESTORE, audited, still deleted', async () => {
    const c = await newCustomer();
    await as('A:OWNER').del(`/customers/${c.id}`).expect(200);
    await run((tx) => tx.customer.create({ data: { companyId, code: c.code, name: 'reuser' } }));
    const res = await as('A:OWNER').post(`/customers/${c.id}/restore`).expect(409);
    expect(res.body.code).toBe('CUSTOMER_CODE_CONFLICT_ON_RESTORE');
    expect((await audit(c.id, 'customer.restore_rejected'))[0]!.newValue).toMatchObject({ reason: 'CUSTOMER_CODE_CONFLICT_ON_RESTORE' });
    expect((await run<{ deletedAt: Date | null }>((tx) => tx.customer.findUniqueOrThrow({ where: { id: c.id } }))).deletedAt).not.toBeNull();
  });

  // Checklist 1/2/12: allocate on a legacy-deleted customer is rejected, nothing posted, audited.
  it('POST /payments/:id/allocate for a deleted customer => rejected, ledger byte-identical, allocate_rejected audited', async () => {
    const c = await newCustomer();
    const { inv, pay } = await run<{ inv: { id: string }; pay: { id: string } }>(async (tx) => ({
      inv: await tx.invoice.create({ data: { companyId, number: `INV-CL-${tag}-${++seq}`, customerId: c.id, total: '100.00', status: 'OPEN' } }),
      pay: await tx.payment.create({ data: { companyId, number: `PAY-CL-${tag}-${++seq}`, customerId: c.id, amount: '100.00', method: 'CASH' } }),
    }));
    await run((tx) => tx.customer.update({ where: { id: c.id }, data: { deletedAt: new Date(), isActive: false } }));
    const before = await ledger(c.id);
    const res = await as('A:OWNER').post(`/payments/${pay.id}/allocate`).send({ allocations: [{ invoiceId: inv.id, amount: '50.00' }] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.code).toBe('CUSTOMER_DELETED');
    expect(await ledger(c.id)).toEqual(before);
    expect(await audit(pay.id, 'payment.allocate_rejected')).toHaveLength(1);
    expect(await audit(pay.id, 'payment.allocate')).toHaveLength(0);
    // after a rejected op AND an OWNER restore the original rows are still identical
    await as('A:OWNER').post(`/customers/${c.id}/restore`);
    expect(await ledger(c.id)).toEqual(before);
  });

  // Checklist 11
  it('tenant B OWNER: delete / restore / allocate against tenant A ids => 404, no effect on A', async () => {
    const c = await newCustomer();
    const { inv, pay } = await run<{ inv: { id: string }; pay: { id: string } }>(async (tx) => ({
      inv: await tx.invoice.create({ data: { companyId, number: `INV-CL-${tag}-${++seq}`, customerId: c.id, total: '100.00', status: 'OPEN' } }),
      pay: await tx.payment.create({ data: { companyId, number: `PAY-CL-${tag}-${++seq}`, customerId: c.id, amount: '100.00', method: 'CASH' } }),
    }));
    const before = await ledger(c.id);
    await as('B:OWNER').del(`/customers/${c.id}`).expect(404);
    await as('B:OWNER').post(`/customers/${c.id}/restore`).expect(404);
    await as('B:OWNER').post(`/payments/${pay.id}/allocate`).send({ allocations: [{ invoiceId: inv.id, amount: '10.00' }] }).expect(404);
    expect(await ledger(c.id)).toEqual(before);
    expect((await run<{ deletedAt: Date | null }>((tx) => tx.customer.findUniqueOrThrow({ where: { id: c.id } }))).deletedAt).toBeNull();
    expect(await audit(c.id, 'customer.delete_rejected')).toHaveLength(0);
    expect(await audit(c.id, 'customer.delete_rejected', companyB)).toHaveLength(1);
  });
});
