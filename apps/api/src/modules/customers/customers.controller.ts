import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { BlockCustomerDto } from './dto/block-customer.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ListCustomersQueryDto } from './dto/list-customers.query';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomersService } from './customers.service';

@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission('customers.read')
  list(@Query() query: ListCustomersQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.list(query, user);
  }

  @Get(':id')
  @RequirePermission('customers.read')
  getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.getById(id, user);
  }

  @Get(':id/balance')
  @RequirePermission('customers.read')
  getBalance(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.getCustomerBalance(id, user);
  }

  @Post()
  @RequirePermission('customers.create')
  create(@Body() dto: CreateCustomerDto, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission('customers.update')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.update(id, dto, user);
  }

  @Post(':id/block')
  @RequirePermission('customers.update')
  block(@Param('id', ParseUUIDPipe) id: string, @Body() dto: BlockCustomerDto, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.block(id, dto, user);
  }

  @Post(':id/unblock')
  @RequirePermission('customers.update')
  unblock(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.unblock(id, user);
  }
}
