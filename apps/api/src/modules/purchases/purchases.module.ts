import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingModule } from '../../common/document-numbering/document-numbering.module';
import { StockModule } from '../stock/stock.module';
import { PurchaseOrdersController } from './purchase-orders/purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders/purchase-orders.service';
import { SuppliersController } from './suppliers/suppliers.controller';
import { SuppliersService } from './suppliers/suppliers.service';

@Module({
  imports: [StockModule, DocumentNumberingModule],
  controllers: [SuppliersController, PurchaseOrdersController],
  providers: [SuppliersService, PurchaseOrdersService, AuditLogService],
})
export class PurchasesModule {}
