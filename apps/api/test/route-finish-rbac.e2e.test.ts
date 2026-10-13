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
import { companyDay } from '../src/modules/field/company-day';

/** F3 / SEC-023: POST /routes/:id/finish needs `routes.finish`; an agent only on their own route; courier routes never. */
describe('E2E F3: route finish RBAC + open stops', () => {
  let app: INestApplication;
  let companyId: string;
  let outletId: string;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tokens: Record<string, { token: string; userId: string }> = {};
  const weekday = companyDay(new Date(), 'Asia/Tashkent').isoWeekday;
  const auth = (k: string) => ({ Authorization: `Bearer ${tokens[k]!.token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.init();

    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-rfin-${Date.now()}`, name: 'RFIN' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'RFIN Co' } })).id;

    const roleIds: Record<string, string> = {};
    for (const roleCode of ['SALES_AGENT', 'ACCOUNTANT', 'COURIER']) {
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
        roleIds[roleCode] = role.id;
      });
    }
    for (const [key, roleCode] of [['AGENT1', 'SALES_AGENT'], ['AGENT2', 'SALES_AGENT'], ['ACCOUNTANT', 'ACCOUNTANT'], ['COURIER', 'COURIER']] as const) {
      const phone = `+99890${Math.floor(1_000_000 + Math.random() * 8_000_000)}`;
      const user = await systemPrisma.user.create({
        data: { companyId, firstName: key, lastName: 'Rfin', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        await tx.userRole.create({ data: { userId: user.id, roleId: roleIds[roleCode]! } });
      });
      const res = await request(app.getHttpServer()).post('/auth/login').send({ phone, password }).expect(201);
      tokens[key] = { token: res.body.accessToken, userId: user.id };
    }
    outletId = await tenantPrisma.run(companyId, async (tx) => {
      const c = await tx.customer.create({ data: { companyId, code: `RFIN-${Date.now()}`, name: 'C' } });
      return (await tx.outlet.create({ data: { companyId, customerId: c.id, name: 'Stop A' } })).id;
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const mkRoute = (agentId?: string, courierId?: string) =>
    tenantPrisma.run(companyId, (tx) =>
      tx.route.create({ data: { companyId, agentId, courierId, weekday, name: `R-${randomUUID()}`, stops: { create: [{ outletId, sortOrder: 1 }] } } }),
    );

  it('agent: open stop => 409 with list; skip with reason; finish own route => 201 (not 403)', async () => {
    const route = await mkRoute(tokens.AGENT1!.userId);
    const open = await request(app.getHttpServer()).post(`/routes/${route.id}/finish`).set(auth('AGENT1')).expect(409);
    expect(open.body.code).toBe('ROUTE_NOT_READY');
    expect(open.body.details.openStops).toEqual([{ outletId, outletName: 'Stop A', reason: 'NO_VISIT' }]);

    await request(app.getHttpServer()).post(`/routes/${route.id}/skip-stop`).set(auth('AGENT1')).send({ outletId }).expect(400);
    await request(app.getHttpServer()).post(`/routes/${route.id}/skip-stop`).set(auth('AGENT1')).send({ outletId, reason: 'closed' }).expect(201);

    const done = await request(app.getHttpServer()).post(`/routes/${route.id}/finish`).set(auth('AGENT1')).expect(201);
    expect(done.body.completedAt).toBeTruthy();
    expect(done.body.outletNoCoordsCount).toBe(0);
  });

  it("another agent => 403 ROUTE_NOT_OWNED on finish and skip-stop", async () => {
    const route = await mkRoute(tokens.AGENT1!.userId);
    const f = await request(app.getHttpServer()).post(`/routes/${route.id}/finish`).set(auth('AGENT2')).expect(403);
    expect(f.body.code).toBe('ROUTE_NOT_OWNED');
    await request(app.getHttpServer()).post(`/routes/${route.id}/skip-stop`).set(auth('AGENT2')).send({ outletId, reason: 'x' }).expect(403);
  });

  it('courier is forbidden (no routes.finish) and cannot see routes', async () => {
    const route = await mkRoute(tokens.AGENT1!.userId);
    await request(app.getHttpServer()).post(`/routes/${route.id}/finish`).set(auth('COURIER')).expect(403);
    await request(app.getHttpServer()).get(`/routes/${route.id}`).set(auth('COURIER')).expect(403);
    await request(app.getHttpServer()).get('/routes').set(auth('COURIER')).expect(403);
  });

  it('ACCOUNTANT has no route access', async () => {
    const route = await mkRoute(tokens.AGENT1!.userId);
    await request(app.getHttpServer()).post(`/routes/${route.id}/finish`).set(auth('ACCOUNTANT')).expect(403);
    await request(app.getHttpServer()).post(`/routes/${route.id}/skip-stop`).set(auth('ACCOUNTANT')).send({ outletId, reason: 'x' }).expect(403);
  });

  it('agent finishing a courier route => 403 ROUTE_COURIER_FINISH_FORBIDDEN', async () => {
    const route = await mkRoute(undefined, tokens.COURIER!.userId);
    const res = await request(app.getHttpServer()).post(`/routes/${route.id}/finish`).set(auth('AGENT1')).expect(403);
    expect(res.body.code).toBe('ROUTE_COURIER_FINISH_FORBIDDEN');
  });
});
