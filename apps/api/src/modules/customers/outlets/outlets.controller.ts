import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { OutletInputDto } from './dto/outlet-input.dto';
import { UpdateOutletDto } from './dto/update-outlet.dto';
import { OutletsService } from './outlets.service';

@Controller('customers/:customerId/outlets')
export class OutletsController {
  constructor(private readonly outlets: OutletsService) {}

  @Get()
  @RequirePermission('customers.read')
  list(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.outlets.list(customerId);
  }

  @Post()
  @RequirePermission('customers.update')
  create(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: OutletInputDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.outlets.create(customerId, dto, user);
  }

  @Patch(':outletId')
  @RequirePermission('customers.update')
  update(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('outletId', ParseUUIDPipe) outletId: string,
    @Body() dto: UpdateOutletDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.outlets.update(customerId, outletId, dto, user);
  }

  @Delete(':outletId')
  @RequirePermission('customers.update')
  remove(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('outletId', ParseUUIDPipe) outletId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.outlets.remove(customerId, outletId, user);
  }
}
