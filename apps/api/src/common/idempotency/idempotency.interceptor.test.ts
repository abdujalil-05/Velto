import 'reflect-metadata';
import { of } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import type { ExecutionContext } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { IdempotencyCleanupProcessor } from './idempotency-cleanup.processor';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyKeyReusedException } from './idempotency-exceptions';

describe('IdempotencyInterceptor (integration, real Postgres + RLS)', () => {
  let companyId: string;
  let userId: string;
  const tenantPrisma = new TenantPrismaService();
  const interceptor = new IdempotencyInterceptor();

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-idem-${Date.now()}`, name: 'Idem' } });
    const company = await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Idem Co' } });
    companyId = company.id;
    const u = await systemPrisma.user.create({
      data: { companyId, firstName: 'I', lastName: 'D', phone: `+99890${Math.floor(1_000_000 + Math.random() * 8_000_000)}` },
    });
    userId = u.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  function call(key: string | undefined, body: unknown, handler: () => unknown) {
    const res = { statusCode: 0, status(c: number) { this.statusCode = c; return this; } };
    const req = { method: 'POST', originalUrl: '/orders/1/confirm', headers: key ? { 'idempotency-key': key } : {}, body, user: { id: userId } };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      getHandler: () => function h() {},
    } as unknown as ExecutionContext;
    return tenantPrisma.run(companyId, async () => {
      const obs = interceptor.intercept(ctx, { handle: () => of(handler()) });
      return new Promise<unknown>((resolve, reject) => obs.subscribe({ next: resolve, error: reject }));
    }).then((body2) => ({ body: body2, status: res.statusCode }));
  }

  it('replays stored body without re-running the handler', async () => {
    let runs = 0;
    const h = () => ({ n: ++runs });
    const a = await call('k-replay', { a: 1 }, h);
    const b = await call('k-replay', { a: 1 }, h);
    expect(runs).toBe(1);
    expect(b.body).toEqual(a.body);
    expect(b.status).toBe(201);
  });

  it('rejects same key with a different body (422 IDEMPOTENCY_KEY_REUSED)', async () => {
    await call('k-reuse', { a: 1 }, () => ({ ok: true }));
    await expect(call('k-reuse', { a: 2 }, () => ({ ok: true }))).rejects.toBeInstanceOf(IdempotencyKeyReusedException);
  });

  it('runs normally without a key and stores nothing', async () => {
    let runs = 0;
    await call(undefined, {}, () => ({ n: ++runs }));
    await call(undefined, {}, () => ({ n: ++runs }));
    expect(runs).toBe(2);
  });

  it('concurrent same-key calls run the handler once', async () => {
    let runs = 0;
    const h = () => ({ n: ++runs });
    const [a, b] = await Promise.all([call('k-race', { x: 1 }, h), call('k-race', { x: 1 }, h)]);
    expect(runs).toBe(1);
    expect(a.body).toEqual(b.body);
  });

  it('does not store a record when the handler fails (rolled back)', async () => {
    await expect(call('k-fail', {}, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const n = await systemPrisma.idempotencyRecord.count({ where: { companyId, key: 'k-fail' } });
    expect(n).toBe(0);
  });

  it('cleanup purges expired records only', async () => {
    await systemPrisma.idempotencyRecord.create({
      data: { companyId, key: 'k-old', userId, route: 'POST /x', requestHash: 'h', responseStatus: 201, responseBody: {}, expiresAt: new Date(Date.now() - 1000) },
    });
    const deleted = await new IdempotencyCleanupProcessor().purgeExpired();
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await systemPrisma.idempotencyRecord.count({ where: { companyId, key: 'k-old' } })).toBe(0);
    expect(await systemPrisma.idempotencyRecord.count({ where: { companyId, key: 'k-replay' } })).toBe(1);
  });
});
