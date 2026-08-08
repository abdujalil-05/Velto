import { Module } from '@nestjs/common';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { RolesController } from './roles/roles.controller';
import { RolesService } from './roles/roles.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController, RolesController],
  providers: [UsersService, RolesService, AuditLogService],
})
export class UsersModule {}
