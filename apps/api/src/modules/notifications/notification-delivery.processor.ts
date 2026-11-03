import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { runJobWithTrace } from '../../common/queue/trace-job';
import { NOTIFICATION_DELIVERY_QUEUE, type NotificationDeliveryJobData } from './notification-delivery.constants';
import { NotificationDeliveryService } from './notification-delivery.service';

/** ADR-060: consumes one delivery attempt per job; the row (CAS claim) is the source of truth, so redelivery is a no-op. */
@Processor(NOTIFICATION_DELIVERY_QUEUE)
export class NotificationDeliveryProcessor extends WorkerHost {
  constructor(private readonly delivery: NotificationDeliveryService) {
    super();
  }

  async process(job: Job<NotificationDeliveryJobData>): Promise<void> {
    await runJobWithTrace(job, () => this.delivery.deliver(job.data.companyId, job.data.notificationId));
  }
}
