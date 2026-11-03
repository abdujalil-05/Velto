import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { prisma } from '@velto/database';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { DEFAULT_HEALTH_READY_CACHE_MS } from '../common/config/env.schema';
import { Public } from '../common/decorators/public.decorator';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { StorageService } from '../common/storage/storage.service';

type CheckStatus = 'up' | 'down';
export const HEALTH_CHECK_TIMEOUT_MS = 2000;
/** Per-IP cap for health routes: loose enough for monitoring/deploy gate (<=4 req/s), tight enough to stop a flood. */
export const HEALTH_THROTTLE = { default: { limit: 240, ttl: 60_000 } };

type ReadyBody = { ready: boolean; checks: { db: CheckStatus; redis: CheckStatus; storage: CheckStatus } };

/** Rejects (never leaks the cause) if `fn` fails or takes longer than the timeout. */
async function probe(fn: (signal: AbortSignal) => Promise<unknown>): Promise<CheckStatus> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(ac.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new Error('timeout'));
        }, HEALTH_CHECK_TIMEOUT_MS);
      }),
    ]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * D2 (ADR-048). Public, per-IP throttled (HEALTH_THROTTLE); the DB probe uses the APP pool (never the
 * 5-connection systemPrisma pool that serves login/telegram lookup) and the whole ready result is cached
 * for HEALTH_READY_CACHE_MS with one shared in-flight probe, so an anonymous flood cannot reach the DB
 * more than ~once per cache window. Bodies carry only up/down, never an error text, DSN or host. */
@Public()
@Throttle(HEALTH_THROTTLE)
@Controller('health')
export class HealthController {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  private cached?: { at: number; value: ReadyBody };
  private inflight?: Promise<ReadyBody>;

  /** Liveness: process is up; no dependency touched. */
  @Get('live')
  live() {
    return { status: 'up' as CheckStatus };
  }

  /** `GET /health` is an alias of ready (deploy/deploy.sh health gate). */
  @Get()
  async health(@Res({ passthrough: true }) res: Response) {
    return this.ready(res);
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const { ready, checks } = await this.readiness();
    const status: CheckStatus = ready ? 'up' : 'down';
    if (!ready) res.status(503);
    return { status, checks };
  }

  private readiness(): Promise<ReadyBody> {
    const ttl = Number(this.config.get('HEALTH_READY_CACHE_MS', DEFAULT_HEALTH_READY_CACHE_MS));
    if (this.cached && Date.now() - this.cached.at < ttl) return Promise.resolve(this.cached.value);
    this.inflight ??= this.runProbes()
      .then((value) => {
        this.cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  private async runProbes(): Promise<ReadyBody> {
    const [db, redis, storage] = await Promise.all([
      // Plain app-pool ping: no tenant context, touches no table, so RLS is irrelevant.
      probe(() => prisma.$queryRaw`SELECT 1`),
      probe(() => this.redis.ping()),
      probe((signal) => this.storage.headBucket(signal)),
    ]);
    return { ready: db === 'up' && redis === 'up' && storage === 'up', checks: { db, redis, storage } };
  }
}
