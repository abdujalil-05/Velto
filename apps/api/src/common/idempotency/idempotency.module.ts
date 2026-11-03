import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Module, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { IdempotencyCleanupProcessor } from './idempotency-cleanup.processor';
import { IDEMPOTENCY_CLEANUP_QUEUE } from './idempotency.constants';
import { IdempotencyInterceptor } from './idempotency.interceptor';

@Module({
  imports: [BullModule.registerQueue({ name: IDEMPOTENCY_CLEANUP_QUEUE })],
  providers: [IdempotencyInterceptor, IdempotencyCleanupProcessor],
  exports: [IdempotencyInterceptor],
})
export class IdempotencyModule implements OnModuleInit {
  constructor(@InjectQueue(IDEMPOTENCY_CLEANUP_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    // Hourly; upsert keeps a single scheduler across restarts/instances.
    await this.queue.upsertJobScheduler('idempotency-cleanup-hourly', { every: 60 * 60 * 1000 }, { name: 'purge' });
  }
}
