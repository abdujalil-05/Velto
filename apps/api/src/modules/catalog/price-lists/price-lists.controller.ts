import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { PaginationQueryDto } from '../../../common/pagination/pagination.dto';
import { CreatePriceListDto } from './dto/create-price-list.dto';
import { UpsertPriceListItemsDto } from './dto/upsert-price-list-items.dto';
import { PriceListsService } from './price-lists.service';

@Controller('price-lists')
export class PriceListsController {
  constructor(private readonly priceLists: PriceListsService) {}

  @Get()
  @RequirePermission('catalog.read')
  list(@Query() query: PaginationQueryDto) {
    return this.priceLists.list(query);
  }

  @Post()
  @RequirePermission('catalog.create')
  create(@Body() dto: CreatePriceListDto, @CurrentUser() user: AuthenticatedUser) {
    return this.priceLists.create(dto, user);
  }

  @Get(':id/items')
  @RequirePermission('catalog.read')
  listItems(@Param('id', ParseUUIDPipe) id: string, @Query() query: PaginationQueryDto) {
    return this.priceLists.listItems(id, query);
  }

  @Put(':id/items')
  @RequirePermission('catalog.update')
  upsertItems(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertPriceListItemsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.priceLists.upsertItems(id, dto, user);
  }
}
