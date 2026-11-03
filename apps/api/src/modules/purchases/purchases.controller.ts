import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CreateGoodsReceiptDto, ListGoodsReceiptsQueryDto } from './dto/goods-receipt.dto';
import { CreatePurchaseOrderDto, ListPurchaseOrdersQueryDto } from './dto/purchase-order.dto';
import { CreateSupplierDto, ListSuppliersQueryDto, UpdateSupplierDto } from './dto/supplier.dto';
import { PurchasesService } from './purchases.service';

/** M08 Xarid (5.1, ADR-011): suppliers, purchase orders, goods receipts. */
@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get('suppliers')
  @RequirePermission('purchases.read')
  listSuppliers(@Query() query: ListSuppliersQueryDto) {
    return this.purchases.listSuppliers(query);
  }

  @Get('suppliers/:id')
  @RequirePermission('purchases.read')
  getSupplier(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchases.getSupplier(id);
  }

  @Post('suppliers')
  @RequirePermission('purchases.create')
  createSupplier(@Body() dto: CreateSupplierDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchases.createSupplier(dto, user);
  }

  @Patch('suppliers/:id')
  @RequirePermission('purchases.create')
  updateSupplier(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.purchases.updateSupplier(id, dto, user);
  }

  @Post('suppliers/:id/deactivate')
  @RequirePermission('purchases.create')
  deactivateSupplier(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.purchases.deactivateSupplier(id, user);
  }

  @Get('orders')
  @RequirePermission('purchases.read')
  listOrders(@Query() query: ListPurchaseOrdersQueryDto) {
    return this.purchases.listPurchaseOrders(query);
  }

  @Get('orders/:id')
  @RequirePermission('purchases.read')
  getOrder(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchases.getPurchaseOrder(id);
  }

  @Post('orders')
  @RequirePermission('purchases.create')
  createOrder(@Body() dto: CreatePurchaseOrderDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchases.createPurchaseOrder(dto, user);
  }

  @Post('orders/:id/order')
  @RequirePermission('purchases.create')
  markOrdered(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.purchases.markOrdered(id, user);
  }

  @Post('orders/:id/cancel')
  @RequirePermission('purchases.create')
  cancelOrder(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.purchases.cancelPurchaseOrder(id, user);
  }

  @Get('receipts')
  @RequirePermission('purchases.read')
  listReceipts(@Query() query: ListGoodsReceiptsQueryDto) {
    return this.purchases.listGoodsReceipts(query);
  }

  @Post('receipts')
  @RequirePermission('purchases.receive')
  createReceipt(@Body() dto: CreateGoodsReceiptDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchases.createGoodsReceipt(dto, user);
  }
}
