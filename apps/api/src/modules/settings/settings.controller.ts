import { Body, Controller, Get, Patch } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermission('settings.read')
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.get(user.companyId);
  }

  @Patch()
  @RequirePermission('settings.update')
  update(@Body() dto: UpdateSettingsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.settings.update(user.companyId, dto, user);
  }
}
