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

/** TZ §11.4: every report export route writes exactly one `report.export` audit event; denied roles get 403 and none. */
describe('E2E: report export audit', () => {
  let app: INestApplication;
  let companyId: string;
  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tenantPrisma = new TenantPrismaService();

  async function createUser(roleCode: string) {
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: { companyId, firstName: roleCode, lastName: 'T', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    const permissionIds: string[] = [];
    for (const key of permissionKeysForRole(roleCode)) {
      const [module, code] = key.split('.');
      const p = await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } });
      permissionIds.push(p.id);
    }
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      const role = await tx.role.create({ data: { companyId, code: roleCode, name: roleCode, isSystem: true } });
      for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    });
    const res = { body: await loginWithMfa(app, phone, password) };
    tokens[roleCode] = res.body.accessToken;
    userIds[roleCode] = user.id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    // Loopback-only listen: supertest's default `::` bind can collide with a foreign 127.0.0.1 listener (e.g. VS Code helper) => random 4xx.
    await app.listen(0, '127.0.0.1');
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-rexp-${Date.now()}`, name: 'REXP' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'REXP Co' } })).id;
    for (const role of ['ACCOUNTANT', 'SALES_AGENT', 'CASHIER']) await createUser(role);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Returns '' when the response is the expected 403, else a JSON dump of everything needed to root-cause it. */
  async function diagnose(role: string, path: string, traceId: string, res: request.Response): Promise<string> {
    if (res.status === 403) return '';
    const user = await systemPrisma.user.findUnique({ where: { id: userIds[role] }, select: { isActive: true, companyId: true } });
    const audits = await tenantPrisma.run(companyId, (tx) => tx.auditLog.findMany({ where: { traceId }, select: { action: true, userId: true } }));
    return JSON.stringify({ role, path, status: res.status, body: res.body, headers: { 'x-request-id': res.headers['x-request-id'] }, traceId, user, audits, pid: process.pid });
  }

  const exportEvents = (traceId: string) =>
    tenantPrisma.run(companyId, (tx) => tx.auditLog.findMany({ where: { action: 'report.export', traceId } }));

  const routes: [string, string, string, string, Record<string, string>][] = [
    ['/reports/sales/export?from=2026-01-01&to=2026-01-31', 'sales', 'xlsx', 'sales', { from: '2026-01-01', to: '2026-01-31' }],
    ['/reports/sales/export.csv?from=2026-01-01&to=2026-01-31', 'sales', 'csv', 'sales', { from: '2026-01-01', to: '2026-01-31' }],
    ['/reports/agents/export?from=2026-01-01&to=2026-01-31', 'agents', 'xlsx', 'agents', { from: '2026-01-01', to: '2026-01-31' }],
    ['/reports/agents/export.csv?from=2026-01-01&to=2026-01-31', 'agents', 'csv', 'agents', { from: '2026-01-01', to: '2026-01-31' }],
    ['/reports/overview/export?from=2026-01-01&to=2026-01-31', 'overview', 'xlsx', 'overview', { from: '2026-01-01', to: '2026-01-31' }],
    ['/reports/overview/export.csv?from=2026-01-01&to=2026-01-31', 'overview', 'csv', 'overview', { from: '2026-01-01', to: '2026-01-31' }],
    ['/reports/aging/export?asOf=2026-01-31', 'aging', 'xlsx', 'aging', { asOf: '2026-01-31' }],
    ['/reports/aging/export.csv?asOf=2026-01-31', 'aging', 'csv', 'aging', { asOf: '2026-01-31' }],
  ];

  it.each(routes)('%s as ACCOUNTANT => 200 + exactly one report.export event', async (path, report, format, _k, filters) => {
    const traceId = `trace-rexp-${randomUUID()}`;
    await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${tokens.ACCOUNTANT}`).set('x-request-id', traceId).expect(200);
    const rows = await exportEvents(traceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(userIds.ACCOUNTANT);
    expect(rows[0].newValue).toMatchObject({ report, format, filters });
    expect(typeof (rows[0].newValue as { rowCount: number }).rowCount).toBe('number');
  });

  it.each(['SALES_AGENT', 'CASHIER'])('%s => 403 and no report.export event', async (role) => {
    for (const [path] of routes) {
      const traceId = `trace-rexp-${randomUUID()}`;
      const res = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${tokens[role]}`).set('x-request-id', traceId);
      // Diagnostic: a rare non-403 (seen 401 in full-suite runs) must carry full context, not just "expected 403, got 401".
      const denied = await diagnose(role, path, traceId, res);
      expect(denied, denied).toBe('');
      expect(await exportEvents(traceId)).toHaveLength(0);
    }
  });

  it('a failed export (invalid query => 400) leaves no event', async () => {
    const traceId = `trace-rexp-${randomUUID()}`;
    await request(app.getHttpServer()).get('/reports/sales/export?from=not-a-date').set('Authorization', `Bearer ${tokens.ACCOUNTANT}`).set('x-request-id', traceId).expect(400);
    expect(await exportEvents(traceId)).toHaveLength(0);
  });
});
