import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { ListStockQueryDto } from './dto/list-stock.query';
import { ReceiveStockDto } from './dto/receive-stock.dto';
import { StockService } from './stock.service';

@Controller('stock')
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Get()
  @RequirePermission('stock.read')
  list(@Query() query: ListStockQueryDto) {
    return this.stock.list(query);
  }

  @Post('receive')
  @RequirePermission('stock.receive')
  receive(@Body() dto: ReceiveStockDto, @CurrentUser() user: AuthenticatedUser) {
    return this.stock.receive(dto, user);
  }

  @Post('adjust')
  @RequirePermission('stock.adjust')
  adjust(@Body() dto: AdjustStockDto, @CurrentUser() user: AuthenticatedUser) {
    return this.stock.adjust(dto, user);
  }
}
