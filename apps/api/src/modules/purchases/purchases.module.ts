import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingModule } from '../../common/document-numbering/document-numbering.module';
import { StockModule } from '../stock/stock.module';
import { PurchasesController } from './purchases.controller';
import { PurchasesService } from './purchases.service';

@Module({
  imports: [StockModule, DocumentNumberingModule],
  controllers: [PurchasesController],
  providers: [PurchasesService, AuditLogService],
})
export class PurchasesModule {}
