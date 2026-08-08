import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { systemPrisma } from '@velto/database';
import type Redis from 'ioredis';
import { Public } from '../common/decorators/public.decorator';
import { REDIS_CLIENT } from '../common/redis/redis.module';

type CheckStatus = 'up' | 'down';

/** NFR-OBS: DB/Redis health, checked without any tenant context (systemPrisma bypasses RLS entirely). */
@Controller('health')
export class HealthController {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  @Public()
  @Get()
  async check() {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    const body = { status: (database === 'up' && redis === 'up' ? 'up' : 'down') as CheckStatus, checks: { database, redis } };

    if (body.status === 'down') {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }

  private async checkDatabase(): Promise<CheckStatus> {
    try {
      await systemPrisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<CheckStatus> {
    try {
      await this.redis.ping();
      return 'up';
    } catch {
      return 'down';
    }
  }
}
