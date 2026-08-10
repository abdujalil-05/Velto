import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingModule } from '../../common/document-numbering/document-numbering.module';
import { CustomersModule } from '../customers/customers.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PurchasesModule } from '../purchases/purchases.module';
import { StockModule } from '../stock/stock.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [CustomersModule, StockModule, DocumentNumberingModule, NotificationsModule, PurchasesModule],
  controllers: [SalesController],
  providers: [SalesService, AuditLogService],
  exports: [SalesService],
})
export class SalesModule {}
