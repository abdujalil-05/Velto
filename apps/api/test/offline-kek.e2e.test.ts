import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemPrisma } from '@velto/database';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { loginWithMfa } from './mfa-login';
import { uniquePhone } from './unique-phone';

// Rotation fixture: current = v2 (fresh secret), v1 kept in the keyring. vi.hoisted: must run before AppModule's ConfigModule.forRoot().
const { OLD_SECRET, NEW_SECRET } = vi.hoisted(() => {
  const oldSecret = process.env.OFFLINE_KEK_SECRET!;
  const newSecret = 'rotated-' + oldSecret.split('').reverse().join('');
  process.env.OFFLINE_KEK_SECRET = newSecret;
  process.env.OFFLINE_KEK_VERSION = '2';
  process.env.OFFLINE_KEK_PREVIOUS_SECRETS = `1:${oldSecret}`;
  return { OLD_SECRET: oldSecret, NEW_SECRET: newSecret };
});

describe('E2E: GET /auth/offline-kek', () => {
  let app: INestApplication;
  const tenantPrisma = new TenantPrismaService();
  const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
  const http = () => request(app.getHttpServer());
  type Actor = { id: string; companyId: string; token: string; cookies: string[] };
  let a1: Actor, a2: Actor, b1: Actor;

  async function makeCompany(): Promise<string> {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-kek-${randomUUID()}`, name: 'KEK' } });
    return (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'KEK Co' } })).id;
  }
  async function makeUser(companyId: string): Promise<Actor> {
    const phone = uniquePhone();
    const user = await systemPrisma.user.create({
      data: { companyId, firstName: 'K', lastName: 'E', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    const l = await loginWithMfa(app, phone, password);
    return { id: user.id, companyId, token: l.accessToken, cookies: l.cookies ?? [] };
  }
  const get = (a: Actor, q = '') => http().get(`/auth/offline-kek${q}`).set('Authorization', `Bearer ${a.token}`);
  const audits = (a: Actor, action: string) => tenantPrisma.run(a.companyId, (tx) => tx.auditLog.findMany({ where: { userId: a.id, action } }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://localhost:3000']);
    await app.listen(0, '127.0.0.1');
    const c1 = await makeCompany();
    const c2 = await makeCompany();
    a1 = await makeUser(c1);
    a2 = await makeUser(c1);
    b1 = await makeUser(c2);
  });
  afterAll(async () => {
    await app.close();
  });

  it('401 without token; success is no-store, repeatable, current v2, no secret in body', async () => {
    const unauth = await http().get('/auth/offline-kek').expect(401);
    expect(unauth.headers['cache-control']).toBe('no-store');
    const r1 = await get(a1).expect(200);
    const r2 = await get(a1).expect(200);
    expect(r1.headers['cache-control']).toBe('no-store');
    expect(r1.headers.pragma).toBe('no-cache');
    expect(r1.body).toEqual(r2.body);
    expect(r1.body).toMatchObject({ version: 2, currentVersion: 2 });
    expect(Buffer.from(r1.body.kek, 'base64url')).toHaveLength(32);
    expect(JSON.stringify(r1.body)).not.toContain(NEW_SECRET);
    expect(JSON.stringify(r1.body)).not.toContain(OLD_SECRET);
  });

  it('version=1 returns the old key (differs from current); retired/unknown 410; bad param 400; identity params rejected', async () => {
    const cur = await get(a1).expect(200);
    const old = await get(a1, '?version=1').expect(200);
    expect(old.body).toMatchObject({ version: 1, currentVersion: 2 });
    expect(old.body.kek).not.toBe(cur.body.kek);
    const gone = await get(a1, '?version=7').expect(410);
    expect(gone.body.code).toBe('OFFLINE_KEK_VERSION_RETIRED');
    expect(gone.headers['cache-control']).toBe('no-store');
    for (const q of ['?version=abc', '?version=1.5', '?version=-1', '?version=0', '?version=01', '?userId=x', '?companyId=x']) {
      await get(a1, q).expect(400);
    }
  });

  it('different user / company get different keys; cannot request another user key', async () => {
    const k = async (a: Actor) => (await get(a).expect(200)).body.kek as string;
    const [k1, k2, kb] = [await k(a1), await k(a2), await k(b1)];
    expect(new Set([k1, k2, kb]).size).toBe(3);
    await get(a1, `?userId=${a2.id}`).expect(400);
  });

  it('audit rows: issued/denied without key material', async () => {
    const issued = await audits(a1, 'auth.offline_kek.issued');
    expect(issued.length).toBeGreaterThan(0);
    const denied = await audits(a1, 'auth.offline_kek.denied');
    expect(denied.some((d) => (d.newValue as { reason?: string }).reason === 'version_retired')).toBe(true);
    const dump = JSON.stringify([...issued, ...denied]);
    for (const secret of [NEW_SECRET, OLD_SECRET]) expect(dump).not.toContain(secret);
    const keys = [(await get(a1).expect(200)).body.kek, (await get(a1, '?version=1').expect(200)).body.kek];
    for (const key of keys) expect(dump).not.toContain(key);
  });

  it('rate limit: 11th request within a minute => 429 RATE_LIMITED + audit', async () => {
    const u = await makeUser(a1.companyId);
    for (let i = 0; i < 10; i++) await get(u).expect(200);
    const res = await get(u).expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.headers['cache-control']).toBe('no-store');
    const d = await audits(u, 'auth.offline_kek.denied');
    expect(d.some((x) => (x.newValue as { reason?: string }).reason === 'rate_limited')).toBe(true);
  });

  it('logout / revoked session => 401 (access token still unexpired) + audit', async () => {
    const u = await makeUser(a1.companyId);
    await get(u).expect(200);
    await http().post('/auth/logout').set('Cookie', u.cookies).send({}).expect(204);
    const res = await get(u).expect(401);
    expect(res.body.code).toBe('AUTH_SESSION_EXPIRED');
    expect(res.headers['cache-control']).toBe('no-store');
    const d = await audits(u, 'auth.offline_kek.denied');
    expect(d.some((x) => (x.newValue as { reason?: string }).reason === 'session_revoked')).toBe(true);
  });
});
