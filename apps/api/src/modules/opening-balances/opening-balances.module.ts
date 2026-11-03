import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingModule } from '../../common/document-numbering/document-numbering.module';
import { StorageModule } from '../../common/storage/storage.module';
import { CustomersModule } from '../customers/customers.module';
import { StockModule } from '../stock/stock.module';
import { OpeningBalancesController } from './opening-balances.controller';
import { OpeningBalancesService } from './opening-balances.service';

@Module({
  imports: [CustomersModule, StockModule, DocumentNumberingModule, StorageModule],
  controllers: [OpeningBalancesController],
  providers: [OpeningBalancesService, AuditLogService],
})
export class OpeningBalancesModule {}
