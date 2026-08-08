import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { WarehousesController } from './warehouses/warehouses.controller';
import { WarehousesService } from './warehouses/warehouses.service';

@Module({
  controllers: [WarehousesController, StockController],
  providers: [WarehousesService, StockService, AuditLogService],
  exports: [StockService],
})
export class StockModule {}
