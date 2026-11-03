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

/** ADR-045 + ADR-061b: company export is OWNER-only (company.export); SALES_AGENT/WAREHOUSE reach neither it nor the stock movements journal. */
describe('E2E: company export RBAC + stock_movements unreachable for non-privileged roles', () => {
  let app: INestApplication;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tokens: Record<string, string> = {};
  let companyId: string;
  let ownerJobId: string;
  const NOTE = `MV-SECRET-${randomUUID().slice(0, 8)}`;
  const http = () => request(app.getHttpServer());
  const as = (r: string) => ({ Authorization: `Bearer ${tokens[r]!}` });
  const denied = () => tenantPrisma.run(companyId, (tx) => tx.auditLog.count({ where: { action: 'auth.permission_denied' } }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.listen(0, '127.0.0.1');

    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-cexrbac-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: 'CexRbac' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'CexRbac Co' } })).id;
    await tenantPrisma.run(companyId, async (tx) => {
      const p = await tx.product.create({ data: { companyId, sku: `CX-${Date.now()}`, name: 'Cx', baseUnit: 'dona' } });
      const w = await tx.warehouse.create({ data: { companyId, name: 'WH Cx' } });
      await tx.stockMovement.create({ data: { companyId, productId: p.id, warehouseId: w.id, type: 'RECEIVE', qty: '5', note: NOTE } });
    });

    for (const roleCode of ['OWNER', 'SALES_AGENT', 'WAREHOUSE']) {
      const permissionIds: string[] = [];
      for (const key of permissionKeysForRole(roleCode)) {
        const { module, code } = parsePermissionKey(key);
        permissionIds.push((await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } })).id);
      }
      const phone = uniquePhone();
      const user = await systemPrisma.user.create({ data: { companyId, firstName: roleCode, lastName: 'Cex', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) } });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        const role = await tx.role.create({ data: { companyId, code: roleCode, name: roleCode, isSystem: true } });
        for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
        await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
      });
      tokens[roleCode] = (await loginWithMfa(app, phone, password)).accessToken;
    }
    // an existing owner export (QUEUED row is enough: a denied caller must not even learn whether it exists)
    ownerJobId = (await tenantPrisma.run(companyId, (tx) => tx.exportJob.create({ data: { companyId, type: 'company', format: 'EXCEL', periodFrom: new Date(), periodTo: new Date(), status: 'QUEUED' } }))).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(['SALES_AGENT', 'WAREHOUSE'])('%s: company-export create/list/status/download => 403 + audit permission_denied(company.export); no job created', async (role) => {
    const before = await denied();
    const traceId = `trace-cex-${randomUUID()}`;
    const res = await http().post('/company-export').set(as(role)).set('x-request-id', traceId).set('Idempotency-Key', randomUUID()).expect(403);
    expect(JSON.stringify(res.body)).not.toContain(NOTE);
    await http().get('/company-export').set(as(role)).expect(403);
    await http().get(`/company-export/${ownerJobId}`).set(as(role)).expect(403);
    const dl = await http().get(`/company-export/${ownerJobId}/download`).set(as(role)).expect(403);
    expect(dl.headers['content-type'] ?? '').not.toMatch(/spreadsheet|octet-stream/);
    expect(await denied()).toBe(before + 4);
    const rows = await tenantPrisma.run(companyId, (tx) => tx.auditLog.findMany({ where: { action: 'auth.permission_denied', traceId } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.newValue).toMatchObject({ permission: 'company.export' });
    expect(await tenantPrisma.run(companyId, (tx) => tx.exportJob.count({ where: { type: 'company' } }))).toBe(1);
  });

  it('SALES_AGENT cannot read stock movement rows via /stock/movements (403) nor in /sync/pull; WAREHOUSE can read the journal but still not the export', async () => {
    const res = await http().get('/stock/movements').set(as('SALES_AGENT')).expect(403);
    expect(JSON.stringify(res.body)).not.toContain(NOTE);
    const pull = await http().get('/sync/pull').set(as('SALES_AGENT')).expect(200);
    expect(JSON.stringify(pull.body)).not.toContain(NOTE);
    await http().get('/stock/movements').set(as('WAREHOUSE')).expect(200);
    await http().get(`/company-export/${ownerJobId}/download`).set(as('WAREHOUSE')).expect(403);
  });
});
