import { Module } from '@nestjs/common';
import { StorageModule } from '../common/storage/storage.module';
import { HealthController } from './health.controller';

@Module({
  imports: [StorageModule],
  controllers: [HealthController],
})
export class HealthModule {}
