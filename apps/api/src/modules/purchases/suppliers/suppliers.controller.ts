import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';
import { PurchaseOrdersService } from '../purchase-orders/purchase-orders.service';
import { CreateSupplierRouteStopDto } from '../supplier-routes/dto/create-supplier-route-stop.dto';
import { CreateSupplierRouteDto } from '../supplier-routes/dto/create-supplier-route.dto';
import { SupplierRoutesService } from '../supplier-routes/supplier-routes.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { ListSuppliersQueryDto } from './dto/list-suppliers.query';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { SuppliersService } from './suppliers.service';

@Controller('suppliers')
export class SuppliersController {
  constructor(
    private readonly suppliers: SuppliersService,
    private readonly supplierRoutes: SupplierRoutesService,
    private readonly purchaseOrders: PurchaseOrdersService,
  ) {}

  @Get()
  @RequirePermission('purchases.read')
  list(@Query() query: ListSuppliersQueryDto) {
    return this.suppliers.list(query);
  }

  @Get(':id')
  @RequirePermission('purchases.read')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.getById(id);
  }

  @Post()
  @RequirePermission('purchases.create')
  create(@Body() dto: CreateSupplierDto, @CurrentUser() user: AuthenticatedUser) {
    return this.suppliers.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission('purchases.update')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierDto, @CurrentUser() user: AuthenticatedUser) {
    return this.suppliers.update(id, dto, user);
  }

  @Delete(':id')
  @RequirePermission('purchases.update')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.suppliers.remove(id, user);
  }

  @Get(':id/orders')
  @RequirePermission('purchases.read')
  async listOrders(@Param('id', ParseUUIDPipe) id: string, @Query() query: PaginationQueryDto) {
    await this.suppliers.getById(id); // 404s if the supplier doesn't exist/is soft-deleted, same as the other :id/... routes below
    return this.purchaseOrders.list({ ...query, supplierId: id });
  }

  @Get(':id/routes')
  @RequirePermission('purchases.read')
  listRoutes(@Param('id', ParseUUIDPipe) id: string, @Query() query: PaginationQueryDto) {
    return this.supplierRoutes.list(id, query);
  }

  @Post(':id/routes')
  @RequirePermission('purchases.create')
  createRoute(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSupplierRouteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.supplierRoutes.create(id, dto, user);
  }

  @Post(':id/routes/:routeId/stops')
  @RequirePermission('purchases.create')
  addRouteStop(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('routeId', ParseUUIDPipe) routeId: string,
    @Body() dto: CreateSupplierRouteStopDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.supplierRoutes.addStop(id, routeId, dto, user);
  }
}
