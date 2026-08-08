import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { ListPurchaseOrdersQueryDto } from './dto/list-purchase-orders.query';
import { ReceivePurchaseOrderDto } from './dto/receive-purchase-order.dto';
import { PurchaseOrdersService } from './purchase-orders.service';

@Controller('purchases')
export class PurchaseOrdersController {
  constructor(private readonly purchaseOrders: PurchaseOrdersService) {}

  @Get()
  @RequirePermission('purchases.read')
  list(@Query() query: ListPurchaseOrdersQueryDto) {
    return this.purchaseOrders.list(query);
  }

  @Get(':id')
  @RequirePermission('purchases.read')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchaseOrders.getById(id);
  }

  @Post()
  @RequirePermission('purchases.create')
  create(@Body() dto: CreatePurchaseOrderDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchaseOrders.create(dto, user);
  }

  @Post(':id/submit')
  @RequirePermission('purchases.update')
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.purchaseOrders.submit(id, user);
  }

  @Post(':id/receive')
  @RequirePermission('purchases.receive')
  receive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceivePurchaseOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.purchaseOrders.receive(id, dto, user);
  }

  @Post(':id/cancel')
  @RequirePermission('purchases.update')
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.purchaseOrders.cancel(id, user);
  }
}
