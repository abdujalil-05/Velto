import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { FieldAlertService } from './field-alert.service';
import { RoutesController } from './routes/routes.controller';
import { RoutesService } from './routes/routes.service';
import { VisitsController } from './visits/visits.controller';
import { VisitsService } from './visits/visits.service';

@Module({
  imports: [NotificationsModule],
  controllers: [RoutesController, VisitsController],
  providers: [RoutesService, VisitsService, AuditLogService, FieldAlertService],
  exports: [VisitsService],
})
export class FieldModule {}
