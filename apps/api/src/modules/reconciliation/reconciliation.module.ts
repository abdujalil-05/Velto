import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Module, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { CustomersModule } from '../customers/customers.module';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  RECONCILIATION_CRON,
  RECONCILIATION_QUEUE,
  RECONCILIATION_SCHEDULER_ID,
  RECONCILIATION_TZ,
} from './reconciliation.constants';
import { ReconciliationAdminService } from './reconciliation-admin.service';
import { ReconciliationAlertService } from './reconciliation-alert.service';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationScheduleProcessor } from './reconciliation-schedule.processor';
import { ReconciliationService } from './reconciliation.service';

/** F2.5 stock/balance drift reconciliation: API + daily 03:00 Asia/Tashkent sweep. */
@Module({
  imports: [
    CustomersModule,
    NotificationsModule,
    BullModule.registerQueue({ name: RECONCILIATION_QUEUE }),
  ],
  controllers: [ReconciliationController],
  providers: [
    ReconciliationService,
    ReconciliationAdminService,
    ReconciliationAlertService,
    ReconciliationScheduleProcessor,
    AuditLogService,
  ],
  exports: [ReconciliationService],
})
export class ReconciliationModule implements OnModuleInit {
  constructor(@InjectQueue(RECONCILIATION_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    // Upsert keeps a single scheduler across restarts/instances.
    await this.queue.upsertJobScheduler(
      RECONCILIATION_SCHEDULER_ID,
      { pattern: RECONCILIATION_CRON, tz: RECONCILIATION_TZ },
      { name: 'sweep' },
    );
  }
}
