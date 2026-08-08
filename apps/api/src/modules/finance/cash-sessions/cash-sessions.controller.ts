import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { CloseCashSessionDto } from '../dto/close-cash-session.dto';
import { ListCashSessionsQueryDto } from '../dto/list-cash-sessions.query';
import { OpenCashSessionDto } from '../dto/open-cash-session.dto';
import { CashSessionsService } from './cash-sessions.service';

@Controller('cash-sessions')
export class CashSessionsController {
  constructor(private readonly cashSessions: CashSessionsService) {}

  @Get()
  @RequirePermission('cash.read')
  list(@Query() query: ListCashSessionsQueryDto) {
    return this.cashSessions.list(query);
  }

  @Get('current')
  @RequirePermission('cash.read')
  current(@CurrentUser() user: AuthenticatedUser) {
    return this.cashSessions.current(user);
  }

  @Post('open')
  @RequirePermission('cash.open')
  open(@Body() dto: OpenCashSessionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashSessions.open(dto, user);
  }

  @Post(':id/close')
  @RequirePermission('cash.close')
  close(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseCashSessionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cashSessions.close(id, dto, user);
  }
}
