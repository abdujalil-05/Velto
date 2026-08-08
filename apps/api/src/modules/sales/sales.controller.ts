import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { ListOrdersQueryDto } from './dto/list-orders.query';
import { SalesService } from './sales.service';

@Controller('orders')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get()
  @RequirePermission('orders.read')
  list(@Query() query: ListOrdersQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sales.list(query, user);
  }

  @Get(':id')
  @RequirePermission('orders.read')
  getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sales.getById(id, user);
  }

  @Post()
  @RequirePermission('orders.create')
  create(@Body() dto: CreateOrderDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sales.create(dto, user);
  }

  @Post(':id/confirm')
  @RequirePermission('orders.update')
  confirm(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sales.confirm(id, user);
  }

  @Post(':id/deliver')
  @RequirePermission('orders.update')
  deliver(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sales.deliver(id, user);
  }

  @Post(':id/close')
  @RequirePermission('orders.update')
  close(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sales.close(id, user);
  }

  @Post(':id/cancel')
  @RequirePermission('orders.cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelOrderDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sales.cancel(id, dto, user);
  }
}
