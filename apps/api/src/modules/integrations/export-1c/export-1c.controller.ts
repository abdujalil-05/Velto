import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { CreateExportDto } from './dto/create-export.dto';
import { ListExportsQueryDto } from './dto/list-exports.query';
import { Export1cService } from './export-1c.service';

@Controller('export/1c')
export class Export1cController {
  constructor(private readonly export1c: Export1cService) {}

  @Post()
  @RequirePermission('integrations.export1c')
  create(@Body() dto: CreateExportDto, @CurrentUser() user: AuthenticatedUser) {
    return this.export1c.create(dto, user);
  }

  @Get()
  @RequirePermission('integrations.export1c')
  list(@Query() query: ListExportsQueryDto) {
    return this.export1c.list(query);
  }

  // Polled by the accountant's UI until status is DONE/FAILED (11.1), then
  // fileUrl is the download link.
  @Get(':id')
  @RequirePermission('integrations.export1c')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.export1c.getById(id);
  }
}
