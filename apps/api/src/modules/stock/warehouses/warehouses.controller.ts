import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { WarehousesService } from './warehouses.service';

@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Get()
  @RequirePermission('stock.read')
  list() {
    return this.warehouses.list();
  }

  // Used by clients that just need "the" warehouse (single-warehouse-per-
  // company model) without a create/manage UI — provisions it on first use.
  @Get('default')
  @RequirePermission('stock.read')
  getDefault() {
    return this.warehouses.getOrCreateDefault();
  }

  // Setting up a warehouse is company configuration (9.2 onboarding: kompaniya
  // → ombor → ...), not routine warehouse-floor work — gated like `settings.*`.
  @Post()
  @RequirePermission('settings.update')
  create(@Body() dto: CreateWarehouseDto, @CurrentUser() user: AuthenticatedUser) {
    return this.warehouses.create(dto, user);
  }

  // Deactivate rather than hard-delete: existing stock movements/orders
  // reference the warehouse by id (FK RESTRICT), so it must keep existing —
  // this just hides it from pickers and the /stock filter.
  @Delete(':id')
  @RequirePermission('settings.update')
  deactivate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.warehouses.deactivate(id, user);
  }
}
