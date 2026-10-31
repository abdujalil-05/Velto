import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { NOTIFICATION_DELIVERY_QUEUE } from './notification-delivery.constants';
import { NotificationDeliveryProcessor } from './notification-delivery.processor';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationDeliverySweepService } from './notification-delivery-sweep.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { OwnerAlertsService } from './owner-alerts';

@Module({
  imports: [BullModule.registerQueue({ name: NOTIFICATION_DELIVERY_QUEUE })],
  controllers: [NotificationsController],
  providers: [NotificationsService, OwnerAlertsService, NotificationDeliveryService, NotificationDeliveryProcessor, NotificationDeliverySweepService],
  exports: [NotificationsService, OwnerAlertsService],
})
export class NotificationsModule {}
