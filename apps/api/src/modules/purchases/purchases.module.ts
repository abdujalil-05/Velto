import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { DocumentNumberingModule } from '../../common/document-numbering/document-numbering.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StockModule } from '../stock/stock.module';
import { PurchaseOrdersController } from './purchase-orders/purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders/purchase-orders.service';
import { SupplierRoutesService } from './supplier-routes/supplier-routes.service';
import { SupplierTelegramService } from './suppliers/supplier-telegram.service';
import { SuppliersController } from './suppliers/suppliers.controller';
import { SuppliersService } from './suppliers/suppliers.service';

@Module({
  imports: [StockModule, DocumentNumberingModule, NotificationsModule],
  controllers: [SuppliersController, PurchaseOrdersController],
  providers: [SuppliersService, PurchaseOrdersService, SupplierRoutesService, SupplierTelegramService, AuditLogService],
  // SalesService/RoutesService validate an incoming supplierId the same way
  // PurchaseOrdersService does (findActiveOrThrow) — reuse that one service
  // rather than duplicating the "does this supplier exist" query.
  exports: [SuppliersService],
})
export class PurchasesModule {}
