import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { OutletsController, OutletsQualityController } from './outlets/outlets.controller';
import { OutletsService } from './outlets/outlets.service';

@Module({
  controllers: [CustomersController, OutletsController, OutletsQualityController],
  providers: [CustomersService, OutletsService, AuditLogService],
  exports: [CustomersService],
})
export class CustomersModule {}
