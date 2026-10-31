import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { generate } from 'otplib';
import request from 'supertest';
import { prisma, systemPrisma } from '@velto/database';
import { permissionKeysForRole } from '../../../packages/database/src/rbac-catalog';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { loginWithMfa, randomIp } from './mfa-login';
import { uniquePhone } from './unique-phone';

/** ADR-058 over HTTP: gate on login, enrollment pipeline, interceptor MFA check, role elevation, admin reset. */
describe('E2E ADR-058: mandatory TOTP MFA', () => {
  let app: INestApplication;
  let coA: string;
  let coB: string;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const http = () => request(app.getHttpServer());
  // Per-IP MFA throttle (10 / 5 min, kept in Redis across runs): every public MFA call comes from its own random IP.
  const mfaPost = (path: string) => http().post(path).set('X-Forwarded-For', randomIp());

  async function company(name: string) {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-mfa-${name}-${Date.now()}`, name } });
    return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name } })).id;
  }

  async function mkUser(companyId: string, roleCode: string) {
    const permissionIds: string[] = [];
    for (const key of permissionKeysForRole(roleCode)) {
      const [module, code] = key.split('.');
      permissionIds.push((await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } })).id);
    }
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: { companyId, firstName: roleCode, lastName: 'E2E', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    await addRole(companyId, user.id, roleCode, permissionIds);
    return { id: user.id, phone };
  }

  async function addRole(companyId: string, userId: string, roleCode: string, permissionIds: string[]) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      let role = await tx.role.findFirst({ where: { companyId, code: roleCode } });
      if (!role) {
        role = await tx.role.create({ data: { companyId, code: roleCode, name: roleCode, isSystem: true } });
        for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
      }
      await tx.userRole.create({ data: { userId, roleId: role.id } });
    });
  }

  const denied = (userId: string) =>
    tenantPrisma.run(coA, (tx) => tx.auditLog.findMany({ where: { userId, action: 'auth.mfa.denied' } }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    app.getHttpAdapter().getInstance().set('trust proxy', true);
    await app.listen(0, '127.0.0.1');
    coA = await company('A');
    coB = await company('B');
  });

  afterAll(async () => {
    await app.close();
  });

  it('login of OWNER returns an MFA challenge (no token, no cookie); enrollment issues the session; refresh token never in the body', async () => {
    const owner = await mkUser(coA, 'OWNER');
    const login = await http().post('/auth/login').set('X-Forwarded-For', randomIp()).send({ phone: owner.phone, password }).expect(201);
    expect(login.body).toMatchObject({ mfa: 'enroll', expiresIn: 300 });
    expect(login.body.accessToken).toBeUndefined();
    expect(login.headers['set-cookie']).toBeUndefined();

    // anonymous-looking call with the challenge as bearer does nothing
    await http().get('/auth/me').set('Authorization', `Bearer ${login.body.mfaChallenge}`).expect(401);

    // password alone is not enough (first enrollment needs the out-of-band code)
    await mfaPost('/auth/mfa/enroll/start').send({ mfaChallenge: login.body.mfaChallenge }).expect(401);
    const admin = await mkUser(coA, 'OWNER');
    const adminSession = await loginWithMfa(app, admin.phone, password);
    const issued = await http().post(`/users/${owner.id}/mfa/enrollment-code`).set({ Authorization: `Bearer ${adminSession.accessToken}` }).expect(200);
    expect(issued.body).toMatchObject({ code: expect.any(String), expiresAt: expect.any(String) });
    const enrollmentCode = issued.body.code as string;
    const start = await mfaPost('/auth/mfa/enroll/start').send({ mfaChallenge: login.body.mfaChallenge, enrollmentCode }).expect(200);
    expect(start.body).toMatchObject({ otpauthUri: expect.stringContaining('otpauth://totp/'), qrDataUrl: expect.stringContaining('data:image/png') });
    await mfaPost('/auth/mfa/enroll/confirm').send({ mfaChallenge: login.body.mfaChallenge, enrollmentCode, code: '000000' }).expect(401);
    const confirm = await mfaPost('/auth/mfa/enroll/confirm')
      .send({ mfaChallenge: login.body.mfaChallenge, enrollmentCode, code: await generate({ secret: start.body.secret }) })
      .expect(200);
    expect(confirm.body.recoveryCodes).toHaveLength(10);
    expect(confirm.body.refreshToken).toBeUndefined();
    expect(String(confirm.headers['set-cookie'])).toContain('velto_refresh_token=');
    const me = await http().get('/auth/me').set('Authorization', `Bearer ${confirm.body.accessToken}`).expect(200);
    expect(me.body.id).toBe(owner.id);
    expect(me.body.confirmedMfaId).toBeUndefined();
  });

  it('a privileged token without the mfa claim is 401 MFA_REQUIRED and audited', async () => {
    const owner = await mkUser(coA, 'OWNER');
    const forged = await app.get(JwtService, { strict: false }).signAsync({ sub: owner.id, companyId: coA, roles: ['OWNER'] });
    const res = await http().get('/auth/me').set('Authorization', `Bearer ${forged}`).expect(401);
    expect(res.body.code).toBe('MFA_REQUIRED');
    expect(res.body.message).toMatchObject({ uz: expect.any(String), ru: expect.any(String), en: expect.any(String) });
    expect(await denied(owner.id)).toHaveLength(1);
  });

  it('role elevation kills the pre-elevation access token and refresh cookie', async () => {
    const agent = await mkUser(coA, 'SALES_AGENT');
    const login = await http().post('/auth/login').set('X-Forwarded-For', randomIp()).send({ phone: agent.phone, password }).expect(201);
    const cookie = login.headers['set-cookie'];
    await http().get('/auth/me').set('Authorization', `Bearer ${login.body.accessToken}`).expect(200);

    const permissionIds = (await systemPrisma.permission.findMany({ where: { OR: permissionKeysForRole('CASHIER').map((k) => ({ module: k.split('.')[0], code: k.split('.')[1] })) } })).map((p) => p.id);
    await addRole(coA, agent.id, 'CASHIER', permissionIds);

    const me = await http().get('/auth/me').set('Authorization', `Bearer ${login.body.accessToken}`).expect(401);
    expect(me.body.code).toBe('MFA_REQUIRED');
    const refresh = await http().post('/auth/refresh').set('Cookie', cookie).send({}).expect(401);
    expect(refresh.body.code).toBe('MFA_REQUIRED');
    // the next login is gated
    const next = await http().post('/auth/login').set('X-Forwarded-For', randomIp()).send({ phone: agent.phone, password }).expect(201);
    expect(next.body.mfa).toBe('enroll');
  });

  it('POST /users/:id/mfa/reset: permission, self, cross-tenant, effect on the target session', async () => {
    const admin = await mkUser(coA, 'OWNER');
    const target = await mkUser(coA, 'CASHIER');
    const foreign = await mkUser(coB, 'OWNER');
    const adminSession = await loginWithMfa(app, admin.phone, password);
    const targetSession = await loginWithMfa(app, target.phone, password);
    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
    const url = (id: string) => `/users/${id}/mfa/reset`;

    // CASHIER has no users.mfa_reset
    await http().post(url(admin.id)).set(bearer(targetSession.accessToken)).send({ reason: 'nope nope' }).expect(403);
    await http().post(url(admin.id)).set(bearer(adminSession.accessToken)).send({ reason: 'self reset' }).expect(400);
    await http().post(url(foreign.id)).set(bearer(adminSession.accessToken)).send({ reason: 'cross tenant' }).expect(404);
    await http().post(url(target.id)).set(bearer(adminSession.accessToken)).send({ reason: 'x' }).expect(400); // reason too short

    await http().post(url(target.id)).set(bearer(adminSession.accessToken)).send({ reason: 'lost device' }).expect(200);
    const res = await http().get('/auth/me').set(bearer(targetSession.accessToken)).expect(401);
    expect(res.body.code).toBe('MFA_REQUIRED');
    // MFA is not off: the target must enroll again
    const next = await http().post('/auth/login').set('X-Forwarded-For', randomIp()).send({ phone: target.phone, password }).expect(201);
    expect(next.body.mfa).toBe('enroll');
  });

  it('POST /users/:id/mfa/enrollment-code: RBAC, self, cross-tenant, already-enrolled, non-privileged', async () => {
    const admin = await mkUser(coA, 'OWNER');
    const cashier = await mkUser(coA, 'CASHIER');
    const fresh = await mkUser(coA, 'OWNER');
    const agent = await mkUser(coA, 'SALES_AGENT');
    const foreign = await mkUser(coB, 'OWNER');
    const adminSession = await loginWithMfa(app, admin.phone, password);
    const cashierSession = await loginWithMfa(app, cashier.phone, password);
    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
    const url = (id: string) => `/users/${id}/mfa/enrollment-code`;
    await http().post(url(fresh.id)).set(bearer(cashierSession.accessToken)).expect(403);
    await http().post(url(admin.id)).set(bearer(adminSession.accessToken)).expect(400);
    await http().post(url(foreign.id)).set(bearer(adminSession.accessToken)).expect(404);
    await http().post(url(cashier.id)).set(bearer(adminSession.accessToken)).expect(400); // already has confirmed MFA
    const bad = await http().post(url(agent.id)).set(bearer(adminSession.accessToken)).expect(400);
    expect(bad.body.code).toBe('USER_MFA_ENROLLMENT_CODE_NOT_APPLICABLE');
    await systemPrisma.user.update({ where: { id: agent.id }, data: { isActive: false } });
    await http().post(url(agent.id)).set(bearer(adminSession.accessToken)).expect(404); // inactive target
    const ok = await http().post(url(fresh.id)).set(bearer(adminSession.accessToken)).expect(200);
    const audits = await systemPrisma.auditLog.findMany({ where: { entityId: fresh.id, action: 'auth.mfa.enrollment_code_issued' } });
    expect(audits).toHaveLength(1);
    expect(audits[0].traceId).toBeTruthy();
    expect(JSON.stringify(audits[0].newValue)).not.toContain(ok.body.code);
  });

  it('self-service re-enroll over HTTP: wrong password rejected; correct returns an enroll challenge; confirm kills the old access token', async () => {
    const owner = await mkUser(coA, 'OWNER');
    const s = await loginWithMfa(app, owner.phone, password);
    const auth = { Authorization: `Bearer ${s.accessToken}` };
    await http().post('/auth/mfa/reenroll').set(auth).send({ password: 'wrong-password', code: await generate({ secret: s.secret! }) }).expect(401);
    await systemPrisma.userMfa.update({ where: { userId: owner.id }, data: { lastUsedStep: -1 } });
    const re = await http().post('/auth/mfa/reenroll').set(auth).send({ password, code: await generate({ secret: s.secret! }) }).expect(200);
    expect(re.body.mfa).toBe('enroll');
    const start = await mfaPost('/auth/mfa/enroll/start').send({ mfaChallenge: re.body.mfaChallenge }).expect(200);
    await http().get('/auth/me').set(auth).expect(200); // old MFA still valid until confirm
    await mfaPost('/auth/mfa/enroll/confirm').send({ mfaChallenge: re.body.mfaChallenge, code: await generate({ secret: start.body.secret }) }).expect(200);
    const old = await http().get('/auth/me').set(auth).expect(401);
    expect(old.body.code).toBe('MFA_REQUIRED');
  });
});
