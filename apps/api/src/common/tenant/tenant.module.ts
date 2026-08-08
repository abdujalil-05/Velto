import { Global, Module } from '@nestjs/common';
import { TenantPrismaService } from './tenant-prisma.service';

@Global()
@Module({
  providers: [TenantPrismaService],
  exports: [TenantPrismaService],
})
export class TenantModule {}
