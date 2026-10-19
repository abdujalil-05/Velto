import { afterEach, describe, expect, it, vi } from 'vitest';

const { prismaQ, systemQ } = vi.hoisted(() => ({ prismaQ: vi.fn(), systemQ: vi.fn() }));
vi.mock('@velto/database', () => ({ prisma: { $queryRaw: prismaQ }, systemPrisma: { $queryRaw: systemQ } }));

import { HealthController } from './health.controller';

const res = () => {
  const r = { code: 200, status(c: number) { r.code = c; return r; } };
  return r as never as { code: number; status(c: number): unknown };
};
const make = (cacheMs: number, redisOk = true) =>
  new HealthController(
    { ping: async () => { if (!redisOk) throw new Error('x'); return 'PONG'; } } as never,
    { headBucket: async () => undefined } as never,
    { get: (_k: string, d: unknown) => (_k === 'HEALTH_READY_CACHE_MS' ? cacheMs : d) } as never,
  );

afterEach(() => vi.clearAllMocks());

describe('HealthController.ready', () => {
  it('200 parallel ready -> <=2 DB probes, app pool only (never systemPrisma)', async () => {
    prismaQ.mockImplementation(() => new Promise((r) => setTimeout(() => r([{}]), 20)));
    const c = make(1000);
    const out = await Promise.all(Array.from({ length: 200 }, () => c.ready(res() as never)));
    expect(out.every((o) => o.status === 'up')).toBe(true);
    expect(prismaQ.mock.calls.length).toBeLessThanOrEqual(2);
    expect(systemQ).not.toHaveBeenCalled();
    await c.ready(res() as never); // within cache window
    expect(prismaQ.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('re-probes after the cache window', async () => {
    prismaQ.mockResolvedValue([{}]);
    const c = make(0);
    await c.ready(res() as never);
    await c.ready(res() as never);
    expect(prismaQ).toHaveBeenCalledTimes(2);
  });

  it('dependency down -> 503 body unchanged (db/redis/storage up|down only)', async () => {
    prismaQ.mockRejectedValue(new Error('P2024 secret'));
    const r = res();
    const body = await make(1000, false).ready(r as never);
    expect(r.code).toBe(503);
    expect(body).toMatchObject({ status: 'down', checks: { db: 'down', redis: 'down', storage: 'up' } });
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('live touches no dependency', () => {
    expect(make(1000).live().status).toBe('up');
    expect(prismaQ).not.toHaveBeenCalled();
  });
});
