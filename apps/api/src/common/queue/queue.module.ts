import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Global BullMQ connection config (11.2: "Navbat | BullMQ"). A dedicated
 * ioredis connection, separate from common/redis's REDIS_CLIENT — BullMQ
 * requires `maxRetriesPerRequest: null` on its connection for blocking
 * commands, which would be the wrong default for the app's other Redis
 * usage (e.g. the login rate limiter).
 *
 * Runs in-process inside apps/api rather than as a separate `apps/worker`
 * deployable — the simplest option for a single-developer MVP (13-bo'lim
 * risk: "Jamoa hajmi (bitta dasturchi)"). Producer/consumer code still lives
 * in each feature's own module (e.g. modules/integrations/export-1c), so
 * splitting it into a standalone worker process later is a deploy-config
 * change, not a rewrite.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: new Redis(config.getOrThrow<string>('REDIS_URL'), { maxRetriesPerRequest: null }),
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
