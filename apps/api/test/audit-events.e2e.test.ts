import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { prisma, systemPrisma } from '@velto/database';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { StorageService } from '../src/common/storage/storage.service';
import { uniquePhone } from './unique-phone';

/**
 * TZ 11.4: payment, allocation, stock adjustment, order confirm/cancel, role
 * change and export/import are separate audit events carrying actor, company,
 * entity id and trace id; secrets never land in the audit trail.
 * Real HTTP through the full Nest pipeline, real Postgres + RLS (app role).
 * Events that 11.4 mandates but the code does not write are expressed with
 * `it.fails` so the suite documents the gap and flips red once it is fixed.
 */
describe('E2E: mandatory audit events (TZ 11.4)', () => {
  let app: INestApplication;
  let companyId: string;
  let userId: string;
  let token: string;
  let customerId: string;
  let productId: string;
  let packagingId: string;
  let warehouseId: string;
  let targetUserId: string;
  const rnd = () => uniquePhone();
  const phone = rnd();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

  async function inTenant<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      return fn(tx);
    });
  }
  const auditRows = (action: string, entityId?: string) =>
    inTenant((tx) => tx.auditLog.findMany({ where: { action, ...(entityId ? { entityId } : {}) } }));

  /** actor + company + entity + trace id (must equal the response's X-Request-Id). */
  async function expectFullAudit(action: string, entityId: string, traceId: string) {
    const rows = await auditRows(action, entityId);
    expect(rows.length).toBe(1);
    expect(rows[0].userId).toBe(userId);
    expect(rows[0].companyId).toBe(companyId);
    expect(rows[0].entityId).toBe(entityId);
    expect(rows[0].traceId).toBe(traceId);
    return rows[0];
  }
  const trace = (res: request.Response) => res.headers['x-request-id'] as string;

  async function deliveredInvoiceFor(qty: number): Promise<string> {
    const o = await auth(http().post('/orders')).send({ customerId, lines: [{ productId, packagingId, qty }] }).expect(201);
    await auth(http().post(`/orders/${o.body.id}/confirm`)).expect(201);
    await auth(http().post(`/orders/${o.body.id}/deliver`)).expect(201);
    return o.body.id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StorageService)
      .useValue({ upload: async (i: { keyPrefix: string; extension: string }) => `memory://${i.keyPrefix}/audit.${i.extension}` })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    // Loopback-only listen: supertest's default `::` bind can collide with a foreign 127.0.0.1 listener (e.g. VS Code helper) => random 4xx.
    await app.listen(0, '127.0.0.1');

    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-audit-${Date.now()}`, name: 'Audit Tenant' } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Audit Co' } });
    companyId = company.id;

    const codes = [
      ['orders', 'create'], ['orders', 'read'], ['orders', 'update'], ['orders', 'deliver'], ['orders', 'cancel'],
      ['payments', 'create'], ['payments', 'read'], ['stock', 'adjust'], ['stock', 'read'],
      ['users', 'update'], ['users', 'read'], ['settings', 'update'], ['integrations', 'export1c'],
    ];
    const permissions = await Promise.all(
      codes.map(([module, code]) =>
        systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } }),
      ),
    );
    const dbUser = await systemPrisma.user.create({
      data: { companyId, firstName: 'Aud', lastName: 'Op', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    userId = dbUser.id;
    const target = await systemPrisma.user.create({
      data: { companyId, firstName: 'Tgt', lastName: 'U', phone: rnd(), passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    targetUserId = target.id;

    await prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      const role = await tx.role.create({ data: { companyId, code: 'AUD_OP', name: 'Aud Op' } });
      await tx.rolePermission.createMany({ data: permissions.map((p: any) => ({ roleId: role.id, permissionId: p.id })) });
      await tx.userRole.create({ data: { userId: dbUser.id, roleId: role.id } });
      await tx.role.create({ data: { companyId, code: 'AUD_TARGET', name: 'Aud Target', isSystem: true } });
      const wh = await tx.warehouse.create({ data: { companyId, name: 'Aud WH' } });
      warehouseId = wh.id;
      const product = await tx.product.create({ data: { companyId, sku: 'AUD-1', name: 'Aud P', baseUnit: 'dona', vatRate: '12' } });
      productId = product.id;
      const pk = await tx.productPackaging.create({ data: { productId, name: 'dona', qtyInBaseUnit: '1', isDefault: true } });
      packagingId = pk.id;
      const pl = await tx.priceList.create({ data: { companyId, name: 'PL', isDefault: true } });
      await tx.priceListItem.create({ data: { priceListId: pl.id, productId, price: '10000.00' } });
      await tx.stockLevel.create({ data: { productId, warehouseId, onHand: '1000', reserved: '0' } });
      const c = await tx.customer.create({ data: { companyId, code: 'AUD-C', name: 'Aud C' } });
      customerId = c.id;
    });

    const login = await http().post('/auth/login').send({ phone, password }).expect(201);
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('11.4: order.confirm audited with actor, company, entityId, traceId', async () => {
    const o = await auth(http().post('/orders')).send({ customerId, lines: [{ productId, packagingId, qty: 2 }] }).expect(201);
    const res = await auth(http().post(`/orders/${o.body.id}/confirm`)).expect(201);
    await expectFullAudit('order.confirm', o.body.id, trace(res));
  });

  it('11.4: order.cancel audited with actor, company, entityId, traceId', async () => {
    const o = await auth(http().post('/orders')).send({ customerId, lines: [{ productId, packagingId, qty: 1 }] }).expect(201);
    await auth(http().post(`/orders/${o.body.id}/confirm`)).expect(201);
    const res = await auth(http().post(`/orders/${o.body.id}/cancel`)).send({ reason: 'test' }).expect(201);
    await expectFullAudit('order.cancel', o.body.id, trace(res));
  });

  it('11.4: stock.adjust audited with actor, company, movement id, traceId', async () => {
    const res = await auth(http().post('/stock/adjust'))
      .send({ productId, warehouseId, qty: -3, reason: 'count' })
      .expect(201);
    const mv = await inTenant((tx) => tx.stockMovement.findFirst({ where: { type: 'ADJUST', productId } }));
    await expectFullAudit('stock.adjust', mv.id, trace(res));
  });

  it('11.4: payment.create audited with actor, company, entityId, traceId', async () => {
    await deliveredInvoiceFor(1);
    const res = await auth(http().post('/payments')).send({ customerId, amount: 5000, method: 'CASH' }).expect(201);
    await expectFullAudit('payment.create', res.body.id, trace(res));
  });

  it('11.4: allocation is a SEPARATE audit event (payment.allocate)', async () => {
    await deliveredInvoiceFor(1);
    const res = await auth(http().post('/payments')).send({ customerId, amount: 1000, method: 'CASH' }).expect(201);
    const row = await expectFullAudit('payment.allocate', res.body.id, trace(res));
    const value = row.newValue as { mode: string; allocations: { invoiceId: string; amount: string }[] };
    expect(value.mode).toBe('FIFO');
    expect(value.allocations.length).toBeGreaterThan(0);
    expect(value.allocations.map((a) => a.invoiceId).sort()).toEqual(res.body.allocations.map((a: { invoiceId: string }) => a.invoiceId).sort());
  });

  it('11.4: role change (user.update with roleCodes) audited with actor, company, entityId, traceId, new role present', async () => {
    const res = await auth(http().patch(`/users/${targetUserId}`)).send({ roleCodes: ['AUD_TARGET'] });
    expect(res.status).toBe(200);
    const row = await expectFullAudit('user.update', targetUserId, trace(res));
    expect(JSON.stringify(row.newValue)).toContain('AUD_TARGET');
  });

  it('11.4: login/refresh audit rows carry actor, company, traceId and no secrets', async () => {
    const login = await http().post('/auth/login').send({ phone, password }).expect(201);
    const rows = await inTenant((tx) =>
      tx.auditLog.findMany({ where: { action: 'auth.login', traceId: trace(login) } }),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].userId).toBe(userId);
    expect(rows[0].companyId).toBe(companyId);
    const dump = JSON.stringify(await inTenant((tx) => tx.auditLog.findMany()));
    expect(dump).not.toContain(login.body.accessToken);
    expect(dump).not.toContain(login.body.refreshToken);
    expect(dump).not.toContain(password);
  });

  it('11.4: secret fields written through a real tx are masked to *** in AuditLog', async () => {
    const { AuditLogService } = await import('../src/common/audit/audit-log.service');
    await inTenant((tx) =>
      new AuditLogService().log(tx, {
        companyId,
        userId,
        action: 'test.secret',
        entity: 'User',
        entityId: userId,
        newValue: { password: 'p1', refreshToken: 't1', nested: { otp: '123456', botToken: 'b', keep: 'ok' } },
      }),
    );
    const [row] = await auditRows('test.secret', userId);
    expect(row.newValue).toEqual({ password: '***', refreshToken: '***', nested: { otp: '***', botToken: '***', keep: 'ok' } });
  });

  it('11.4: export (1C) is a separate audit event with actor [GAP: Export1cService writes no AuditLog]', async () => {
    const res = await auth(http().post('/export/1c')).send({ from: '2026-01-01', to: '2026-09-30', format: 'EXCEL' });
    expect(res.status).toBe(201);
    const rows = await inTenant((tx) => tx.auditLog.findMany({ where: { action: { contains: 'export' } } }));
    expect(rows.length).toBe(1);
    expect(rows[0].userId).toBe(userId);
  });

  // Storage is replaced by an in-memory fake (no MinIO needed); production keeps the S3 adapter.
  it('11.4: import commit audit carries actor userId', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('customers');
    ws.addRow(['code', 'name', 'phone', 'contactPerson', 'paymentTermDays', 'outletName', 'outletAddress', 'outletLatitude', 'outletLongitude']);
    ws.addRow(['AUD-IMP-1', 'Imp Customer', '+998901112233', 'X Y', 7, 'Outlet', 'Addr', 41.3, 69.2]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const up = await auth(http().post('/import/customers')).attach('file', buf, { filename: 'c.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    await auth(http().post(`/import/${up.body.id}/confirm`)).expect(201);
    let rows: any[] = [];
    for (let i = 0; i < 25 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 200));
      rows = await auditRows('customer.import', up.body.id);
    }
    expect(rows.length).toBe(1);
    expect(rows[0].userId).toBe(userId);
  });
});
