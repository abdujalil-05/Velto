import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { RoutesController } from './routes/routes.controller';
import { RoutesService } from './routes/routes.service';
import { VisitsController } from './visits/visits.controller';
import { VisitsService } from './visits/visits.service';

@Module({
  controllers: [RoutesController, VisitsController],
  providers: [RoutesService, VisitsService, AuditLogService],
  exports: [VisitsService],
})
export class FieldModule {}
