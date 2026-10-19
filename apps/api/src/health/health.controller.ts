import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { systemPrisma } from '@velto/database';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { Public } from '../common/decorators/public.decorator';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { StorageService } from '../common/storage/storage.service';

type CheckStatus = 'up' | 'down';
export const HEALTH_CHECK_TIMEOUT_MS = 2000;

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

/** D2 (ADR-048). Public + throttle-exempt; bodies carry only up/down, never an error text, DSN or host. */
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  /** Liveness: process is up; no dependency touched. */
  @Get('live')
  live() {
    return { status: 'up' as CheckStatus, ...this.build() };
  }

  /** `GET /health` is an alias of ready (deploy/deploy.sh health gate). */
  @Get()
  async health(@Res({ passthrough: true }) res: Response) {
    return this.ready(res);
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [db, redis, storage] = await Promise.all([
      probe(() => systemPrisma.$queryRaw`SELECT 1`),
      probe(() => this.redis.ping()),
      probe((signal) => this.storage.headBucket(signal)),
    ]);
    const status: CheckStatus = db === 'up' && redis === 'up' && storage === 'up' ? 'up' : 'down';
    if (status === 'down') res.status(503);
    return { status, ...this.build(), checks: { db, redis, storage } };
  }

  private build() {
    return { version: this.config.get<string>('APP_VERSION', 'dev'), commit: this.config.get<string>('GIT_SHA', 'dev') };
  }
}
