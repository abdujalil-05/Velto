import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  controllers: [SettingsController],
  providers: [SettingsService, AuditLogService],
})
export class SettingsModule {}
