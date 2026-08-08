import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { StorageModule } from '../../common/storage/storage.module';
import { IMPORT_QUEUE } from './import.constants';
import { ImportController } from './import.controller';
import { ImportProcessor } from './import.processor';
import { ImportService } from './import.service';

@Module({
  imports: [BullModule.registerQueue({ name: IMPORT_QUEUE }), StorageModule],
  controllers: [ImportController],
  providers: [ImportService, ImportProcessor, AuditLogService],
})
export class ImportModule {}
