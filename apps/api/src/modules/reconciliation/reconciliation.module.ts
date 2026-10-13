import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { CustomersModule } from '../customers/customers.module';
import { ReconciliationService } from './reconciliation.service';

/** F2.5 stock/balance drift reconciliation. Controller + scheduled job are wired separately. */
@Module({
  imports: [CustomersModule],
  providers: [ReconciliationService, AuditLogService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
