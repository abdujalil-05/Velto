import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { StorageModule } from '../../common/storage/storage.module';
import { COMPANY_EXPORT_QUEUE } from '../company-export/company-export.constants';
import { EXPORT_1C_QUEUE } from './export-1c/export-1c.constants';
import { Export1cController } from './export-1c/export-1c.controller';
import { Export1cProcessor } from './export-1c/export-1c.processor';
import { Export1cRecoveryService } from './export-1c/export-1c-recovery.service';
import { Export1cAckService } from './export-1c/export-1c-ack.service';
import { Export1cDownloadService } from './export-1c/export-1c-download.service';
import { Export1cLimitsService } from './export-1c/export-1c-limits.service';
import { Export1cService } from './export-1c/export-1c.service';

@Module({
  imports: [BullModule.registerQueue({ name: EXPORT_1C_QUEUE }, { name: COMPANY_EXPORT_QUEUE }), StorageModule],
  controllers: [Export1cController],
  providers: [Export1cService, Export1cProcessor, Export1cRecoveryService, Export1cAckService, Export1cDownloadService, Export1cLimitsService, AuditLogService],
})
export class IntegrationsModule {}
