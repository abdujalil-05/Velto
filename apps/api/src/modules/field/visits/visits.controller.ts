import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { CreateVisitDto } from './dto/create-visit.dto';
import { ListVisitsQueryDto } from './dto/list-visits.query';
import { VisitsService } from './visits.service';

@Controller('visits')
export class VisitsController {
  constructor(private readonly visits: VisitsService) {}

  @Get()
  @RequirePermission('field.read')
  list(@Query() query: ListVisitsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.visits.list(query, user);
  }

  @Get(':id')
  @RequirePermission('field.read')
  getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.visits.getById(id, user);
  }

  @Post()
  @RequirePermission('field.create')
  create(@Body() dto: CreateVisitDto, @CurrentUser() user: AuthenticatedUser) {
    return this.visits.create(dto, user);
  }
}
