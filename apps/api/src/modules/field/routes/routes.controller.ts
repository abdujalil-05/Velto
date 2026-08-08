import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { CreateRouteDto } from './dto/create-route.dto';
import { ListRoutesQueryDto } from './dto/list-routes.query';
import { UpdateRouteDto } from './dto/update-route.dto';
import { RoutesService } from './routes.service';

@Controller('routes')
export class RoutesController {
  constructor(private readonly routes: RoutesService) {}

  @Get()
  @RequirePermission('routes.read')
  list(@Query() query: ListRoutesQueryDto) {
    return this.routes.list(query);
  }

  @Get(':id')
  @RequirePermission('routes.read')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.routes.getById(id);
  }

  @Post()
  @RequirePermission('routes.create')
  create(@Body() dto: CreateRouteDto, @CurrentUser() user: AuthenticatedUser) {
    return this.routes.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission('routes.update')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRouteDto, @CurrentUser() user: AuthenticatedUser) {
    return this.routes.update(id, dto, user);
  }

  @Post(':id/finish')
  @RequirePermission('routes.update')
  finish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.routes.finish(id, user);
  }
}
