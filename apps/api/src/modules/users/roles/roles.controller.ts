import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { RolesService } from './roles.service';

@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermission('roles.read')
  list() {
    return this.roles.list();
  }
}
