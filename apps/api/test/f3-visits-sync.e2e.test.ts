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

/** F3: offline visit push (§8/10.3), tenant isolation (SEC-001..005, SEC-023), server-only GPS status, GPS settings. */
describe('E2E F3: visits via /sync/push + /visits, isolation, GPS settings', () => {
  let app: INestApplication;
  let companyId: string;
  let otherCompanyId: string;
  let outletId: string;
  let foreignOutletId: string;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const tokens: Record<string, { token: string; userId: string }> = {};
  const auth = (k: string) => ({ Authorization: `Bearer ${tokens[k]!.token}` });
  const http = () => request(app.getHttpServer());
  // Outlet is at (41.3, 69.2); 0.01 deg latitude ~ 1.1 km away.
  const FAR = { latitude: 41.31, longitude: 69.2, accuracyM: 10 };
  const visitBody = (extra: Record<string, unknown> = {}) => ({ outletId, startedAt: new Date().toISOString(), outcome: 'NO_ORDER', noOrderReason: 'x', ...extra });

  async function seedCompany(label: string, roles: string[]) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-f3v-${label}-${Date.now()}`, name: `F3V ${label}` } });
    const cid = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: `F3V ${label}` } })).id;
    const roleIds: Record<string, string> = {};
    for (const roleCode of roles) {
      const permissionIds: string[] = [];
      for (const key of permissionKeysForRole(roleCode)) {
        const [module, code] = key.split('.');
        const p = await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } });
        permissionIds.push(p.id);
      }
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${cid}, true)`;
        const role = await tx.role.create({ data: { companyId: cid, code: roleCode, name: roleCode, isSystem: true } });
        for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
        roleIds[roleCode] = role.id;
      });
    }
    const outlet = await tenantPrisma.run(cid, async (tx) => {
      const c = await tx.customer.create({ data: { companyId: cid, code: `F3V-${label}-${Date.now()}`, name: 'C' } });
      return tx.outlet.create({ data: { companyId: cid, customerId: c.id, name: `O-${label}`, latitude: 41.3, longitude: 69.2 } });
    });
    return { cid, roleIds, outletId: outlet.id };
  }
  async function mkUser(key: string, cid: string, roleId: string) {
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: { companyId: cid, firstName: key, lastName: 'F3v', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${cid}, true)`;
      await tx.userRole.create({ data: { userId: user.id, roleId } });
    });
    const res = { body: await loginWithMfa(app, phone, password) };
    tokens[key] = { token: res.body.accessToken, userId: user.id };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    // Loopback-only listen: supertest's default `::` bind can collide with a foreign 127.0.0.1 listener (e.g. VS Code helper) => random 4xx.
    await app.listen(0, '127.0.0.1');

    const a = await seedCompany('A', ['SALES_AGENT', 'ACCOUNTANT', 'OWNER']);
    companyId = a.cid;
    outletId = a.outletId;
    await mkUser('AGENT1', companyId, a.roleIds.SALES_AGENT!);
    await mkUser('AGENT2', companyId, a.roleIds.SALES_AGENT!);
    await mkUser('ACCOUNTANT', companyId, a.roleIds.ACCOUNTANT!);
    await mkUser('OWNER', companyId, a.roleIds.OWNER!);
    const b = await seedCompany('B', ['SALES_AGENT']);
    otherCompanyId = b.cid;
    foreignOutletId = b.outletId;
  });

  afterAll(async () => {
    await app.close();
  });

  const push = (k: string, documents: unknown[]) => http().post('/sync/push').set(auth(k)).send({ documents });

  it('offline visit with OUTSIDE_RADIUS is ACCEPTED (not rejected); same clientId again => DUPLICATE, one row (10.4)', async () => {
    const clientId = randomUUID();
    const doc = { type: 'visit', clientId, payload: visitBody({ ...FAR }) };
    const first = await push('AGENT1', [doc]).expect(201);
    expect(first.body.results[0]).toMatchObject({ clientId, status: 'ACCEPTED' });
    const visitId = first.body.results[0].id;
    const stored = await http().get(`/visits/${visitId}`).set(auth('AGENT1')).expect(200);
    expect(stored.body.gpsStatus).toBe('OUTSIDE_RADIUS');

    const again = await push('AGENT1', [doc]).expect(201);
    expect(again.body.results[0]).toMatchObject({ clientId, status: 'DUPLICATE', id: visitId });
    const n = await tenantPrisma.run(companyId, (tx) => tx.visit.count({ where: { clientId } }));
    expect(n).toBe(1);
  });

  it('parallel triple resend of one clientId => exactly one visit (16.2 mutations idempotent under parallel calls)', async () => {
    const clientId = randomUUID();
    const doc = { type: 'visit', clientId, payload: visitBody({ ...FAR }) };
    const res = await Promise.all([1, 2, 3].map(() => push('AGENT1', [doc])));
    const statuses = res.map((r) => r.body.results?.[0]?.status);
    expect(statuses.filter((s) => s === 'ACCEPTED').length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 'ACCEPTED' || s === 'DUPLICATE')).toBe(true);
    expect(await tenantPrisma.run(companyId, (tx) => tx.visit.count({ where: { clientId } }))).toBe(1);
  });

  it('SEC-023: an agent cannot create a visit for another agent (agentId in body is ignored; owner is the caller)', async () => {
    const res = await http().post('/visits').set(auth('AGENT1')).send(visitBody({ agentId: tokens.AGENT2!.userId })).expect(201);
    expect(res.body.agentId).toBe(tokens.AGENT1!.userId);
    const viaSync = await push('AGENT1', [{ type: 'visit', clientId: randomUUID(), payload: visitBody({ agentId: tokens.AGENT2!.userId }) }]).expect(201);
    const v = await http().get(`/visits/${viaSync.body.results[0].id}`).set(auth('AGENT1')).expect(200);
    expect(v.body.agentId).toBe(tokens.AGENT1!.userId);
    // and agent 2 cannot read agent 1's visit
    await http().get(`/visits/${res.body.id}`).set(auth('AGENT2')).expect(404);
  });

  it('SEC-001..005: a visit on another tenant\'s outlet is refused (404 / REJECTED) and nothing is written in either tenant', async () => {
    await http().post('/visits').set(auth('AGENT1')).send(visitBody({ outletId: foreignOutletId })).expect(404);
    const clientId = randomUUID();
    const res = await push('AGENT1', [{ type: 'visit', clientId, payload: visitBody({ outletId: foreignOutletId }) }]).expect(201);
    expect(res.body.results[0]).toMatchObject({ clientId, status: 'REJECTED', error: { code: 'OUTLET_NOT_FOUND' } });
    expect(await tenantPrisma.run(companyId, (tx) => tx.visit.count({ where: { clientId } }))).toBe(0);
    expect(await tenantPrisma.run(otherCompanyId, (tx) => tx.visit.count({ where: { outletId: foreignOutletId } }))).toBe(0);
  });

  it('GPS verdict is server-only: client-sent gpsOk / gpsStatus is rejected (400) on /visits and REJECTED via /sync/push', async () => {
    for (const forged of [{ gpsOk: true }, { gpsStatus: 'VERIFIED' }, { gpsOk: true, gpsStatus: 'VERIFIED', ...FAR }]) {
      await http().post('/visits').set(auth('AGENT1')).send(visitBody(forged)).expect(400);
      const clientId = randomUUID();
      const res = await push('AGENT1', [{ type: 'visit', clientId, payload: visitBody(forged) }]).expect(201);
      expect(res.body.results[0].status).toBe('REJECTED');
      expect(await tenantPrisma.run(companyId, (tx) => tx.visit.count({ where: { clientId } }))).toBe(0);
    }
  });

  it('GPS settings: radius change is audited (old/new) and applies to the very next visit; ACCOUNTANT cannot change', async () => {
    // before: radius default 150 => FAR (~1.1 km) is OUTSIDE_RADIUS
    const before = await http().post('/visits').set(auth('AGENT1')).send(visitBody({ ...FAR })).expect(201);
    expect(before.body.gpsStatus).toBe('OUTSIDE_RADIUS');

    await http().patch('/settings').set(auth('ACCOUNTANT')).send({ visitGpsRadiusM: 5000 }).expect(403);
    const cur = await tenantPrisma.run(companyId, (tx) => tx.company.findFirstOrThrow({ select: { visitGpsRadiusM: true } }));
    expect(cur.visitGpsRadiusM).toBe(150);

    await http().patch('/settings').set(auth('OWNER')).send({ visitGpsRadiusM: 5000 }).expect(200);
    const audits = await tenantPrisma.run(companyId, (tx) => tx.auditLog.findMany({ where: { action: 'company.gps_settings_update' } }));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBe(tokens.OWNER!.userId);
    expect(audits[0]!.oldValue).toMatchObject({ visitGpsRadiusM: 150 });
    expect(audits[0]!.newValue).toMatchObject({ visitGpsRadiusM: 5000 });

    const after = await http().post('/visits').set(auth('AGENT1')).send(visitBody({ ...FAR })).expect(201);
    expect(after.body.gpsStatus).toBe('VERIFIED');
    // out-of-range value refused (mirrors DB CHECK)
    await http().patch('/settings').set(auth('OWNER')).send({ visitGpsRadiusM: 5 }).expect(400);
  });
});
