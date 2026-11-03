import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import { AssignCourierDto } from './dto/assign-courier.dto';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { DeliverOrderDto } from './dto/deliver-order.dto';
import { ListOrdersQueryDto } from './dto/list-orders.query';
import { ReturnToWarehouseDto } from './dto/return-to-warehouse.dto';
import { SalesService } from './sales.service';

@Controller('orders')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get()
  @RequirePermission('orders.read')
  list(@Query() query: ListOrdersQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sales.list(query, user);
  }

  /** Courier picker for dispatch — declared before ':id' so the static path wins. Minimal fields; no users.read needed. */
  @Get('assignable-couriers')
  @RequirePermission('orders.assignCourier')
  assignableCouriers() {
    return this.sales.listAssignableCouriers();
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
  @Idempotent()
  @RequirePermission('orders.update')
  confirm(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sales.confirm(id, user);
  }

  // 'orders.deliver', not 'orders.update': COURIER holds only the former, so
  // it can mark its own deliveries done without also being able to confirm,
  // cancel or delete anyone's orders (the rest of this controller).
  @Post(':id/deliver')
  @Idempotent()
  @RequirePermission('orders.deliver')
  // Optional body (F2.4): `lines[{lineId, deliveredQty}]` for a partial goods
  // issue; empty body = full delivery (courier Mini App path, unchanged).
  deliver(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliverOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sales.deliver(id, user, dto);
  }

  /** Hand-over to a courier: CONFIRMED → SHIPPED or reassign on SHIPPED; never touches stock — see SalesService.assignCourier(). */
  @Post(':id/assign-courier')
  @Idempotent()
  @RequirePermission('orders.assignCourier')
  assignCourier(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignCourierDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sales.assignCourier(id, dto, user);
  }

  /** Goods back from the courier: SHIPPED → CONFIRMED, courier detached, reservation kept — see SalesService.returnToWarehouse(). */
  @Post(':id/return-to-warehouse')
  @Idempotent()
  @RequirePermission('orders.assignCourier')
  returnToWarehouse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReturnToWarehouseDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sales.returnToWarehouse(id, dto, user);
  }

  @Post(':id/close')
  @RequirePermission('orders.update')
  close(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sales.close(id, user);
  }

  @Post(':id/cancel')
  @Idempotent()
  @RequirePermission('orders.cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelOrderDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sales.cancel(id, dto, user);
  }

  // No dedicated 'orders.delete' permission in the RBAC catalog
  // (packages/database/src/rbac-catalog.ts) — reuses 'orders.update'.
  @Delete(':id')
  @RequirePermission('orders.update')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sales.remove(id, user);
  }
}
