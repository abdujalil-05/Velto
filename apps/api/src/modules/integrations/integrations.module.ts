import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { StorageModule } from '../../common/storage/storage.module';
import { EXPORT_1C_QUEUE } from './export-1c/export-1c.constants';
import { Export1cController } from './export-1c/export-1c.controller';
import { Export1cProcessor } from './export-1c/export-1c.processor';
import { Export1cService } from './export-1c/export-1c.service';

@Module({
  imports: [BullModule.registerQueue({ name: EXPORT_1C_QUEUE }), StorageModule],
  controllers: [Export1cController],
  providers: [Export1cService, Export1cProcessor],
})
export class IntegrationsModule {}
