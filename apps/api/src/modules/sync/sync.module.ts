import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { FieldModule } from '../field/field.module';
import { FinanceModule } from '../finance/finance.module';
import { SalesModule } from '../sales/sales.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [SalesModule, FinanceModule, FieldModule, CustomersModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
