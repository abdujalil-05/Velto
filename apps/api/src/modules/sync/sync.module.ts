import { Module } from '@nestjs/common';
import { FieldModule } from '../field/field.module';
import { FinanceModule } from '../finance/finance.module';
import { SalesModule } from '../sales/sales.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [SalesModule, FinanceModule, FieldModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
