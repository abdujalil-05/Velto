import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { Idempotent } from '../../../common/idempotency/idempotent.decorator';
import { AckExportDto } from './dto/ack-export.dto';
import { CreateExportDto } from './dto/create-export.dto';
import { toExportJobView } from './dto/export-job.view';
import { ListExportsQueryDto } from './dto/list-exports.query';
import { Export1cAckService } from './export-1c-ack.service';
import { Export1cDownloadService } from './export-1c-download.service';
import { Export1cLimitsService } from './export-1c-limits.service';
import { Export1cService } from './export-1c.service';

const PER_MINUTE = 60_000;

@Controller('export/1c')
export class Export1cController {
  constructor(
    private readonly export1c: Export1cService,
    private readonly ack: Export1cAckService,
    private readonly downloads: Export1cDownloadService,
    private readonly limits: Export1cLimitsService,
  ) {}

  @Post()
  @RequirePermission('integrations.export1c')
  @Throttle({ default: { limit: 5, ttl: PER_MINUTE } })
  @Idempotent()
  async create(@Body() dto: CreateExportDto, @CurrentUser() user: AuthenticatedUser) {
    await this.limits.assertCanCreate();
    return toExportJobView(await this.export1c.create(dto, user));
  }

  @Get()
  @RequirePermission('integrations.export1c')
  async list(@Query() query: ListExportsQueryDto) {
    const page = await this.export1c.list(query);
    return { ...page, data: page.data.map(toExportJobView) };
  }

  // Polled by the accountant's UI until GENERATED/FAILED (11.1); the file is fetched via /download.
  @Get(':id')
  @RequirePermission('integrations.export1c')
  async getById(@Param('id', ParseUUIDPipe) id: string) {
    return toExportJobView(await this.export1c.getById(id));
  }

  @Get(':id/download')
  @RequirePermission('integrations.export1c')
  @Throttle({ default: { limit: 30, ttl: PER_MINUTE } })
  async download(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) res: Response) {
    const file = await this.downloads.download(id, user);
    res.setHeader('X-Content-SHA256', file.fileHash);
    return new StreamableFile(file.stream, { type: file.mimeType, disposition: `attachment; filename="${file.fileName}"`, length: file.size });
  }

  @Post(':id/ack')
  @RequirePermission('integrations.ack1c')
  @Idempotent()
  async acknowledge(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AckExportDto, @CurrentUser() user: AuthenticatedUser) {
    return toExportJobView(await this.ack.acknowledge(id, dto, user));
  }
}
