import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { ListSuppliersQueryDto } from './dto/list-suppliers.query';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { SuppliersService } from './suppliers.service';

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

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
}
