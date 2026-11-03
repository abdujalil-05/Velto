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
import { REDIS_CLIENT } from '../src/common/redis/redis.module';
import { StorageService } from '../src/common/storage/storage.service';
import { uniquePhone } from './unique-phone';
import { ALL_SCOPE, encodeCursor } from '../src/modules/sync/sync-cursor';
import { loginWithMfa } from './mfa-login';

/** F7: D2 health, D3 READ_ONLY_MODE, D4 sync throttle (SEC-015), Redis-down auth fail-closed (ADR-050). */
const password = 'CorrectHorseBattery9'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
const SECRET = 'redis://user:topsecret@10.9.9.9:6379 ECONNREFUSED';

const dead = () => Promise.reject(new Error(SECRET));
const deadRedis = { ping: dead, get: dead, set: dead, del: dead, ttl: dead, incr: dead, expire: dead, eval: dead };
const liveRedis = { ping: async () => 'PONG' };
const okStorage = { headBucket: async () => undefined };
const deadStorage = { headBucket: async () => Promise.reject(new Error(`S3 ${SECRET}`)) };

async function buildApp(opts: { readOnly?: boolean; redis?: unknown; storage?: unknown } = {}): Promise<INestApplication> {
  process.env.READ_ONLY_MODE = opts.readOnly ? 'true' : 'false';
  let b = Test.createTestingModule({ imports: [AppModule] });
  if (opts.redis) b = b.overrideProvider(REDIS_CLIENT).useValue(opts.redis);
  if (opts.storage) b = b.overrideProvider(StorageService).useValue(opts.storage);
  const app = (await b.compile()).createNestApplication();
  configureApp(app, ['http://localhost:3000']);
  await app.init();
  await app.listen(0, '127.0.0.1'); // own stable port: supertest's per-request ephemeral listen can race other workers under load
  return app;
}

async function seedUser(cid: string, label: string) {
  const phone = uniquePhone();
  const permissionIds: string[] = [];
  for (const key of permissionKeysForRole('OWNER')) {
    const [module, code] = key.split('.');
    permissionIds.push((await systemPrisma.permission.upsert({ where: { module_code: { module, code } }, update: {}, create: { module, code } })).id);
  }
  const user = await systemPrisma.user.create({
    data: { companyId: cid, firstName: label, lastName: 'F7', phone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
  });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_company_id', ${cid}, true)`;
    let role = await tx.role.findFirst({ where: { companyId: cid, code: 'OWNER' } });
    if (!role) {
      role = await tx.role.create({ data: { companyId: cid, code: 'OWNER', name: 'OWNER', isSystem: true } });
      for (const permissionId of permissionIds) await tx.rolePermission.create({ data: { roleId: role.id, permissionId } });
    }
    await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
  });
  return { phone };
}

describe('F7 D2: health', () => {
  let app: INestApplication;
  afterAll(async () => app?.close());

  it('live is 200 even with every dependency down', async () => {
    app = await buildApp({ redis: deadRedis, storage: deadStorage });
    const res = await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(res.body.status).toBe('up');
    expect(res.body).not.toHaveProperty('version');
    expect(res.body).not.toHaveProperty('commit');
  });

  it('ready/health 503 with redis+storage down, no error text/DSN leaked', async () => {
    for (const path of ['/health/ready', '/health']) {
      const res = await request(app.getHttpServer()).get(path).expect(503);
      expect(res.body.status).toBe('down');
      expect(res.body.checks).toMatchObject({ db: 'up', redis: 'down', storage: 'down' });
      expect(JSON.stringify(res.body)).not.toMatch(/topsecret|ECONNREFUSED|10\.9\.9\.9|redis:\/\//);
    }
  });

  it('ready 200 when all probes are up', async () => {
    await app.close();
    app = await buildApp({ redis: liveRedis, storage: okStorage });
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body.checks).toEqual({ db: 'up', redis: 'up', storage: 'up' });
  });

  it('health has its own per-IP limit: monitoring rate (130/min) passes, a flood gets 429', async () => {
    for (let i = 0; i < 130; i++) {
      const r = await request(app.getHttpServer()).get('/health/live');
      expect(r.status, `${i} ${JSON.stringify(r.body)}`).toBe(200);
    }
    let last = 200;
    for (let i = 0; i < 130 && last === 200; i++) last = (await request(app.getHttpServer()).get('/health/live')).status;
    expect(last).toBe(429);
  });
});

describe('F7 D3: READ_ONLY_MODE', () => {
  let phone: string;
  beforeAll(async () => {
    const t = await systemPrisma.tenant.create({ data: { slug: `test-f7ro-${Date.now()}`, name: 'F7 RO' } });
    const cid = (await systemPrisma.company.create({ data: { tenantId: t.id, name: 'F7 RO' } })).id;
    phone = (await seedUser(cid, 'ro')).phone;
  });

  it('true: writes -> 503 MAINTENANCE_READ_ONLY + Retry-After; GET, login, refresh, health work', async () => {
    const app = await buildApp({ readOnly: true });
    try {
      const http = () => request(app.getHttpServer());
      const login = await loginWithMfa(app, phone, password);
      const auth = { Authorization: `Bearer ${login.accessToken}` };

      const writes = [
        () =>
        http().post('/opening-balances/00000000-0000-0000-0000-000000000000/post').set(auth).send({}),
        () => http().post('/payments').set(auth).send({}),
        () => http().post('/sync/push').set(auth).send({ documents: [] }),
        () => http().post('/orders').set(auth).send({}),
        () => http().patch('/customers/x').set(auth).send({}),
        () => http().delete('/customers/x').set(auth),
      ];
      for (const w of writes) {
        const res = await w();
        expect(res.status, JSON.stringify(res.body)).toBe(503);
        expect(res.body.code).toBe('MAINTENANCE_READ_ONLY');
        expect(res.body.message).toMatchObject({ uz: expect.any(String), ru: expect.any(String), en: expect.any(String) });
        expect(res.headers['retry-after']).toBeDefined();
      }
      await http().get('/auth/me').set(auth).expect(200);
      await http().get('/health/live').expect(200);
      const refreshed = await http().post('/auth/refresh').set('Cookie', login.cookies!).send({}).expect(201);
      expect(refreshed.body.accessToken).toBeDefined();
      await http().post('/auth/logout').set('Cookie', refreshed.headers['set-cookie']).send({}).expect(204);
      // password reset writes -> blocked
      await http().post('/auth/password-reset/confirm').send({ phone, code: '123456', newPassword: password }).expect(503);
    } finally {
      await app.close();
    }
  });

  it('false: writes reach the handler (not 503)', async () => {
    const app = await buildApp({ readOnly: false });
    try {
      const res = await request(app.getHttpServer()).post('/orders').send({});
      expect(res.status).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('F7 D4: sync throttle (SEC-015) + Redis-down auth', () => {
  let app: INestApplication;
  let phoneA: string;
  let phoneB: string;
  const tokens: Record<string, string> = {};
  const secrets: Record<string, string> = {};

  beforeAll(async () => {
    app = await buildApp();
    const t = await systemPrisma.tenant.create({ data: { slug: `test-f7th-${Date.now()}`, name: 'F7 TH' } });
    const cid = (await systemPrisma.company.create({ data: { tenantId: t.id, name: 'F7 TH' } })).id;
    phoneA = (await seedUser(cid, 'a')).phone;
    phoneB = (await seedUser(cid, 'b')).phone;
    for (const [k, phone] of [['a', phoneA], ['b', phoneB]] as const) {
      const session = await loginWithMfa(app, phone, password);
      tokens[k] = session.accessToken;
      secrets[k] = session.secret!;
    }
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  const push = (k: string, n: number) =>
    request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', `Bearer ${tokens[k]}`)
      .send({
        documents: Array.from({ length: n }, () => {
          const clientId = randomUUID();
          return { type: 'order', clientId, payload: { customerId: randomUUID(), clientId, lines: [] } };
        }),
      });

  it('push: a 20-doc batch counts as 1; the 31st request -> 429 RATE_LIMITED; other user unaffected', async () => {
    const first = await push('a', 20);
    expect(first.status).toBeLessThan(300);
    for (let i = 1; i < 30; i++) expect((await push('a', 0)).status).not.toBe(429);
    const blocked = await push('a', 0);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(blocked.body.message.uz).toBeDefined();
    expect((await push('b', 0)).status).not.toBe(429);
  });

  it('pull: 61st request -> 429; other user unaffected', async () => {
    // Throttle test, not a snapshot test: an incremental cursor at the current global tail keeps each pull O(1).
    // A full resync scans StockLevel_changeSeq_idx across ALL tenants (RLS filters after the index scan) ~110ms on a 675k-row dev DB.
    const [{ m }] = await systemPrisma.$queryRaw<Array<{ m: bigint | null }>>`SELECT GREATEST(
      COALESCE((SELECT max("changeSeq") FROM "StockLevel"), 0), COALESCE((SELECT max("changeSeq") FROM "Product"), 0),
      COALESCE((SELECT max("changeSeq") FROM "Customer"), 0), COALESCE((SELECT max("changeSeq") FROM "Outlet"), 0),
      COALESCE((SELECT max("changeSeq") FROM "PriceListItem"), 0)) AS m`;
    const cursor = encodeCursor({ s: m ?? 0n, f: ALL_SCOPE });
    const pull = (k: string) => request(app.getHttpServer()).get(`/sync/pull?limit=100&cursor=${cursor}`).set('Authorization', `Bearer ${tokens[k]}`);
    for (let i = 0; i < 60; i++) expect((await pull('a')).status).toBe(200);
    expect((await pull('a')).status).toBe(429);
    expect((await pull('b')).status).toBe(200);
    // 61 pulls ~3.7s measured after the explicit per-tenant predicates in stableSeq(); 30s = margin.
  }, 30_000);

  it('Redis down: login and password-reset -> 503 SERVICE_UNAVAILABLE; existing sessions (refresh) still work', async () => {
    const login = await loginWithMfa(app, phoneB, password, secrets.b);
    const down = await buildApp({ redis: deadRedis });
    try {
      const http = () => request(down.getHttpServer());
      for (const res of [
        await http().post('/auth/login').send({ phone: phoneB, password }),
        await http().post('/auth/password-reset/request').send({ phone: phoneB }),
        await http().post('/auth/password-reset/confirm').send({ phone: phoneB, code: '123456', newPassword: password }),
      ]) {
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
        expect(JSON.stringify(res.body)).not.toMatch(/topsecret|ECONNREFUSED/);
      }
      await http().post('/auth/refresh').set('Cookie', login.cookies!).send({}).expect(201);
    } finally {
      await down.close();
    }
  });
});
