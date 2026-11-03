import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { generate } from 'otplib';
import request from 'supertest';
import { prisma, systemPrisma } from '@velto/database';
import { permissionKeysForRole, SYSTEM_ROLES } from '../../../packages/database/src/rbac-catalog';
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

  /** Step-up body for POST /users/:id/mfa/enrollment-code: rewinds the replay guard, then the current TOTP. */
  async function proofOf(userId: string, secret: string) {
    await systemPrisma.userMfa.update({ where: { userId }, data: { lastUsedStep: -1 } });
    return { currentPassword: password, totpCode: await generate({ secret }) };
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
    const issued = await http().post(`/users/${owner.id}/mfa/enrollment-code`).set({ Authorization: `Bearer ${adminSession.accessToken}` }).send(await proofOf(admin.id, adminSession.secret!)).expect(200);
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
    const forged = await app.get(JwtService, { strict: false }).signAsync({ sub: owner.id, companyId: coA, roles: ['OWNER'], sid: randomUUID() });
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

  it('POST /users/:id/mfa/reset: step-up (challenge + password + TOTP), target rules, effect on the target session', async () => {
    const admin = await mkUser(coA, 'OWNER');
    const owner2 = await mkUser(coA, 'OWNER');
    const target = await mkUser(coA, 'CASHIER');
    const foreign = await mkUser(coB, 'OWNER');
    const adminSession = await loginWithMfa(app, admin.phone, password);
    const targetSession = await loginWithMfa(app, target.phone, password);
    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
    const auth = bearer(adminSession.accessToken);
    const url = (id: string) => `/users/${id}/mfa/reset`;
    const challenge = async (id: string, token = adminSession.accessToken) => http().post(`${url(id)}/challenge`).set(bearer(token));
    const body = async (challengeId: string, over: Record<string, unknown> = {}) => ({ challengeId, reason: 'lost device', ...(await proofOf(admin.id, adminSession.secret!)), ...over });

    // only OWNER holds users.mfa_reset (catalog)
    expect(SYSTEM_ROLES.filter((r) => permissionKeysForRole(r.code).includes('users.mfa_reset')).map((r) => r.code)).toEqual(['OWNER']);
    // CASHIER: no permission; unauthenticated: 401
    await challenge(admin.id, targetSession.accessToken).then((r) => expect(r.status).toBe(403));
    await http().post(url(admin.id)).set(bearer(targetSession.accessToken)).send({}).expect(403);
    await http().post(`${url(target.id)}/challenge`).expect(401);
    // target rules at challenge time
    await challenge(admin.id).then((r) => expect(r.status).toBe(400));
    const ownerRes = await challenge(owner2.id);
    expect(ownerRes.status).toBe(403);
    expect(ownerRes.body.code).toBe('CANNOT_RESET_OWNER_MFA');
    expect(ownerRes.body.message).toMatchObject({ uz: expect.any(String), ru: expect.any(String), en: expect.any(String) });
    await challenge(foreign.id).then((r) => expect(r.status).toBe(404));
    // a session token without sid cannot start a step-up
    const noSid = await app.get(JwtService, { strict: false }).signAsync({ sub: admin.id, companyId: coA, roles: ['OWNER'], mfa: (await systemPrisma.userMfa.findUniqueOrThrow({ where: { userId: admin.id } })).id });
    await challenge(target.id, noSid).then((r) => expect(r.status).toBe(401));

    // stolen session, no proof: old shape / no challenge / password-only / TOTP-only / recovery code / unknown challenge
    await http().post(url(target.id)).set(auth).send({ reason: 'lost device' }).expect(400);
    const ch = await challenge(target.id);
    expect(ch.status).toBe(201);
    expect(ch.body).toMatchObject({ challengeId: expect.any(String), expiresIn: expect.any(Number) });
    expect(ch.body.expiresIn).toBeLessThanOrEqual(300);
    const id = ch.body.challengeId as string;
    await http().post(url(target.id)).set(auth).send({ challengeId: id, reason: 'lost device', currentPassword: password }).expect(400);
    await http().post(url(target.id)).set(auth).send({ challengeId: id, reason: 'lost device', totpCode: '123456' }).expect(400);
    await http().post(url(target.id)).set(auth).send(await body(id, { totpCode: adminSession.recoveryCodes?.[0] ?? 'ABCD-EFGH-IJKL' })).expect(400);
    await http().post(url(target.id)).set(auth).send(await body('x'.repeat(43))).then((r) => {
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('MFA_CHALLENGE_INVALID');
    });
    const wrongPw = await http().post(url(target.id)).set(auth).send(await body(id, { currentPassword: 'wrong-password' }));
    expect(wrongPw.status).toBe(401);
    expect(wrongPw.body.code).toBe('MFA_CODE_INVALID');
    const good = await body(id);
    await http().post(url(target.id)).set(auth).send({ ...good, totpCode: good.totpCode === '000000' ? '111111' : '000000' }).expect(401);
    await http().get('/auth/me').set(bearer(targetSession.accessToken)).expect(200); // still enrolled

    // two parallel resets with the same challenge: exactly one executes
    const proof = await body(id);
    const [r1, r2] = await Promise.all([http().post(url(target.id)).set(auth).send(proof), http().post(url(target.id)).set(auth).send(proof)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 401]);
    const ok = r1.status === 200 ? r1 : r2;
    expect(ok.body).toMatchObject({ reset: true, sessionsRevoked: 1, enrollmentCode: { code: expect.any(String), expiresAt: expect.any(String) } });
    // challenge reuse
    await http().post(url(target.id)).set(auth).send(await body(id)).then((r) => expect(r.body.code).toBe('MFA_CHALLENGE_INVALID'));

    // effect on the target: access + refresh tokens dead, audit has trace and no secrets
    const res = await http().get('/auth/me').set(bearer(targetSession.accessToken)).expect(401);
    expect(res.body.code).toBe('MFA_REQUIRED');
    await http().post('/auth/refresh').set('Cookie', targetSession.cookies!).send({}).expect(401);
    const next = await http().post('/auth/login').set('X-Forwarded-For', randomIp()).send({ phone: target.phone, password }).expect(201);
    expect(next.body.mfa).toBe('enroll');
    const audit = await systemPrisma.auditLog.findFirstOrThrow({ where: { entityId: target.id, action: 'auth.mfa.reset' } });
    expect(audit).toMatchObject({ userId: admin.id, traceId: expect.any(String) });
    expect(JSON.stringify(audit.newValue)).not.toContain(ok.body.enrollmentCode.code);
    expect(JSON.stringify(audit.newValue)).not.toContain(password);
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
    const post = async (id: string, token = adminSession.accessToken) => http().post(url(id)).set(bearer(token)).send(await proofOf(admin.id, adminSession.secret!));
    await http().post(url(fresh.id)).set(bearer(cashierSession.accessToken)).send({ currentPassword: password, totpCode: '123456' }).expect(403);
    await post(admin.id).then((r) => expect(r.status).toBe(400));
    await post(foreign.id).then((r) => expect(r.status).toBe(404));
    await post(cashier.id).then((r) => expect(r.status).toBe(400)); // already has confirmed MFA
    const bad = await post(agent.id);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('USER_MFA_ENROLLMENT_CODE_NOT_APPLICABLE');
    await systemPrisma.user.update({ where: { id: agent.id }, data: { isActive: false } });
    await post(agent.id).then((r) => expect(r.status).toBe(404)); // inactive target
    const ok = await post(fresh.id);
    expect(ok.status).toBe(200);
    const audits = await systemPrisma.auditLog.findMany({ where: { entityId: fresh.id, action: 'auth.mfa.enrollment_code_issued' } });
    expect(audits).toHaveLength(1);
    expect(audits[0].traceId).toBeTruthy();
    expect(JSON.stringify(audits[0].newValue)).not.toContain(ok.body.code);
  });

  it('POST /users/:id/mfa/enrollment-code: step-up proof required (400 on missing fields, 401 wrong password/TOTP, recovery code once)', async () => {
    const admin = await mkUser(coA, 'OWNER');
    const t1 = await mkUser(coA, 'OWNER');
    const t2 = await mkUser(coA, 'OWNER');
    const s = await loginWithMfa(app, admin.phone, password);
    const auth = { Authorization: `Bearer ${s.accessToken}` };
    const url = (id: string) => `/users/${id}/mfa/enrollment-code`;
    await http().post(url(t1.id)).set(auth).expect(400);
    await http().post(url(t1.id)).set(auth).send({ currentPassword: password }).expect(400);
    const good = await proofOf(admin.id, s.secret!);
    await http().post(url(t1.id)).set(auth).send({ ...good, currentPassword: 'wrong-password' }).expect(401);
    await http().post(url(t1.id)).set(auth).send({ ...good, totpCode: good.totpCode === '000000' ? '111111' : '000000' }).expect(401);
    expect(await systemPrisma.mfaEnrollmentCode.count({ where: { userId: t1.id } })).toBe(0);
    expect(await systemPrisma.auditLog.count({ where: { entityId: admin.id, action: 'auth.mfa.failed' } })).toBeGreaterThan(0);
    await http().post(url(t1.id)).set(auth).send(good).expect(200);
    // replay of the same TOTP
    await http().post(url(t2.id)).set(auth).send(good).expect(401);
    expect(await systemPrisma.mfaEnrollmentCode.count({ where: { userId: t2.id } })).toBe(0);
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
