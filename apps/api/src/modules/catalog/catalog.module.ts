import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { StorageModule } from '../../common/storage/storage.module';
import { CategoriesController } from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';
import { PriceListsController } from './price-lists/price-lists.controller';
import { PriceListsService } from './price-lists/price-lists.service';
import { ProductsController } from './products/products.controller';
import { ProductsService } from './products/products.service';

@Module({
  imports: [StorageModule],
  controllers: [CategoriesController, ProductsController, PriceListsController],
  providers: [CategoriesService, ProductsService, PriceListsService, AuditLogService],
})
export class CatalogModule {}
