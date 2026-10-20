import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () => new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
        // Fail fast when Redis is down (default 20 retries would hang a request for tens of seconds):
        // callers that need Redis fail closed with 503 (ADR-050), health reports 'down'.
        maxRetriesPerRequest: 1,
      }),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
